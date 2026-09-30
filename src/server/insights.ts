import OpenAI from "openai";
import { LangfuseClient } from "@langfuse/client";
import { observeOpenAI } from "@langfuse/openai";
import { observe, propagateAttributes } from "@langfuse/tracing";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DataRange,
  InsightCategory,
  InsightRecommendation,
  InsightsResponse,
  InsightStarter,
  InsightTopic,
  RequestCategory,
  RequestKind
} from "../shared/types";
import { RANGE_MS, TURN_OBSERVATION_NAME, isLiveTraffic, listObservations, readTurnMessages } from "./analytics";
import { env } from "./env";
import { DEFAULT_SUPPORT_CONTEXT, GUIDE_LIBRARY } from "./support-data";

// Request insights: an LLM labels every message Dad sends (kind, category,
// topic, covering help guide), results are cached per trace in
// .data/request-insights.json, and the aggregates below turn them into
// "what to ship next" recommendations with plain counting rules.
//
// The classifier's own model calls are traced under the "request-insights"
// trace name, which the Data page metrics exclude.

const TAXONOMY_VERSION = 1;
const MAX_TURNS = 2000;
const MAX_CLASSIFY_PER_RUN = 300;
const BATCH_SIZE = 20;
const BATCH_CONCURRENCY = 3;
const CACHE_TTL_MS = 30_000;

const CATEGORY_LABELS: Record<RequestCategory, string> = {
  diagnosis: "Diagnosis & troubleshooting",
  os_settings: "iOS & settings",
  apps: "Apps",
  connectivity: "Connectivity",
  hardware: "Hardware & battery",
  accounts_privacy: "Accounts, iCloud & privacy",
  out_of_scope: "Out of scope"
};

const CATEGORIES = Object.keys(CATEGORY_LABELS) as RequestCategory[];
const KINDS: RequestKind[] = ["new_request", "follow_up", "profile_info", "other"];

type Classification = {
  kind: RequestKind;
  category: RequestCategory;
  topic: string;
  app: string | null;
  guideId: string | null;
};

type CachedTurn = Classification & {
  question: string;
  sessionId: string | null;
  at: string;
  // Set once the labels were written to Langfuse as scores.
  scoresSentAt?: string;
};

type InsightsStore = {
  taxonomyVersion: number;
  turns: Record<string, CachedTurn>;
  // Starter prompts and help guides, keyed by their text.
  reference: Record<string, Classification>;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.resolve(currentDir, "../../.data/request-insights.json");

function readStore(): InsightsStore {
  const empty: InsightsStore = { taxonomyVersion: TAXONOMY_VERSION, turns: {}, reference: {} };
  if (!existsSync(STORE_PATH)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8")) as InsightsStore;
    // A taxonomy change makes old labels incomparable, so start over.
    return parsed.taxonomyVersion === TAXONOMY_VERSION ? parsed : empty;
  } catch {
    return empty;
  }
}

function writeStore(store: InsightsStore) {
  mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tempPath = `${STORE_PATH}.tmp`;
  writeFileSync(tempPath, JSON.stringify(store, null, 2));
  renameSync(tempPath, STORE_PATH);
}

// ── Classifier ─────────────────────────────────────────────────────────

type ClassifyItem = {
  id: string;
  message: string;
  previousUserMessage: string | null;
  previousAgentReply: string | null;
};

const CLASSIFIER_PROMPT = `You label messages sent to the Dad IT Support Agent, an iPhone help chat used by an older person ("Dad").
For every item return:

kind:
- new_request: Dad asks for help with a task or problem (even if he also mentions a fact about his phone).
- follow_up: Dad reacts to the previous answer ("where is that?", "I can't find it", "it didn't work") instead of asking something new.
- profile_info: Dad only tells a fact about himself or his phone, with no question.
- other: greetings, thanks, or anything else.

category (the main need):
- diagnosis: something is broken, slow, or not working and needs troubleshooting.
- os_settings: iOS system features and the Settings app (display, sounds, notifications, accessibility, Focus, alarms, Face ID setup, updates).
- apps: doing something inside a specific app, including Apple apps (WhatsApp, Maps, Mail, Safari, Photos, Camera, Messages, Phone, Calendar).
- connectivity: Wi-Fi, Bluetooth, cellular data, pairing AirPods or other accessories.
- hardware: battery, charging, buttons, screen, storage space, cases, or getting a new device.
- accounts_privacy: Apple ID, iCloud, backups, passwords, location sharing, privacy, scams, safety features.
- out_of_scope: not about Dad's phone at all.

topic: a 2-6 word task label in sentence case, e.g. "Turn on dark mode", "Pin a WhatsApp chat", "Back up iPhone to iCloud".
- Describe the underlying task, not Dad's wording. The same task must always get the same label.
- If an EXISTING TOPIC names the same task, reuse it exactly.
- For follow_up, use the topic of the request Dad is following up on (use the previous messages).
- For profile_info use "Update phone details". For other use "Small talk".

app: the app involved (e.g. "WhatsApp"), or null if none.

guideId: the id of the HELP GUIDE that directly covers the task, or "none". Only pick a guide when its steps would answer the request.`;

function responseSchema(guideIds: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "category", "topic", "app", "guideId"],
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: KINDS },
            category: { type: "string", enum: CATEGORIES },
            topic: { type: "string" },
            app: { type: ["string", "null"] },
            guideId: { type: "string", enum: [...guideIds, "none"] }
          }
        }
      }
    }
  };
}

function normalizeTopic(topic: string) {
  const trimmed = topic.trim().replace(/\s+/g, " ").replace(/[.?!]+$/, "");
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : "Unlabeled";
}

// "discord" → "Discord"; mixed-case names like "WhatsApp" are kept as given.
function normalizeApp(app: string | null) {
  const trimmed = app?.trim();
  if (!trimmed) return null;
  return trimmed === trimmed.toLowerCase() ? trimmed.replace(/\b\w/g, (letter) => letter.toUpperCase()) : trimmed;
}

async function classifyBatch(openai: OpenAI, items: ClassifyItem[], existingTopics: string[]) {
  const guideIds = GUIDE_LIBRARY.map((guide) => guide.id);
  const payload = {
    help_guides: GUIDE_LIBRARY.map((guide) => ({ id: guide.id, title: guide.title, summary: guide.summary })),
    existing_topics: existingTopics,
    items
  };
  const completion = await openai.chat.completions.create({
    model: env.insightsModel,
    messages: [
      { role: "system", content: CLASSIFIER_PROMPT },
      { role: "user", content: JSON.stringify(payload) }
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "request_labels", strict: true, schema: responseSchema(guideIds) }
    }
  });
  const content = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content) as { items?: (Omit<Classification, "guideId"> & { id: string; guideId: string })[] };
  const results = new Map<string, Classification>();
  for (const item of parsed.items ?? []) {
    results.set(item.id, {
      kind: KINDS.includes(item.kind) ? item.kind : "other",
      category: CATEGORIES.includes(item.category) ? item.category : "out_of_scope",
      topic: normalizeTopic(item.topic),
      app: normalizeApp(item.app),
      guideId: item.guideId && item.guideId !== "none" && guideIds.includes(item.guideId) ? item.guideId : null
    });
  }
  return results;
}

async function classifyAll(items: ClassifyItem[], existingTopics: string[]) {
  const results = new Map<string, Classification>();
  if (items.length === 0) return results;

  const run = observe(
    async (input: { count: number }) =>
      propagateAttributes({ traceName: "request-insights", tags: ["request-insights"] }, async () => {
        const openai = observeOpenAI(new OpenAI({ apiKey: env.openaiApiKey }), { generationName: "classify-requests" });
        const batches: ClassifyItem[][] = [];
        for (let index = 0; index < items.length; index += BATCH_SIZE) batches.push(items.slice(index, index + BATCH_SIZE));
        const topics = [...existingTopics];
        for (let index = 0; index < batches.length; index += BATCH_CONCURRENCY) {
          const settled = await Promise.allSettled(
            batches.slice(index, index + BATCH_CONCURRENCY).map((batch) => classifyBatch(openai, batch, topics.slice(0, 150)))
          );
          for (const outcome of settled) {
            if (outcome.status === "rejected") {
              console.warn("Request classification batch failed:", outcome.reason);
              continue;
            }
            for (const [id, classification] of outcome.value) {
              results.set(id, classification);
              if (!topics.includes(classification.topic)) topics.push(classification.topic);
            }
          }
        }
        return { requested: input.count, classified: results.size };
      }),
    { name: "request-insights", asType: "chain" }
  );

  await run({ count: items.length });
  return results;
}

// ── Pipeline ───────────────────────────────────────────────────────────

let classifying: Promise<unknown> = Promise.resolve();
const cache = new Map<DataRange, { at: number; data: InsightsResponse }>();

function starterKey(question: string) {
  return `starter:${question}`;
}
function guideKey(guideId: string) {
  const guide = GUIDE_LIBRARY.find((entry) => entry.id === guideId);
  return `guide:${guideId}:${guide?.title ?? ""}`;
}

type TurnRow = {
  traceId: string;
  observationId: string;
  environment: string | null;
  at: string;
  sessionId: string | null;
  item: ClassifyItem;
};

async function loadTurns(from: string, to: string): Promise<TurnRow[]> {
  const { items } = await listObservations({ type: "AGENT", name: TURN_OBSERVATION_NAME }, "core,basic,io", from, to, MAX_TURNS);
  const rows: TurnRow[] = [];
  for (const turn of items.filter(isLiveTraffic)) {
    const messages = readTurnMessages(turn.input);
    const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
    if (lastUserIndex < 0) continue;
    const previousUser = messages.slice(0, lastUserIndex).filter((message) => message.role === "user").at(-1);
    const previousAgent = messages.slice(0, lastUserIndex).filter((message) => message.role === "assistant").at(-1);
    rows.push({
      traceId: turn.traceId,
      observationId: turn.id,
      environment: turn.environment ?? null,
      at: turn.startTime,
      sessionId: turn.sessionId ?? null,
      item: {
        id: turn.traceId,
        message: messages[lastUserIndex].content.slice(0, 600),
        previousUserMessage: previousUser?.content.slice(0, 300) ?? null,
        // A turn that only continues the greeting has no real previous answer.
        previousAgentReply: previousUser ? previousAgent?.content.slice(0, 300) ?? null : null
      }
    });
  }
  return rows;
}

async function ensureClassified(rows: TurnRow[]) {
  const store = readStore();
  const pendingTurns = rows.filter((row) => !store.turns[row.traceId]);
  const toClassify = pendingTurns.slice(0, MAX_CLASSIFY_PER_RUN);

  const referenceItems: ClassifyItem[] = [];
  for (const question of DEFAULT_SUPPORT_CONTEXT.starterQuestions) {
    const key = starterKey(question);
    if (!store.reference[key]) referenceItems.push({ id: key, message: question, previousUserMessage: null, previousAgentReply: null });
  }
  for (const guide of GUIDE_LIBRARY) {
    const key = guideKey(guide.id);
    if (!store.reference[key]) {
      referenceItems.push({ id: key, message: `${guide.title}. ${guide.summary}`, previousUserMessage: null, previousAgentReply: null });
    }
  }

  if (toClassify.length > 0 || referenceItems.length > 0) {
    const existingTopics = topTopics(store);
    const results = await classifyAll([...referenceItems, ...toClassify.map((row) => row.item)], existingTopics);
    for (const row of toClassify) {
      const classification = results.get(row.traceId);
      if (classification) {
        store.turns[row.traceId] = { ...classification, question: row.item.message, sessionId: row.sessionId, at: row.at };
      }
    }
    for (const item of referenceItems) {
      const classification = results.get(item.id);
      if (classification) store.reference[item.id] = classification;
    }
    writeStore(store);
  }

  await sendLabelScores(rows, store);

  const pending = rows.filter((row) => !store.turns[row.traceId]).length;
  return { store, pending };
}

// ── Labels as Langfuse scores ─────────────────────────────────────────
// Each labeled turn gets categorical request_category and request_kind
// scores on its chat-turn observation, so traces can be filtered by
// category in the Langfuse UI. Score ids are derived from the trace, so a
// resend updates the score instead of duplicating it.

const langfuse = new LangfuseClient();

async function sendLabelScores(rows: TurnRow[], store: InsightsStore) {
  const unsent = rows.filter((row) => store.turns[row.traceId] && !store.turns[row.traceId].scoresSentAt);
  if (unsent.length === 0) return;
  for (const row of unsent) {
    const label = store.turns[row.traceId];
    const shared = {
      traceId: row.traceId,
      observationId: row.observationId,
      dataType: "CATEGORICAL" as const,
      ...(row.environment ? { environment: row.environment } : {}),
      metadata: { source: "request-insights", topic: label.topic, app: label.app, guideId: label.guideId }
    };
    langfuse.score.create({ ...shared, id: `${row.traceId}-request_category`, name: "request_category", value: label.category, comment: label.topic });
    langfuse.score.create({ ...shared, id: `${row.traceId}-request_kind`, name: "request_kind", value: label.kind });
  }
  try {
    await langfuse.score.flush();
    const sentAt = new Date().toISOString();
    for (const row of unsent) store.turns[row.traceId].scoresSentAt = sentAt;
    writeStore(store);
  } catch (error) {
    // Left unsent, so the next page load retries (e.g. after a rate limit).
    console.warn("Could not write request-insight scores:", error);
  }
}

function topTopics(store: InsightsStore) {
  const counts = new Map<string, number>();
  for (const turn of Object.values(store.turns)) counts.set(turn.topic, (counts.get(turn.topic) ?? 0) + 1);
  for (const reference of Object.values(store.reference)) counts.set(reference.topic, (counts.get(reference.topic) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([topic]) => topic).slice(0, 150);
}

// ── Aggregation & recommendations ──────────────────────────────────────

function buildInsights(range: DataRange, rows: TurnRow[], store: InsightsStore, pending: number, toMs: number): InsightsResponse {
  const guideTitle = (guideId: string | null) => GUIDE_LIBRARY.find((guide) => guide.id === guideId)?.title ?? null;
  const emergingSince = toMs - RANGE_MS[range] / 3;

  const starterTopics = new Map<string, Classification>();
  for (const question of DEFAULT_SUPPORT_CONTEXT.starterQuestions) {
    const classification = store.reference[starterKey(question)];
    if (classification) starterTopics.set(question, classification);
  }
  const starterTopicSet = new Set([...starterTopics.values()].map((classification) => classification.topic.toLowerCase()));

  // Chronological, so a session's first request decides ties.
  const labeled = [...rows]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((row) => ({ row, label: store.turns[row.traceId] }))
    .filter((entry): entry is { row: TurnRow; label: CachedTurn } => Boolean(entry.label));

  // Topics
  const topics = new Map<string, InsightTopic & { sessionIds: Set<string> }>();
  for (const { row, label } of labeled) {
    if (label.kind !== "new_request" && label.kind !== "follow_up") continue;
    const key = label.topic.toLowerCase();
    const entry =
      topics.get(key) ??
      {
        topic: label.topic,
        category: label.category,
        app: label.app,
        requests: 0,
        sessions: 0,
        followUps: 0,
        guideId: label.guideId,
        guideTitle: guideTitle(label.guideId),
        isStarter: starterTopicSet.has(key),
        firstSeen: row.at,
        lastSeen: row.at,
        isEmerging: false,
        examples: [],
        sessionIds: new Set<string>()
      };
    if (label.kind === "new_request") {
      entry.requests += 1;
      if (entry.examples.length < 3 && !entry.examples.includes(label.question)) entry.examples.push(label.question);
      // Prefer the labels from real requests over follow-ups.
      entry.category = label.category;
      entry.guideId = entry.guideId ?? label.guideId;
      entry.guideTitle = guideTitle(entry.guideId);
      entry.app = entry.app ?? label.app;
    } else {
      entry.followUps += 1;
    }
    entry.sessionIds.add(row.sessionId ?? row.traceId);
    if (row.at < entry.firstSeen) entry.firstSeen = row.at;
    if (row.at > entry.lastSeen) entry.lastSeen = row.at;
    topics.set(key, entry);
  }
  const topicList: InsightTopic[] = [...topics.values()]
    .filter((entry) => entry.requests > 0)
    .map(({ sessionIds, ...entry }) => ({
      ...entry,
      sessions: sessionIds.size,
      isEmerging: new Date(entry.firstSeen).getTime() >= emergingSince && rows.length >= 10
    }))
    .sort((a, b) => b.sessions - a.sessions || b.requests - a.requests || b.lastSeen.localeCompare(a.lastSeen));

  // Sessions: dominant category among each session's new requests.
  const sessionCategories = new Map<string, Map<RequestCategory, number>>();
  for (const { row, label } of labeled) {
    if (label.kind !== "new_request") continue;
    const sessionId = row.sessionId ?? row.traceId;
    const counts = sessionCategories.get(sessionId) ?? new Map<RequestCategory, number>();
    counts.set(label.category, (counts.get(label.category) ?? 0) + 1);
    sessionCategories.set(sessionId, counts);
  }
  const sessionsByCategory = new Map<RequestCategory, number>();
  for (const counts of sessionCategories.values()) {
    const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    sessionsByCategory.set(dominant, (sessionsByCategory.get(dominant) ?? 0) + 1);
  }

  const guideCategories = GUIDE_LIBRARY.map((guide) => store.reference[guideKey(guide.id)]?.category).filter(Boolean);
  const categories: InsightCategory[] = CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    sessions: sessionsByCategory.get(category) ?? 0,
    requests: labeled.filter(({ label }) => label.kind === "new_request" && label.category === category).length,
    followUps: labeled.filter(({ label }) => label.kind === "follow_up" && label.category === category).length,
    guides: guideCategories.filter((entry) => entry === category).length,
    starters: [...starterTopics.values()].filter((classification) => classification.category === category).length
  })).sort((a, b) => b.sessions - a.sessions || b.requests - a.requests);

  // Starter prompt usage: a request "uses" a starter when it is the same
  // topic, or both are answered by the same help guide.
  const starters: InsightStarter[] = DEFAULT_SUPPORT_CONTEXT.starterQuestions.map((question) => {
    const classification = starterTopics.get(question);
    const matches = labeled.filter(
      ({ label }) =>
        label.kind === "new_request" &&
        classification &&
        (label.topic.toLowerCase() === classification.topic.toLowerCase() ||
          (label.guideId !== null && label.guideId === classification.guideId))
    );
    return {
      question,
      topic: classification?.topic ?? "Not classified yet",
      category: classification?.category ?? "out_of_scope",
      asked: matches.length,
      sessions: new Set(matches.map(({ row }) => row.sessionId ?? row.traceId)).size,
      lastAsked: matches.map(({ row }) => row.at).sort().at(-1) ?? null
    };
  });

  const newRequests = labeled.filter(({ label }) => label.kind === "new_request").length;
  const followUps = labeled.filter(({ label }) => label.kind === "follow_up").length;
  const totalSessions = sessionCategories.size;
  const recommendations = recommend({ topicList, categories, starters, totalSessions, newRequests });

  return {
    range,
    generatedAt: new Date().toISOString(),
    model: env.insightsModel,
    classifiedTurns: labeled.length,
    pendingTurns: pending,
    newRequests,
    followUps,
    sessions: totalSessions,
    categories,
    topics: topicList.slice(0, 100),
    starters,
    recommendations
  };
}

function quote(text: string) {
  return `“${text.length > 80 ? `${text.slice(0, 79)}…` : text}”`;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function recommend(input: {
  topicList: InsightTopic[];
  categories: InsightCategory[];
  starters: InsightStarter[];
  totalSessions: number;
  newRequests: number;
}): InsightRecommendation[] {
  const { topicList, categories, starters, totalSessions, newRequests } = input;
  const recommendations: InsightRecommendation[] = [];
  // Scale the bar with traffic: 1 session on tiny data, up to 3 on real traffic.
  const minSessions = Math.max(1, Math.min(3, Math.round(totalSessions * 0.05)));
  const inScope = topicList.filter((topic) => topic.category !== "out_of_scope");

  // 1. Categories with real demand but no help guides.
  for (const category of categories) {
    if (category.category === "out_of_scope" || newRequests === 0) continue;
    const share = category.requests / newRequests;
    if (share >= 0.2 && category.guides === 0 && category.sessions >= minSessions) {
      recommendations.push({
        kind: "expand_category",
        title: `Build out ${category.label} help`,
        detail: `${Math.round(share * 100)}% of new requests (${plural(category.sessions, "session")}) are about ${category.label}, but the help library has no guides in this category, so every answer comes from the model alone.`,
        sessions: category.sessions,
        requests: category.requests,
        topic: null,
        category: category.category
      });
    }
  }

  // 2. Recurring requests the help library does not cover.
  for (const topic of inScope.filter((entry) => !entry.guideId && entry.sessions >= minSessions).slice(0, 4)) {
    recommendations.push({
      kind: "add_guide",
      title: `Add a help guide: ${topic.topic}`,
      detail: `Asked in ${plural(topic.sessions, "session")} (${plural(topic.requests, "request")}), e.g. ${quote(topic.examples[0] ?? topic.topic)}. No guide covers it, so Specs answers without confirmed steps${
        topic.followUps > 0 ? `, and Dad needed ${plural(topic.followUps, "follow-up")} to get there` : ""
      }.`,
      sessions: topic.sessions,
      requests: topic.requests,
      topic: topic.topic,
      category: topic.category
    });
  }

  // 3. Answers that keep triggering "where is that?" follow-ups.
  // Uncovered topics already carry their follow-ups in the add_guide detail.
  const suggestedGuides = new Set(recommendations.filter((entry) => entry.kind === "add_guide").map((entry) => entry.topic));
  for (const topic of inScope.filter(
    (entry) =>
      !suggestedGuides.has(entry.topic) &&
      entry.followUps >= minSessions &&
      entry.followUps / Math.max(1, entry.requests) >= 0.5
  ).slice(0, 3)) {
    recommendations.push({
      kind: "improve_answers",
      title: `Clearer steps for: ${topic.topic}`,
      detail: `Dad needed ${plural(topic.followUps, "follow-up")} after ${plural(topic.requests, "answer")} on this. ${
        topic.guideTitle ? `The “${topic.guideTitle}” guide` : "The answer"
      } should say exactly where to tap and what he will see.`,
      sessions: topic.sessions,
      requests: topic.requests,
      topic: topic.topic,
      category: topic.category
    });
  }

  // 4. Starter prompts nobody asks about, with the demand to replace them.
  if (newRequests >= 5) {
    const replacements = inScope.filter((topic) => !topic.isStarter);
    starters
      .filter((starter) => starter.asked === 0)
      .forEach((starter, index) => {
        const replacement = replacements[index];
        if (!replacement) return;
        recommendations.push({
          kind: "replace_starter",
          title: `Replace starter prompt ${quote(starter.question)}`,
          detail: `Nobody asked about this in the selected range. ${quote(replacement.examples[0] ?? replacement.topic)} came up in ${plural(replacement.sessions, "session")}.`,
          sessions: replacement.sessions,
          requests: replacement.requests,
          topic: replacement.topic,
          category: replacement.category
        });
      });
  }

  const order: InsightRecommendation["kind"][] = ["expand_category", "add_guide", "improve_answers", "replace_starter"];
  return recommendations
    .sort((a, b) => b.sessions - a.sessions || order.indexOf(a.kind) - order.indexOf(b.kind))
    .slice(0, 8);
}

export async function getInsightsResponse(range: DataRange, refresh = false): Promise<InsightsResponse> {
  const cached = cache.get(range);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const toMs = Date.now();
  const from = new Date(toMs - RANGE_MS[range]).toISOString();
  const to = new Date(toMs).toISOString();
  const rows = await loadTurns(from, to);

  // Serialize classification so concurrent page loads never label a turn twice.
  const job = classifying.then(() => ensureClassified(rows));
  classifying = job.catch(() => undefined);
  const { store, pending } = await job;

  const data = buildInsights(range, rows, store, pending, toMs);
  cache.set(range, { at: Date.now(), data });
  return data;
}
