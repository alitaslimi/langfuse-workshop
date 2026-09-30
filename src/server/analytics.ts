import { LangfuseClient } from "@langfuse/client";
import type {
  ChatMessage,
  DataFlaggedMessage,
  DataRange,
  DataResponse,
  DataScoreSummary,
  DataSessionRow,
  SignalKind
} from "../shared/types";
import { env } from "./env";

// Name of the root agent observation written by support-agent.ts. Each one is
// a single chat turn: its input carries the whole message array for the session.
export const TURN_OBSERVATION_NAME = "dad-it-support-chat-turn";

// Experiment runs (scripts/run-dataset.ts) replay the same agent, so their
// traces contain chat-turn observations too. They are not Dad's traffic.
export const EXPERIMENT_ENVIRONMENT = "sdk-experiment";

export function isLiveTraffic(observation: { environment?: string | null }) {
  return observation.environment !== EXPERIMENT_ENVIRONMENT;
}

// Every usage number on the Data page is computed here from raw observations
// (Observations API). The Metrics API is only used for scores: on smaller
// Langfuse plans it allows ~100 requests a day, which a dashboard burns fast.
const MAX_TURNS = 2000;
const MAX_GENERATIONS = 5000;
const MAX_TOOLS = 5000;
const CACHE_TTL_MS = 30_000;
const SCORES_CACHE_TTL_MS = 10 * 60_000;

// Never retry: a 429 carries a Retry-After of up to a day, which the SDK
// would otherwise wait out, hanging the request.
const REQUEST_OPTIONS = { maxRetries: 0, timeoutInSeconds: 30 };

export const RANGE_MS: Record<DataRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
};

const langfuse = new LangfuseClient();
const cache = new Map<DataRange, { at: number; data: DataResponse }>();

export function isDataRange(value: unknown): value is DataRange {
  return value === "24h" || value === "7d" || value === "30d";
}

type MetricRow = Record<string, string | number | null>;

type MetricsQuery = {
  view: "observations" | "scores-numeric" | "scores-categorical";
  dimensions: { field: string }[];
  metrics: { measure: string; aggregation: string }[];
  filters?: { column: string; operator: string; value: unknown; type: string }[];
  timeDimension?: { granularity: string };
  orderBy?: { field: string; direction: "asc" | "desc" }[];
  config?: { row_limit: number };
};

async function queryMetrics(query: MetricsQuery, from: string, to: string): Promise<MetricRow[]> {
  const response = await langfuse.api.metrics.metrics(
    { query: JSON.stringify({ filters: [], ...query, fromTimestamp: from, toTimestamp: to }) },
    REQUEST_OPTIONS
  );
  return (response.data ?? []) as MetricRow[];
}

function num(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type ObservationRecord = {
  id: string;
  traceId: string;
  projectId?: string;
  startTime: string;
  type: string;
  name?: string | null;
  input?: unknown;
  sessionId?: string | null;
  userId?: string | null;
  environment?: string | null;
  totalCost?: number | null;
  // Seconds in the Observations API (the Metrics API reports milliseconds).
  latency?: number | null;
  model?: string | null;
  inputUsage?: number | null;
  outputUsage?: number | null;
};

export async function listObservations(
  filter: { type: string; name?: string; environment?: string | string[] },
  fields: string,
  from: string,
  to: string,
  cap: number
): Promise<{ items: ObservationRecord[]; truncated: boolean }> {
  const items: ObservationRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await langfuse.api.observations.getMany(
      {
        ...filter,
        fields,
        fromStartTime: from,
        toStartTime: to,
        limit: Math.min(1000, cap - items.length),
        cursor
      },
      REQUEST_OPTIONS
    );
    items.push(...((page.data ?? []) as unknown as ObservationRecord[]));
    cursor = (page.meta as { cursor?: string | null } | undefined)?.cursor ?? undefined;
  } while (cursor && items.length < cap);
  return { items, truncated: Boolean(cursor) };
}

// The agent observation's input is the ChatRequest passed to
// runSupportConversation, stored as a JSON string. Older SDK versions record
// the argument list instead, so accept both shapes.
export function readTurnMessages(input: unknown): ChatMessage[] {
  let value: unknown = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) value = value[0];
  const messages = (value as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) ? (messages as ChatMessage[]) : [];
}

// Heuristic conversation signals — the same ideas as the step-04 monitoring
// evaluators (user disagreement, all-caps frustration), plus a check for Dad
// correcting the fixed support context ("I have an iPhone 17 now").
const DISAGREEMENT =
  /\b(can'?t|cannot|couldn'?t) (find|see|get)\b|\b(doesn'?t|didn'?t|isn'?t|won'?t|not) (work|working|there|showing|help)|\bthat'?s (wrong|not (it|right))|\bstill (not|doesn'?t|can'?t|nothing)|\bnothing happen|\bwrong\b|\bmoved\b/i;
const CONTEXT_CORRECTION =
  /\b(i have|i'?ve got|i got|i use|i'?m (on|using)|my phone is|switched to|upgraded( to)?|new)\b.{0,40}\b(iphone|android|samsung|galaxy|pixel|ios|phone|ipad)\b/i;

function detectSignals(message: string): SignalKind[] {
  const kinds: SignalKind[] = [];
  if (DISAGREEMENT.test(message)) kinds.push("disagreement");
  const letters = message.replace(/[^a-z]/gi, "");
  const upper = message.replace(/[^A-Z]/g, "");
  if ((letters.length >= 8 && upper.length / letters.length > 0.7) || /!{2,}/.test(message)) {
    kinds.push("frustration");
  }
  if (CONTEXT_CORRECTION.test(message)) kinds.push("context-correction");
  return kinds;
}

function depthBucket(turns: number) {
  return turns >= 5 ? "5+" : String(turns);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

// UTC buckets: "2026-09-30" for days, "2026-09-30T08:00:00Z" for hours.
function bucketOf(iso: string, granularity: "hour" | "day") {
  return granularity === "day" ? iso.slice(0, 10) : `${iso.slice(0, 13)}:00:00Z`;
}

function allBuckets(from: Date, to: Date, granularity: "hour" | "day") {
  const step = granularity === "day" ? 86_400_000 : 3_600_000;
  const start = new Date(from);
  if (granularity === "day") start.setUTCHours(0, 0, 0, 0);
  else start.setUTCMinutes(0, 0, 0);
  const buckets: string[] = [];
  for (let time = start.getTime(); time <= to.getTime(); time += step) {
    buckets.push(bucketOf(new Date(time).toISOString(), granularity));
  }
  return buckets;
}

// ── Scores (Metrics API) ───────────────────────────────────────────────

type ScoresResult = { scores: DataScoreSummary[]; notice: string | null };
const scoresCache = new Map<DataRange, { at: number; data: ScoresResult }>();

function describeMetricsError(error: unknown) {
  const status = (error as { statusCode?: number }).statusCode;
  if (status === 429) {
    const resetAt = (error as { body?: { details?: { resetAt?: string } } }).body?.details?.resetAt;
    const when = resetAt
      ? new Date(resetAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "later";
    return `Scores are unavailable: the Langfuse Metrics API daily request limit is used up (resets ${when}).`;
  }
  const message = error instanceof Error ? error.message.split("\n")[0] : "Metrics API error";
  return `Scores are unavailable: ${message}.`;
}

async function loadScores(range: DataRange, from: string, to: string): Promise<ScoresResult> {
  const cached = scoresCache.get(range);
  if (cached && Date.now() - cached.at < SCORES_CACHE_TTL_MS) return cached.data;
  let result: ScoresResult;
  try {
    const [numericScores, categoricalScores] = await Promise.all([
      queryMetrics(
        {
          view: "scores-numeric",
          dimensions: [{ field: "name" }],
          metrics: [
            { measure: "count", aggregation: "count" },
            { measure: "value", aggregation: "avg" }
          ]
        },
        from,
        to
      ),
      queryMetrics(
        {
          view: "scores-categorical",
          dimensions: [{ field: "name" }, { field: "stringValue" }],
          metrics: [{ measure: "count", aggregation: "count" }]
        },
        from,
        to
      )
    ]);
    const scores: DataScoreSummary[] = numericScores.map((row) => ({
      name: String(row.name),
      dataType: "NUMERIC",
      count: num(row.count_count),
      average: numOrNull(row.avg_value),
      values: []
    }));
    const categorical = new Map<string, DataScoreSummary>();
    for (const row of categoricalScores) {
      const name = String(row.name);
      const entry = categorical.get(name) ?? { name, dataType: "CATEGORICAL" as const, count: 0, average: null, values: [] };
      entry.count += num(row.count_count);
      entry.values.push({ value: String(row.stringValue), count: num(row.count_count) });
      categorical.set(name, entry);
    }
    scores.push(...categorical.values());
    result = { scores, notice: null };
  } catch (error) {
    result = { scores: [], notice: describeMetricsError(error) };
  }
  // Cache failures too, so a used-up limit is not hit again on every load.
  scoresCache.set(range, { at: Date.now(), data: result });
  return result;
}

// ── Data page ──────────────────────────────────────────────────────────

async function buildDataResponse(range: DataRange): Promise<DataResponse> {
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - RANGE_MS[range]);
  const from = fromDate.toISOString();
  const to = toDate.toISOString();
  const granularity = range === "24h" ? "hour" : "day";

  const [turnList, generationList, toolList, scoresResult] = await Promise.all([
    listObservations({ type: "AGENT", name: TURN_OBSERVATION_NAME }, "core,basic,io", from, to, MAX_TURNS),
    listObservations({ type: "GENERATION" }, "core,basic,usage,model", from, to, MAX_GENERATIONS),
    listObservations({ type: "TOOL" }, "core,basic", from, to, MAX_TOOLS),
    loadScores(range, from, to)
  ]);

  // Only count live chat turns and what ran inside them, so experiment runs
  // and background jobs (e.g. the request-insights classifier) are not
  // counted as Dad's usage.
  const turns = turnList.items.filter(isLiveTraffic);
  const chatTraceIds = new Set(turns.map((turn) => turn.traceId));
  const generations = generationList.items.filter((item) => chatTraceIds.has(item.traceId));
  const tools = toolList.items.filter((item) => chatTraceIds.has(item.traceId));

  // ── Time series ──────────────────────────────────────────────────────
  const turnsByBucket = new Map<string, number>();
  for (const turn of turns) {
    const bucket = bucketOf(turn.startTime, granularity);
    turnsByBucket.set(bucket, (turnsByBucket.get(bucket) ?? 0) + 1);
  }
  const costByBucket = new Map<string, number>();
  for (const generation of generations) {
    const bucket = bucketOf(generation.startTime, granularity);
    costByBucket.set(bucket, (costByBucket.get(bucket) ?? 0) + num(generation.totalCost));
  }
  const turnsOverTime = allBuckets(fromDate, toDate, granularity).map((time) => ({
    time,
    turns: turnsByBucket.get(time) ?? 0,
    cost: costByBucket.get(time) ?? 0
  }));

  // ── Agent steps ──────────────────────────────────────────────────────
  const stepGroups = new Map<string, { type: string; name: string; count: number; latenciesMs: number[] }>();
  for (const item of [...turns, ...generations, ...tools]) {
    const key = `${item.type}|${item.name ?? ""}`;
    const group = stepGroups.get(key) ?? { type: item.type, name: item.name ?? "", count: 0, latenciesMs: [] };
    group.count += 1;
    if (typeof item.latency === "number") group.latenciesMs.push(item.latency * 1000);
    stepGroups.set(key, group);
  }
  const steps = [...stepGroups.values()]
    .map((group) => ({
      type: group.type,
      name: group.name,
      count: group.count,
      p50LatencyMs: percentile(group.latenciesMs, 0.5),
      p95LatencyMs: percentile(group.latenciesMs, 0.95)
    }))
    .sort((a, b) => b.count - a.count);

  // ── Models ───────────────────────────────────────────────────────────
  const modelGroups = new Map<string, DataResponse["models"][number]>();
  for (const generation of generations) {
    const model = generation.model || "unknown";
    const group = modelGroups.get(model) ?? { model, calls: 0, inputTokens: 0, outputTokens: 0, totalCost: 0 };
    group.calls += 1;
    group.inputTokens += num(generation.inputUsage);
    group.outputTokens += num(generation.outputUsage);
    group.totalCost += num(generation.totalCost);
    modelGroups.set(model, group);
  }
  const models = [...modelGroups.values()].sort((a, b) => b.totalCost - a.totalCost);

  // ── Sessions and signals (turn inputs) ───────────────────────────────
  const costBySession = new Map<string, number>();
  for (const generation of generations) {
    if (!generation.sessionId) continue;
    costBySession.set(generation.sessionId, (costBySession.get(generation.sessionId) ?? 0) + num(generation.totalCost));
  }

  const turnsChronological = [...turns].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const sessions = new Map<string, DataSessionRow>();
  const signalCounts = new Map<SignalKind, number>();
  const flagged: DataFlaggedMessage[] = [];
  const users = new Set<string>();
  let projectId: string | null = null;

  for (const turn of turnsChronological) {
    projectId ??= turn.projectId ?? null;
    if (turn.userId) users.add(turn.userId);

    const userMessages = readTurnMessages(turn.input).filter((message) => message.role === "user");
    const question = userMessages.at(-1)?.content?.trim() ?? "";

    const kinds = question ? detectSignals(question) : [];
    for (const kind of kinds) signalCounts.set(kind, (signalCounts.get(kind) ?? 0) + 1);
    if (kinds.length > 0) {
      flagged.push({ time: turn.startTime, sessionId: turn.sessionId ?? null, traceId: turn.traceId, kinds, message: question });
    }

    const sessionKey = turn.sessionId ?? `trace:${turn.traceId}`;
    const session =
      sessions.get(sessionKey) ??
      {
        sessionId: sessionKey,
        userId: turn.userId ?? null,
        firstSeen: turn.startTime,
        lastSeen: turn.startTime,
        turns: 0,
        firstQuestion: question,
        lastQuestion: question,
        totalCost: turn.sessionId ? costBySession.get(turn.sessionId) ?? 0 : 0,
        signals: []
      };
    session.turns += 1;
    session.lastSeen = turn.startTime;
    if (question) session.lastQuestion = question;
    for (const kind of kinds) if (!session.signals.includes(kind)) session.signals.push(kind);
    sessions.set(sessionKey, session);
  }

  const sessionRows = [...sessions.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  const depthCounts = new Map<string, number>();
  for (const session of sessionRows) {
    const bucket = depthBucket(session.turns);
    depthCounts.set(bucket, (depthCounts.get(bucket) ?? 0) + 1);
  }

  const turnLatenciesMs = turns
    .filter((turn) => typeof turn.latency === "number")
    .map((turn) => (turn.latency as number) * 1000);
  const signalOrder: SignalKind[] = ["disagreement", "frustration", "context-correction"];

  return {
    range,
    from,
    to,
    generatedAt: new Date().toISOString(),
    granularity,
    langfuseBaseUrl: env.langfuseBaseUrl.replace(/\/+$/, ""),
    projectId,
    truncated: turnList.truncated || generationList.truncated || toolList.truncated,
    totals: {
      sessions: sessionRows.length,
      turns: turns.length,
      flaggedTurns: flagged.length,
      users: users.size,
      modelCalls: generations.length,
      totalCost: models.reduce((total, row) => total + row.totalCost, 0),
      inputTokens: models.reduce((total, row) => total + row.inputTokens, 0),
      outputTokens: models.reduce((total, row) => total + row.outputTokens, 0),
      p50TurnLatencyMs: percentile(turnLatenciesMs, 0.5),
      p95TurnLatencyMs: percentile(turnLatenciesMs, 0.95),
      avgTurnsPerSession: sessionRows.length ? turns.length / sessionRows.length : null
    },
    turnsOverTime,
    steps,
    models,
    sessionDepth: ["1", "2", "3", "4", "5+"].map((bucket) => ({ bucket, sessions: depthCounts.get(bucket) ?? 0 })),
    signals: signalOrder.map((kind) => ({ kind, count: signalCounts.get(kind) ?? 0 })),
    flagged: flagged.reverse().slice(0, 50),
    scores: scoresResult.scores,
    scoresNotice: scoresResult.notice,
    sessions: sessionRows.slice(0, 100)
  };
}

export async function getDataResponse(range: DataRange, refresh = false): Promise<DataResponse> {
  const cached = cache.get(range);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
  const data = await buildDataResponse(range);
  cache.set(range, { at: Date.now(), data });
  return data;
}
