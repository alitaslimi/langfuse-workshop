export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: string;
};

export type PhoneDetails = {
  model: string | null;
  os: string | null;
  finish: string | null;
  purchased: string | null;
};

export type SupportContext = {
  id: string;
  label: string;
  relationship: string;
  devices: string[];
  phone: PhoneDetails;
  notes: string[];
  deviceSummary: string;
  responseStyle: string;
  notableApps: string[];
  scopeHighlights: string[];
  starterQuestions: string[];
};

export type ChatRequest = {
  messages: ChatMessage[];
  sessionId: string;
  userId?: string;
};

// Facts the agent can change with update_support_context. addApp/removeApp
// edit notableApps; note appends to notes.
export type ProfileField = "phoneModel" | "iosVersion" | "phoneFinish" | "phonePurchased" | "addApp" | "removeApp" | "note";

export type ProfileUpdate = {
  id: string;
  at: string;
  field: ProfileField;
  value: string | null;
  previousValue: string | null;
  evidence: string;
  // "chat" = stated by Dad; "cleared" = reset because a related fact changed.
  source: "chat" | "cleared";
  sessionId: string | null;
  traceId: string | null;
};

export type SupportProfileResponse = {
  context: SupportContext;
  base: SupportContext;
  updates: ProfileUpdate[];
  memoryEnabled: boolean;
};

export type ChatResponse = {
  answer: string;
  usedTools: string[];
  profileUpdates: ProfileUpdate[];
  traceMeta: {
    contextId: string;
    contextLabel: string;
    model: string;
  };
};

export type HealthResponse = {
  ok: boolean;
  provider: string;
  tracingConfigured: boolean;
};

export type DataRange = "24h" | "7d" | "30d";

export type SignalKind = "disagreement" | "frustration" | "context-correction";

export type DataSessionRow = {
  sessionId: string;
  userId: string | null;
  firstSeen: string;
  lastSeen: string;
  turns: number;
  firstQuestion: string;
  lastQuestion: string;
  totalCost: number;
  signals: SignalKind[];
};

export type DataFlaggedMessage = {
  time: string;
  sessionId: string | null;
  traceId: string;
  kinds: SignalKind[];
  message: string;
};

export type DataScoreSummary = {
  name: string;
  dataType: "NUMERIC" | "CATEGORICAL";
  count: number;
  average: number | null;
  values: { value: string; count: number }[];
};

export type DataResponse = {
  range: DataRange;
  from: string;
  to: string;
  generatedAt: string;
  granularity: "hour" | "day";
  langfuseBaseUrl: string;
  projectId: string | null;
  truncated: boolean;
  totals: {
    sessions: number;
    turns: number;
    flaggedTurns: number;
    users: number;
    modelCalls: number;
    totalCost: number;
    inputTokens: number;
    outputTokens: number;
    p50TurnLatencyMs: number | null;
    p95TurnLatencyMs: number | null;
    avgTurnsPerSession: number | null;
  };
  turnsOverTime: { time: string; turns: number; cost: number }[];
  steps: { type: string; name: string; count: number; p50LatencyMs: number | null; p95LatencyMs: number | null }[];
  models: { model: string; calls: number; inputTokens: number; outputTokens: number; totalCost: number }[];
  sessionDepth: { bucket: string; sessions: number }[];
  signals: { kind: SignalKind; count: number }[];
  flagged: DataFlaggedMessage[];
  scores: DataScoreSummary[];
  // Set when scores could not be read (e.g. the Metrics API daily limit).
  scoresNotice: string | null;
  sessions: DataSessionRow[];
};

// ── Request insights (src/server/insights.ts) ──────────────────────────

export type RequestCategory =
  | "diagnosis"
  | "os_settings"
  | "apps"
  | "connectivity"
  | "hardware"
  | "accounts_privacy"
  | "out_of_scope";

export type RequestKind = "new_request" | "follow_up" | "profile_info" | "other";

export type InsightTopic = {
  topic: string;
  category: RequestCategory;
  app: string | null;
  requests: number;
  sessions: number;
  followUps: number;
  guideId: string | null;
  guideTitle: string | null;
  isStarter: boolean;
  firstSeen: string;
  lastSeen: string;
  isEmerging: boolean;
  examples: string[];
};

export type InsightCategory = {
  category: RequestCategory;
  label: string;
  sessions: number;
  requests: number;
  followUps: number;
  guides: number;
  starters: number;
};

export type InsightStarter = {
  question: string;
  topic: string;
  category: RequestCategory;
  asked: number;
  sessions: number;
  lastAsked: string | null;
};

export type InsightRecommendation = {
  kind: "add_guide" | "improve_answers" | "replace_starter" | "expand_category";
  title: string;
  detail: string;
  sessions: number;
  requests: number;
  topic: string | null;
  category: RequestCategory | null;
};

export type InsightsResponse = {
  range: DataRange;
  generatedAt: string;
  model: string;
  classifiedTurns: number;
  pendingTurns: number;
  newRequests: number;
  followUps: number;
  sessions: number;
  categories: InsightCategory[];
  topics: InsightTopic[];
  starters: InsightStarter[];
  recommendations: InsightRecommendation[];
};

// ── Quality loop (src/server/quality.ts) ───────────────────────────────

export type QualityStepStatus = "done" | "partial" | "todo";

export type QualityStep = {
  step: string;
  title: string;
  status: QualityStepStatus;
  summary: string;
  link: string | null;
};

export type QualityPromptVersion = {
  version: number;
  labels: string[];
  createdAt: string;
  added: string[];
  removed: string[];
  turns: number;
  monitorRates: Record<string, number | null>;
  // Referenced by traces but not a version in this Langfuse project.
  missing?: boolean;
};

export type QualityMonitor = {
  evaluatorId: string;
  name: string;
  type: "code" | "llm_as_judge";
  scoreName: string | null;
  ruleNames: string[];
  active: boolean;
  scored: number;
  flagged: number;
  rate: number | null;
  daily: { day: string; scored: number; flagged: number }[];
};

export type QualityFlaggedTurn = {
  time: string;
  traceId: string;
  sessionId: string | null;
  scoreNames: string[];
  message: string;
  promptVersion: number | null;
};

export type QualityRun = {
  runName: string;
  experimentName: string;
  startedAt: string;
  items: number;
  promptVersions: number[];
  averages: Record<string, number | null>;
};

export type QualityRunItem = {
  itemId: string;
  category: string | null;
  scores: Record<string, Record<string, number | null>>;
  change: "improved" | "regressed" | "same" | "new";
};

export type QualityDataset = { name: string; id: string; items: number; createdAt: string };

export type QualityExperiment = {
  name: string;
  datasetName: string | null;
  scoreNames: string[];
  runs: QualityRun[];
  comparison: { baseline: string; latest: string; items: QualityRunItem[] } | null;
};

export type QualityResponse = {
  generatedAt: string;
  range: DataRange;
  langfuseBaseUrl: string;
  projectId: string | null;
  steps: QualityStep[];
  prompt: { name: string; productionVersion: number | null; versions: QualityPromptVersion[]; unlinkedTurns: number } | null;
  monitors: QualityMonitor[];
  flagged: QualityFlaggedTurn[];
  datasets: QualityDataset[];
  experiments: QualityExperiment[];
  notices: string[];
};
