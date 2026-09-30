import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProfileField, ProfileUpdate, SupportContext, SupportProfileResponse } from "../shared/types";
import { DEFAULT_SUPPORT_CONTEXT } from "./support-data";

// Dad's profile = the base context in support-data.ts + an append-only log of
// updates learned in chat. The log lives in the repo-level .data/ folder
// (gitignored), so clearing it always restores the base profile.
//
// Memory is off unless the web server turns it on. Dataset and experiment
// scripts reuse the same agent code and must keep running against the fixed
// base profile so experiment runs stay comparable.

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.resolve(currentDir, "../../.data/support-profile.json");

export const PROFILE_FIELDS: ProfileField[] = [
  "phoneModel",
  "iosVersion",
  "phoneFinish",
  "phonePurchased",
  "addApp",
  "removeApp",
  "note"
];

// When Dad gets a new phone, the old phone's details no longer apply.
const PHONE_DEPENDENT_FIELDS: ProfileField[] = ["iosVersion", "phoneFinish", "phonePurchased"];

const MAX_VALUE_LENGTH = 120;

let memoryEnabled = false;
let persist = true;
let updates: ProfileUpdate[] = [];

// persist: false keeps the log in memory only. The memory experiment
// (scripts/run-memory-dataset.ts) uses it so test items never touch Dad's
// saved profile.
// loadFromStore: start from the saved log even when not persisting (dry runs).
export function enableSupportMemory(options: { persist?: boolean; loadFromStore?: boolean } = {}) {
  memoryEnabled = true;
  persist = options.persist ?? true;
  updates = persist || options.loadFromStore ? readStore() : [];
}

export function isSupportMemoryEnabled() {
  return memoryEnabled;
}

function readStore(): ProfileUpdate[] {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8")) as { updates?: ProfileUpdate[] };
    return Array.isArray(parsed.updates) ? parsed.updates : [];
  } catch (error) {
    console.warn(`Ignoring unreadable profile store at ${STORE_PATH}:`, error);
    return [];
  }
}

function writeStore(next: ProfileUpdate[]) {
  if (!persist) {
    updates = next;
    return;
  }
  mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tempPath = `${STORE_PATH}.tmp`;
  writeFileSync(tempPath, JSON.stringify({ updates: next }, null, 2));
  renameSync(tempPath, STORE_PATH);
  updates = next;
}

function cloneBase(): SupportContext {
  return structuredClone(DEFAULT_SUPPORT_CONTEXT);
}

function readField(context: SupportContext, field: ProfileField): string | null {
  switch (field) {
    case "phoneModel":
      return context.phone.model;
    case "iosVersion":
      return context.phone.os;
    case "phoneFinish":
      return context.phone.finish;
    case "phonePurchased":
      return context.phone.purchased;
    default:
      return null;
  }
}

function applyUpdate(context: SupportContext, update: ProfileUpdate) {
  const value = update.value;
  switch (update.field) {
    case "phoneModel":
      context.phone.model = value;
      break;
    case "iosVersion":
      context.phone.os = value;
      break;
    case "phoneFinish":
      context.phone.finish = value;
      break;
    case "phonePurchased":
      context.phone.purchased = value;
      break;
    case "addApp":
      if (value && !context.notableApps.some((app) => app.toLowerCase() === value.toLowerCase())) {
        context.notableApps.push(value);
      }
      break;
    case "removeApp":
      context.notableApps = context.notableApps.filter((app) => app.toLowerCase() !== value?.toLowerCase());
      break;
    case "note":
      if (value) context.notes.push(value);
      break;
  }
}

function buildContext(log: ProfileUpdate[]): SupportContext {
  const context = cloneBase();
  for (const update of log) applyUpdate(context, update);
  context.devices = context.phone.model ? [context.phone.model] : [];
  return context;
}

export function getSupportContext(): SupportContext {
  return buildContext(memoryEnabled ? updates : []);
}

export function getSupportProfile(): SupportProfileResponse {
  return {
    context: getSupportContext(),
    base: buildContext([]),
    updates: memoryEnabled ? [...updates] : [],
    memoryEnabled
  };
}

export function resetSupportProfile() {
  if (!memoryEnabled) return;
  writeStore([]);
}

// ── Evidence check ────────────────────────────────────────────────────
// The agent must quote Dad. An update is only accepted when most of the
// quoted words appear in one of Dad's own messages, so the model cannot save
// a fact it inferred or invented.

function words(text: string) {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}

export function isGroundedInMessages(evidence: string, userMessages: string[]) {
  const evidenceWords = words(evidence);
  if (evidenceWords.length === 0) return false;
  return userMessages.some((message) => {
    const messageWords = new Set(words(message));
    const hits = evidenceWords.filter((word) => messageWords.has(word)).length;
    return hits / evidenceWords.length >= 0.7;
  });
}

// ── Applying changes from the agent ───────────────────────────────────

export type ProfileChange = { field: ProfileField; value: string };

export type ApplyResult =
  | { ok: true; applied: ProfileUpdate[]; skipped: { field: ProfileField; reason: string }[]; context: SupportContext }
  | { ok: false; error: string };

export function applyProfileChanges(
  changes: ProfileChange[],
  meta: { evidence: string; userMessages: string[]; sessionId: string | null; traceId: string | null }
): ApplyResult {
  if (!memoryEnabled) {
    return { ok: false, error: "Profile memory is turned off in this environment. Nothing was saved." };
  }
  if (!isGroundedInMessages(meta.evidence, meta.userMessages)) {
    return {
      ok: false,
      error: "The evidence must quote Dad's own words from this conversation. Nothing was saved."
    };
  }

  const current = getSupportContext();
  const applied: ProfileUpdate[] = [];
  const skipped: { field: ProfileField; reason: string }[] = [];
  const at = new Date().toISOString();
  const changedFields = new Set(changes.map((change) => change.field));

  const record = (field: ProfileField, value: string | null, previousValue: string | null, source: ProfileUpdate["source"], evidence: string) => {
    applied.push({ id: randomUUID(), at, field, value, previousValue, evidence, source, sessionId: meta.sessionId, traceId: meta.traceId });
  };

  for (const change of changes) {
    const value = change.value.trim().slice(0, MAX_VALUE_LENGTH);
    if (!value) {
      skipped.push({ field: change.field, reason: "empty value" });
      continue;
    }

    if (change.field === "addApp" || change.field === "removeApp") {
      const has = current.notableApps.some((app) => app.toLowerCase() === value.toLowerCase());
      if ((change.field === "addApp") === has) {
        skipped.push({ field: change.field, reason: change.field === "addApp" ? "already listed" : "not listed" });
        continue;
      }
      record(change.field, value, null, "chat", meta.evidence);
      continue;
    }

    if (change.field === "note") {
      if (current.notes.some((note) => note.toLowerCase() === value.toLowerCase())) {
        skipped.push({ field: change.field, reason: "already noted" });
        continue;
      }
      record("note", value, null, "chat", meta.evidence);
      continue;
    }

    const previous = readField(current, change.field);
    if (previous?.toLowerCase() === value.toLowerCase()) {
      skipped.push({ field: change.field, reason: "unchanged" });
      continue;
    }
    record(change.field, value, previous, "chat", meta.evidence);

    if (change.field === "phoneModel") {
      for (const dependent of PHONE_DEPENDENT_FIELDS) {
        const dependentValue = readField(current, dependent);
        if (changedFields.has(dependent) || dependentValue === null) continue;
        record(dependent, null, dependentValue, "cleared", `Cleared because the phone changed from ${previous ?? "unknown"} to ${value}.`);
      }
    }
  }

  if (applied.length > 0) writeStore([...updates, ...applied]);
  return { ok: true, applied, skipped, context: getSupportContext() };
}
