import "../src/server/load-env";
import { env } from "../src/server/env";

// Step 04 as code: creates the monitors that score live chat turns in
// Langfuse. Safe to re-run: evaluators and rules are matched by name and only
// missing ones are created.
//
//   npm run monitors:setup
//
// - Code evaluators (no model needed): ALL-CAPS frustration and "where is
//   that?" follow-ups.
// - LLM judges (User Disagreement, Out of scope request): run inside Langfuse
//   and need an LLM connection in the project (Settings → LLM Connections).
//   They are skipped with a hint until one exists.
//
// Every rule targets the root chat-turn observation and skips experiment runs.

const baseUrl = env.langfuseBaseUrl.replace(/\/+$/, "");
const auth = `Basic ${Buffer.from(`${env.langfusePublicKey}:${env.langfuseSecretKey}`).toString("base64")}`;

async function api<T>(method: "GET" | "POST", pathname: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${pathname} → ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

type Evaluator = { id: string; name: string; type: string };
type Rule = { id: string; name: string; enabled: boolean };

const CHAT_TURN_FILTER = [
  { type: "stringOptions", column: "name", operator: "any of", value: ["dad-it-support-chat-turn"] },
  { type: "stringOptions", column: "environment", operator: "none of", value: ["sdk-experiment"] }
];

// Shared by both code evaluators: the user messages from the turn input.
const READ_USER_MESSAGES = `
function lastUserMessages(input: any): string[] {
  let value = input;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return [value]; }
  }
  if (Array.isArray(value)) value = value[0];
  const messages = Array.isArray(value?.messages) ? value.messages : [];
  return messages
    .filter((message: any) => message?.role === "user" && typeof message?.content === "string")
    .map((message: any) => message.content as string);
}
`;

const CODE_EVALUATORS = [
  {
    name: "Detect User Frustration (ALL CAPS)",
    description: "Step 04: flags turns where Dad's last message is mostly capital letters.",
    sourceCode: `${READ_USER_MESSAGES}
function evaluate({ observation }: any) {
  const users = lastUserMessages(observation.input);
  const text = users[users.length - 1] ?? "";
  const letters = text.replace(/[^a-z]/gi, "");
  const upper = text.replace(/[^A-Z]/g, "");
  const ratio = letters.length ? upper.length / letters.length : 0;
  const flagged = letters.length >= 8 && ratio > 0.7;
  return {
    scores: [
      {
        name: "user_all_caps_signal",
        value: flagged,
        dataType: "BOOLEAN",
        comment: flagged
          ? \`Last user message is \${Math.round(ratio * 100)}% capital letters.\`
          : "No all-caps shouting in the last user message.",
        metadata: { ratio, letters: letters.length }
      }
    ]
  };
}
`
  },
  {
    name: "Detect follow-up questions",
    description: 'Flags turns where Dad reacts to the previous answer ("where is that?") instead of asking something new.',
    sourceCode: `${READ_USER_MESSAGES}
const FOLLOW_UP = /\\b(where (is|do|can|are)|can'?t find|cannot find|don'?t see|not (there|showing)|didn'?t work|doesn'?t work|isn'?t there|what do you mean|i'?m lost|still (can'?t|don'?t|not))\\b|^(sorry|and|okay|ok|but)\\b/i;

function evaluate({ observation }: any) {
  const users = lastUserMessages(observation.input);
  const text = (users[users.length - 1] ?? "").trim();
  const isFollowUp = users.length >= 2 && text.length <= 160 && FOLLOW_UP.test(text);
  return {
    scores: [
      {
        name: "asks_follow_up",
        value: isFollowUp,
        dataType: "BOOLEAN",
        comment: isFollowUp
          ? "Dad reacted to the previous answer instead of asking something new (e.g. \\"where is that?\\")."
          : users.length < 2
            ? "First message of the conversation."
            : "Last user message is a new request, not a follow-up."
      }
    ]
  };
}
`
  }
];

// Both judges read the turn input: the whole conversation and Dad's last message.
const JUDGE_VARIABLES = [
  { variable: "conversation_history", source: "input", jsonPath: "$.messages" },
  { variable: "last_user_message", source: "input", jsonPath: "$.messages[-1:].content" }
];

const LLM_JUDGES = [
  {
    name: "User Disagreement",
    description: "Step 04: flags turns where Dad pushes back on the previous answer.",
    prompt: `You review a support chat between an older user ("Dad") and an iPhone help assistant.

Conversation so far:
{{conversation_history}}

Dad's latest message:
{{last_user_message}}

Does Dad's latest message disagree with, reject, or report a problem with the assistant's previous answer (for example "that menu isn't there", "that didn't work", "no, that's wrong")? A new question, thanks, or a neutral follow-up is not disagreement. If there is no previous assistant answer, it is not disagreement.`,
    outputDefinition: {
      dataType: "BOOLEAN",
      scoreValueInstructions: "true if Dad disagrees with or reports a problem with the previous answer, otherwise false.",
      scoreReasoningInstructions: "One sentence quoting the part of Dad's message that decided it."
    }
  },
  {
    name: "Out of scope request",
    description: "Step 04: flags requests that are not about Dad's own phone.",
    prompt: `You review a message sent to an iPhone help assistant for an older user ("Dad").
The assistant only helps with Dad's own phone: its settings, apps and accessories.

Conversation so far:
{{conversation_history}}

Dad's latest message:
{{last_user_message}}

Is Dad's latest message asking for something outside that scope (for example booking travel, moving money, filing taxes, general knowledge)?`,
    outputDefinition: {
      dataType: "BOOLEAN",
      scoreValueInstructions: "true if the request is outside phone help, otherwise false.",
      scoreReasoningInstructions: "One sentence naming what Dad asked for."
    }
  }
];

async function ensureEvaluator(existing: Evaluator[], name: string, body: Record<string, unknown>) {
  const found = existing.find((evaluator) => evaluator.name === name);
  if (found) {
    console.log(`  ✓ evaluator exists: ${name}`);
    return found.id;
  }
  const created = await api<Evaluator>("POST", "/api/public/v2/evaluators", { name, ...body });
  console.log(`  + created evaluator: ${name}`);
  return created.id;
}

async function ensureRule(existing: Rule[], name: string, evaluatorIds: string[]) {
  if (existing.some((rule) => rule.name === name)) {
    console.log(`  ✓ rule exists: ${name}`);
    return;
  }
  await api("POST", "/api/public/v2/evaluation-rules", {
    name,
    enabled: true,
    filter: CHAT_TURN_FILTER,
    evaluatorAssignments: evaluatorIds.map((evaluatorId) => ({ evaluatorId, variableMapping: null }))
  });
  console.log(`  + created rule: ${name}`);
}

async function main() {
  if (!env.langfusePublicKey || !env.langfuseSecretKey) throw new Error("Langfuse credentials are required.");

  const [evaluators, rules, connections] = await Promise.all([
    api<{ data: Evaluator[] }>("GET", "/api/public/v2/evaluators?limit=100"),
    api<{ data: Rule[] }>("GET", "/api/public/v2/evaluation-rules?limit=100"),
    api<{ data: { provider: string; adapter: string }[] }>("GET", "/api/public/llm-connections")
  ]);

  console.log("Code monitors");
  const codeIds: string[] = [];
  for (const evaluator of CODE_EVALUATORS) {
    codeIds.push(
      await ensureEvaluator(evaluators.data, evaluator.name, {
        type: "code",
        description: evaluator.description,
        sourceCode: evaluator.sourceCode,
        sourceCodeLanguage: "TYPESCRIPT"
      })
    );
  }
  await ensureRule(rules.data, "Chat turns: code monitors (ALL CAPS, follow-ups)", codeIds);

  console.log("LLM-judge monitors");
  const connection = connections.data.find((entry) => entry.adapter === "openai") ?? connections.data[0];
  if (!connection) {
    console.log(
      "  ! skipped: this Langfuse project has no LLM connection.\n" +
        "    Add one under Settings → LLM Connections in Langfuse, then run npm run monitors:setup again."
    );
    return;
  }
  const judgeIds: string[] = [];
  for (const judge of LLM_JUDGES) {
    judgeIds.push(
      await ensureEvaluator(evaluators.data, judge.name, {
        type: "llm_as_judge",
        description: judge.description,
        prompt: judge.prompt,
        outputDefinition: judge.outputDefinition,
        variableMapping: JUDGE_VARIABLES,
        modelConfig: { provider: connection.provider, model: process.env.JUDGE_MODEL || env.openaiModel }
      })
    );
  }
  await ensureRule(rules.data, "Chat turns: LLM judges (disagreement, out of scope)", judgeIds);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
