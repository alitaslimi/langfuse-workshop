import OpenAI from "openai";
import { getActiveTraceId, observe } from "@langfuse/tracing";
import type { ProfileField, ProfileUpdate } from "../shared/types";
import { searchGuides } from "./support-data";
import {
  PROFILE_FIELDS,
  applyProfileChanges,
  getSupportContext,
  isSupportMemoryEnabled,
  type ProfileChange
} from "./support-profile";

type ToolResult = Record<string, unknown>;

// Per-turn information the tools need but the model does not supply.
export type ToolRunContext = {
  sessionId: string | null;
  userMessages: string[];
  // Filled by update_support_context so the chat response can tell the UI.
  profileUpdates: ProfileUpdate[];
};

const BASE_TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_support_context",
      description: "Look up Dad's known device setup so the answer stays grounded.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_help_library",
      description: "Search the local help library for practical step-by-step device instructions.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Dad's practical device question."
          }
        },
        required: ["question"],
        additionalProperties: false
      }
    }
  }
];

export const UPDATE_SUPPORT_CONTEXT_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "update_support_context",
    description:
      "Save a lasting fact Dad just told you about his own phone or setup, so this and future chats use it. " +
      "Call it only when Dad clearly states the fact himself (for example \"I have an iPhone 17 now\", \"I updated to iOS 26\", " +
      "\"I use Instagram now\"). Do not call it for guesses, questions, hypotheticals, or other people's devices, and do not " +
      "save facts you inferred. When Dad stops using an app, save removeApp for it (and addApp for any replacement); use note " +
      "only for facts no other field can hold. If the phone model changes, the old iOS version, color/storage and purchase date are cleared " +
      "unless you also save new ones. After saving, briefly confirm the change to Dad and keep helping with the updated details.",
    parameters: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              field: {
                type: "string",
                enum: PROFILE_FIELDS,
                description:
                  "phoneModel (e.g. \"iPhone 17\"), iosVersion (e.g. \"iOS 26\"), phoneFinish (color and storage), " +
                  "phonePurchased (month and year), addApp / removeApp (one app name), note (a short fact about Dad's setup or preferences)."
              },
              value: { type: "string", description: "The new value, as short as possible." }
            },
            required: ["field", "value"],
            additionalProperties: false
          }
        },
        evidence: {
          type: "string",
          description: "Dad's exact words that state the fact, quoted from his message."
        }
      },
      required: ["changes", "evidence"],
      additionalProperties: false
    }
  }
};

// The update tool is only offered when profile memory is on (the web
// server), so dataset and experiment runs see the same tools as before.
export function getToolDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return isSupportMemoryEnabled() ? [...BASE_TOOL_DEFINITIONS, UPDATE_SUPPORT_CONTEXT_TOOL] : BASE_TOOL_DEFINITIONS;
}

const getSupportContextTool = observe(
  async () => {
    const context = getSupportContext();

    return {
      ok: true,
      context: {
        id: context.id,
        label: context.label,
        devices: context.devices,
        // null means not known yet: ask Dad if it matters, never assume.
        phone: context.phone,
        deviceSummary: context.deviceSummary,
        responseStyle: context.responseStyle,
        scopeHighlights: context.scopeHighlights,
        notableApps: context.notableApps,
        notes: context.notes
      }
    };
  },
  {
    name: "get_support_context",
    asType: "tool"
  }
);

const searchHelpLibraryTool = observe(
  async (input: { question: string }) => {
    const guides = searchGuides(input.question);

    return {
      ok: true,
      results: guides.map((guide) => ({
        id: guide.id,
        title: guide.title,
        summary: guide.summary,
        steps: guide.steps,
        caution: guide.caution ?? null
      }))
    };
  },
  {
    name: "search_help_library",
    asType: "tool"
  }
);

export function parseChanges(input: unknown): ProfileChange[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 4) return null;
  const changes: ProfileChange[] = [];
  for (const item of input) {
    const field = (item as { field?: unknown })?.field;
    const value = (item as { value?: unknown })?.value;
    if (!PROFILE_FIELDS.includes(field as ProfileField) || typeof value !== "string") return null;
    changes.push({ field: field as ProfileField, value });
  }
  return changes;
}

// Built per call so the run context stays out of the traced tool input.
const updateSupportContextTool = (run: ToolRunContext) =>
  observe(
  async (input: { changes: unknown; evidence: string }) => {
    const changes = parseChanges(input.changes);
    if (!changes) {
      return { ok: false, error: "changes must be 1-4 items, each with a known field and a string value." };
    }
    const result = applyProfileChanges(changes, {
      evidence: input.evidence,
      userMessages: run.userMessages,
      sessionId: run.sessionId,
      traceId: getActiveTraceId() ?? null
    });
    if (!result.ok) return result;
    run.profileUpdates.push(...result.applied);
    return {
      ok: true,
      saved: result.applied.map((update) => ({
        field: update.field,
        value: update.value,
        previousValue: update.previousValue,
        source: update.source
      })),
      skipped: result.skipped,
      phone: result.context.phone,
      notableApps: result.context.notableApps,
      notes: result.context.notes
    };
  },
  {
    name: "update_support_context",
    asType: "tool"
  }
  );

export async function executeTool(name: string, input: Record<string, unknown>, run: ToolRunContext): Promise<ToolResult> {
  switch (name) {
    case "get_support_context":
      return getSupportContextTool();

    case "search_help_library":
      return searchHelpLibraryTool({
        question: String(input.question ?? "")
      });

    case "update_support_context":
      if (!isSupportMemoryEnabled()) break;
      return updateSupportContextTool(run)({ changes: input.changes, evidence: String(input.evidence ?? "") });
  }

  return {
    ok: false,
    error: `Unsupported tool: ${name}`
  };
}
