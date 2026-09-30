import { LangfuseClient } from "@langfuse/client";
import type {
  DataRange,
  QualityFlaggedTurn,
  QualityMonitor,
  QualityPromptVersion,
  QualityDataset,
  QualityExperiment,
  QualityResponse,
  QualityRun,
  QualityRunItem,
  QualityStep
} from "../shared/types";
import {
  EXPERIMENT_ENVIRONMENT,
  RANGE_MS,
  TURN_OBSERVATION_NAME,
  isLiveTraffic,
  listObservations,
  readTurnMessages,
  type ObservationRecord
} from "./analytics";
import { env } from "./env";

// Quality loop: reads back every workshop step from Langfuse — the managed
// prompt and which version served each turn (03), evaluators and their
// scores on live traffic (04), the dataset (05), and experiment runs with
// their scores (06/07). Only Observations, Prompts, Datasets, Evaluators and
// Scores v3 endpoints are used; the Metrics API is rate limited.

const CACHE_TTL_MS = 60_000;
const EXPERIMENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SCORES = 5000;
const REQUEST_OPTIONS = { maxRetries: 0, timeoutInSeconds: 30 };

const langfuse = new LangfuseClient();
const cache = new Map<DataRange, { at: number; data: QualityResponse }>();
const baseUrl = env.langfuseBaseUrl.replace(/\/+$/, "");

// ── REST helpers for endpoints the SDK does not wrap yet ──────────────

async function restGet<T>(pathname: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
  const auth = Buffer.from(`${env.langfusePublicKey}:${env.langfuseSecretKey}`).toString("base64");
  const response = await fetch(`${baseUrl}${pathname}?${query}`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(`${pathname} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

type ScoreRecord = {
  id: string;
  name: string;
  source: string;
  timestamp: string;
  environment: string;
  dataType: "NUMERIC" | "BOOLEAN" | "CATEGORICAL" | "TEXT" | "CORRECTION";
  value: number | boolean | string;
  comment?: string | null;
  metadata?: Record<string, unknown> | null;
  subject?: { kind: string; id: string; traceId?: string } | null;
};

async function listScores(params: Record<string, string | undefined>): Promise<ScoreRecord[]> {
  const scores: ScoreRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await restGet<{ data: ScoreRecord[]; meta?: { cursor?: string | null } }>("/api/public/v3/scores", {
      ...params,
      fields: "details,subject",
      limit: 100,
      cursor
    });
    scores.push(...page.data);
    cursor = page.meta?.cursor ?? undefined;
  } while (cursor && scores.length < MAX_SCORES);
  return scores;
}

function traceOf(score: ScoreRecord) {
  return score.subject?.traceId ?? (score.subject?.kind === "trace" ? score.subject.id : null);
}

function numericValue(score: ScoreRecord): number | null {
  if (typeof score.value === "number") return score.value;
  if (typeof score.value === "boolean") return score.value ? 1 : 0;
  return null;
}

// A monitor "fires" on true booleans and numeric scores of 0.5 or more.
function isFlag(score: ScoreRecord) {
  const value = numericValue(score);
  return value !== null && value >= 0.5;
}

function average(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function promptLines(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// ── Sections ──────────────────────────────────────────────────────────

type EvaluatorRecord = { id: string; name: string; type: "code" | "llm_as_judge"; status: string };
type RuleRecord = { id: string; name: string; enabled: boolean; evaluatorAssignments: { evaluatorId: string }[] };

async function loadPrompt(notices: string[]) {
  try {
    const listing = await langfuse.api.prompts.list({ name: env.langfusePromptName }, REQUEST_OPTIONS);
    const meta = listing.data.find((prompt) => prompt.name === env.langfusePromptName);
    if (!meta) return null;
    const versions = [...meta.versions].sort((a, b) => a - b).slice(-12);
    const details = await Promise.all(
      versions.map((version) => langfuse.api.prompts.get(env.langfusePromptName, { version }, REQUEST_OPTIONS))
    );
    return details.map((prompt) => ({
      version: prompt.version,
      labels: prompt.labels ?? [],
      createdAt: String((prompt as { createdAt?: string }).createdAt ?? ""),
      text: typeof prompt.prompt === "string" ? prompt.prompt : JSON.stringify(prompt.prompt)
    }));
  } catch (error) {
    notices.push(`Prompt versions could not be read: ${error instanceof Error ? error.message.split("\n")[0] : "error"}`);
    return null;
  }
}

async function loadMonitorsConfig(notices: string[]) {
  try {
    const [evaluators, rules] = await Promise.all([
      restGet<{ data: EvaluatorRecord[] }>("/api/public/v2/evaluators", { limit: 100 }),
      restGet<{ data: RuleRecord[] }>("/api/public/v2/evaluation-rules", { limit: 100 })
    ]);
    return { evaluators: evaluators.data, rules: rules.data };
  } catch (error) {
    notices.push(`Evaluators could not be read: ${error instanceof Error ? error.message.split("\n")[0] : "error"}`);
    return { evaluators: [], rules: [] };
  }
}

async function loadDataset(name: string, notices: string[]): Promise<QualityDataset | null> {
  try {
    const dataset = await langfuse.api.datasets.get(name, REQUEST_OPTIONS);
    const items = await langfuse.api.datasetItems.list({ datasetName: name, limit: 1 }, REQUEST_OPTIONS);
    const total = (items.meta as { totalItems?: number } | undefined)?.totalItems ?? items.data.length;
    return { name: dataset.name, id: dataset.id, items: total, createdAt: String(dataset.createdAt) };
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== 404) {
      notices.push(`Dataset could not be read: ${error instanceof Error ? error.message.split("\n")[0] : "error"}`);
    }
    return null;
  }
}

function metadataOf(observation: ObservationRecord): Record<string, unknown> {
  return ((observation as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
}

async function buildQuality(range: DataRange): Promise<QualityResponse> {
  const notices: string[] = [];
  const toMs = Date.now();
  const from = new Date(toMs - RANGE_MS[range]).toISOString();
  const experimentFrom = new Date(toMs - EXPERIMENT_WINDOW_MS).toISOString();
  const to = new Date(toMs).toISOString();

  const [prompt, monitorsConfig, datasetResults, turnList, generationList, runRootList, experimentGenerationList, liveScores, experimentScores] =
    await Promise.all([
      loadPrompt(notices),
      loadMonitorsConfig(notices),
      Promise.all([env.datasetName, env.memoryDatasetName].map((name) => loadDataset(name, notices))),
      listObservations({ type: "AGENT", name: TURN_OBSERVATION_NAME }, "core,basic,io", from, to, 2000),
      listObservations({ type: "GENERATION" }, "core,basic,prompt", from, to, 5000),
      listObservations(
        { type: "SPAN", name: "experiment-item-run", environment: EXPERIMENT_ENVIRONMENT },
        "core,basic,metadata",
        experimentFrom,
        to,
        2000
      ),
      listObservations({ type: "GENERATION", environment: EXPERIMENT_ENVIRONMENT }, "core,basic,prompt", experimentFrom, to, 5000),
      listScores({ source: "EVAL", fromTimestamp: from }).catch((error) => {
        notices.push(`Monitor scores could not be read: ${error instanceof Error ? error.message : "error"}`);
        return [] as ScoreRecord[];
      }),
      // runExperiment callback scores arrive through the API (source API) and
      // are not tagged with the experiment environment; they are matched to
      // runs by trace below, which also drops API scores on live traffic.
      listScores({ source: "API", fromTimestamp: experimentFrom }).catch(
        (error) => {
          notices.push(`Experiment scores could not be read: ${error instanceof Error ? error.message : "error"}`);
          return [] as ScoreRecord[];
        }
      )
    ]);

  const datasets = datasetResults.filter((entry): entry is QualityDataset => entry !== null);
  const dataset = datasets.find((entry) => entry.name === env.datasetName) ?? null;
  const liveTurns = turnList.items.filter(isLiveTraffic);
  const liveTraceIds = new Set(liveTurns.map((turn) => turn.traceId));
  const projectId = turnList.items[0]?.projectId ?? runRootList.items[0]?.projectId ?? null;

  // Prompt version that served each live turn (first linked generation).
  const promptVersionByTrace = new Map<string, number>();
  for (const generation of generationList.items) {
    const version = (generation as { promptVersion?: number | null }).promptVersion;
    if (liveTraceIds.has(generation.traceId) && typeof version === "number" && !promptVersionByTrace.has(generation.traceId)) {
      promptVersionByTrace.set(generation.traceId, version);
    }
  }

  // ── Monitors (step 04) ───────────────────────────────────────────────
  const monitorScores = liveScores.filter((score) => {
    const traceId = traceOf(score);
    return score.environment !== EXPERIMENT_ENVIRONMENT && traceId !== null && liveTraceIds.has(traceId);
  });
  const scoresByEvaluator = new Map<string, ScoreRecord[]>();
  for (const score of monitorScores) {
    const evaluatorId = String(score.metadata?.evaluator_id ?? `name:${score.name}`);
    scoresByEvaluator.set(evaluatorId, [...(scoresByEvaluator.get(evaluatorId) ?? []), score]);
  }

  const days: string[] = [];
  const dayCount = Math.min(30, Math.ceil(RANGE_MS[range] / 86_400_000));
  for (let index = dayCount - 1; index >= 0; index -= 1) days.push(new Date(toMs - index * 86_400_000).toISOString().slice(0, 10));

  const monitorFromScores = (evaluatorId: string, name: string, type: QualityMonitor["type"], scores: ScoreRecord[]): QualityMonitor => {
    const rules = monitorsConfig.rules.filter((rule) => rule.evaluatorAssignments.some((entry) => entry.evaluatorId === evaluatorId));
    const flagged = scores.filter(isFlag).length;
    return {
      evaluatorId,
      name,
      type,
      scoreName: scores[0]?.name ?? null,
      ruleNames: rules.map((rule) => rule.name),
      active: rules.some((rule) => rule.enabled),
      scored: scores.length,
      flagged,
      rate: scores.length ? flagged / scores.length : null,
      daily: days.map((day) => {
        const onDay = scores.filter((score) => score.timestamp.slice(0, 10) === day);
        return { day, scored: onDay.length, flagged: onDay.filter(isFlag).length };
      })
    };
  };

  const monitors: QualityMonitor[] = monitorsConfig.evaluators.map((evaluator) =>
    monitorFromScores(evaluator.id, evaluator.name, evaluator.type, scoresByEvaluator.get(evaluator.id) ?? [])
  );
  // Scores from evaluators that no longer exist (or were seeded) still count.
  for (const [evaluatorId, scores] of scoresByEvaluator) {
    if (!monitors.some((monitor) => monitor.evaluatorId === evaluatorId)) {
      monitors.push(monitorFromScores(evaluatorId, scores[0].name, "code", scores));
    }
  }

  const questionByTrace = new Map<string, { message: string; time: string; sessionId: string | null }>();
  for (const turn of liveTurns) {
    const users = readTurnMessages(turn.input).filter((message) => message.role === "user");
    questionByTrace.set(turn.traceId, { message: users.at(-1)?.content ?? "", time: turn.startTime, sessionId: turn.sessionId ?? null });
  }
  const flaggedByTrace = new Map<string, Set<string>>();
  for (const score of monitorScores.filter(isFlag)) {
    const traceId = traceOf(score)!;
    flaggedByTrace.set(traceId, (flaggedByTrace.get(traceId) ?? new Set()).add(score.name));
  }
  const flagged: QualityFlaggedTurn[] = [...flaggedByTrace.entries()]
    .map(([traceId, names]) => {
      const turn = questionByTrace.get(traceId);
      return {
        time: turn?.time ?? "",
        traceId,
        sessionId: turn?.sessionId ?? null,
        scoreNames: [...names],
        message: turn?.message ?? "",
        promptVersion: promptVersionByTrace.get(traceId) ?? null
      };
    })
    .sort((a, b) => b.time.localeCompare(a.time))
    .slice(0, 40);

  // ── Prompt versions (step 03) ────────────────────────────────────────
  const scoreNames = [...new Set(monitorScores.map((score) => score.name))];
  let promptSection: QualityResponse["prompt"] = null;
  if (prompt) {
    const versions: QualityPromptVersion[] = prompt.map((entry, index) => {
      const previous = index > 0 ? new Set(promptLines(prompt[index - 1].text)) : null;
      const current = new Set(promptLines(entry.text));
      const traces = [...promptVersionByTrace.entries()].filter(([, version]) => version === entry.version).map(([traceId]) => traceId);
      const traceSet = new Set(traces);
      const monitorRates: Record<string, number | null> = {};
      for (const name of scoreNames) {
        const relevant = monitorScores.filter((score) => score.name === name && traceSet.has(traceOf(score)!));
        monitorRates[name] = relevant.length ? relevant.filter(isFlag).length / relevant.length : null;
      }
      return {
        version: entry.version,
        labels: entry.labels,
        createdAt: entry.createdAt,
        added: previous ? [...current].filter((line) => !previous.has(line)) : [],
        removed: previous ? [...previous].filter((line) => !current.has(line)) : [],
        turns: traces.length,
        monitorRates
      };
    });
    // Traffic can point at versions this project never had (e.g. the seeded
    // sample traffic was exported from another project).
    const known = new Set(versions.map((entry) => entry.version));
    const foreign = [...new Set(promptVersionByTrace.values())].filter((version) => !known.has(version)).sort((a, b) => a - b);
    for (const version of foreign) {
      const traceSet = new Set([...promptVersionByTrace.entries()].filter(([, value]) => value === version).map(([traceId]) => traceId));
      const monitorRates: Record<string, number | null> = {};
      for (const name of scoreNames) {
        const relevant = monitorScores.filter((score) => score.name === name && traceSet.has(traceOf(score)!));
        monitorRates[name] = relevant.length ? relevant.filter(isFlag).length / relevant.length : null;
      }
      versions.push({ version, labels: [], createdAt: "", added: [], removed: [], turns: traceSet.size, monitorRates, missing: true });
    }
    promptSection = {
      name: env.langfusePromptName,
      productionVersion: prompt.find((entry) => entry.labels.includes(env.langfusePromptLabel))?.version ?? null,
      versions: versions.sort((a, b) => Number(a.missing ?? false) - Number(b.missing ?? false) || b.version - a.version),
      unlinkedTurns: liveTurns.filter((turn) => !promptVersionByTrace.has(turn.traceId)).length
    };
  }

  // ── Experiment runs (steps 06 and 07) ────────────────────────────────
  // Runs are rebuilt from their root "experiment-item-run" spans and grouped
  // by experiment (workshop dataset, profile-memory dataset, ...).
  type RunTrace = {
    runName: string;
    experimentName: string;
    datasetId: string | null;
    itemId: string;
    category: string | null;
    startTime: string;
  };
  const runByTrace = new Map<string, RunTrace>();
  for (const root of runRootList.items) {
    const metadata = metadataOf(root);
    const runName = metadata.experiment_run_name;
    if (typeof runName !== "string") continue;
    runByTrace.set(root.traceId, {
      runName,
      experimentName: typeof metadata.experiment_name === "string" ? metadata.experiment_name : "Experiment",
      datasetId: typeof metadata.dataset_id === "string" ? metadata.dataset_id : null,
      itemId: String(metadata.dataset_item_id ?? root.traceId),
      category: typeof metadata.category === "string" ? metadata.category : null,
      startTime: root.startTime
    });
  }
  const runPromptVersions = new Map<string, Set<number>>();
  for (const generation of experimentGenerationList.items) {
    const run = runByTrace.get(generation.traceId);
    const version = (generation as { promptVersion?: number | null }).promptVersion;
    if (run && typeof version === "number") {
      runPromptVersions.set(run.runName, (runPromptVersions.get(run.runName) ?? new Set()).add(version));
    }
  }
  const runScores = new Map<string, Map<string, Map<string, number>>>();
  const scoreNamesByExperiment = new Map<string, Set<string>>();
  for (const score of experimentScores) {
    const traceId = traceOf(score);
    const run = traceId ? runByTrace.get(traceId) : undefined;
    const value = numericValue(score);
    if (!run || value === null) continue;
    const items = runScores.get(run.runName) ?? new Map<string, Map<string, number>>();
    const itemScores = items.get(run.itemId) ?? new Map<string, number>();
    itemScores.set(score.name, value);
    items.set(run.itemId, itemScores);
    runScores.set(run.runName, items);
    scoreNamesByExperiment.set(run.experimentName, (scoreNamesByExperiment.get(run.experimentName) ?? new Set()).add(score.name));
  }

  const buildRun = (runName: string): QualityRun => {
    const entries = [...runByTrace.values()].filter((run) => run.runName === runName);
    const items = runScores.get(runName) ?? new Map<string, Map<string, number>>();
    const names = [...(scoreNamesByExperiment.get(entries[0].experimentName) ?? [])];
    const averages: Record<string, number | null> = {};
    for (const name of names) {
      averages[name] = average(
        [...items.values()].map((scores) => scores.get(name)).filter((value): value is number => value !== undefined)
      );
    }
    return {
      runName,
      experimentName: entries[0].experimentName,
      startedAt: entries.map((entry) => entry.startTime).sort()[0],
      items: entries.length,
      promptVersions: [...(runPromptVersions.get(runName) ?? [])].sort((a, b) => a - b),
      averages
    };
  };

  // Scores where a lower value is better (count of facts saved by mistake).
  const LOWER_IS_BETTER = new Set(["memory_false_saves"]);

  const compareRuns = (latest: QualityRun, baseline: QualityRun, scoreNames: string[]) => {
    const latestItems = runScores.get(latest.runName) ?? new Map<string, Map<string, number>>();
    const baselineItems = runScores.get(baseline.runName) ?? new Map<string, Map<string, number>>();
    const categoryOf = new Map([...runByTrace.values()].map((run) => [run.itemId, run.category]));
    const itemIds = [...new Set([...latestItems.keys(), ...baselineItems.keys()])].sort();
    const items: QualityRunItem[] = itemIds.map((itemId) => {
      const scores: Record<string, Record<string, number | null>> = {};
      let delta = 0;
      for (const name of scoreNames) {
        const before = baselineItems.get(itemId)?.get(name) ?? null;
        const after = latestItems.get(itemId)?.get(name) ?? null;
        scores[name] = { [baseline.runName]: before, [latest.runName]: after };
        if (before !== null && after !== null) delta += (after - before) * (LOWER_IS_BETTER.has(name) ? -1 : 1);
      }
      return {
        itemId,
        category: categoryOf.get(itemId) ?? null,
        scores,
        change: !baselineItems.has(itemId) ? "new" : delta > 0.001 ? "improved" : delta < -0.001 ? "regressed" : "same"
      };
    });
    return { baseline: baseline.runName, latest: latest.runName, items };
  };

  const datasetNameById = new Map(datasets.map((entry) => [entry.id, entry.name]));
  const experimentNames = [...new Set([...runByTrace.values()].map((run) => run.experimentName))];
  const experiments: QualityExperiment[] = experimentNames.map((name) => {
    const runNames = [
      ...new Set([...runByTrace.values()].filter((run) => run.experimentName === name).map((run) => run.runName))
    ];
    const experimentRuns = runNames.map(buildRun).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const scoreNames = [...(scoreNamesByExperiment.get(name) ?? [])].sort();
    const datasetId = [...runByTrace.values()].find((run) => run.experimentName === name)?.datasetId ?? null;
    return {
      name,
      datasetName: datasetId ? datasetNameById.get(datasetId) ?? null : null,
      scoreNames,
      runs: experimentRuns,
      comparison: experimentRuns.length >= 2 ? compareRuns(experimentRuns[0], experimentRuns[1], scoreNames) : null
    };
  });
  // The workshop experiment first, then the rest by most recent run.
  experiments.sort(
    (a, b) =>
      Number(b.datasetName === env.datasetName) - Number(a.datasetName === env.datasetName) ||
      (b.runs[0]?.startedAt ?? "").localeCompare(a.runs[0]?.startedAt ?? "")
  );
  const mainExperiment = experiments.find((experiment) => experiment.datasetName === env.datasetName) ?? experiments[0];
  const runs = mainExperiment?.runs ?? [];

  // ── Loop status ──────────────────────────────────────────────────────
  const link = (path: string) => (projectId ? `${baseUrl}/project/${projectId}/${path}` : null);
  const judgeMonitors = monitors.filter((monitor) => monitor.type === "llm_as_judge" && monitor.active);
  const codeMonitors = monitors.filter((monitor) => monitor.type === "code" && monitor.active);
  const linkedTurns = liveTurns.length - (promptSection?.unlinkedTurns ?? liveTurns.length);
  const scoredRuns = runs.filter((run) => Object.values(run.averages).some((value) => value !== null));
  const allScoredRuns = experiments
    .flatMap((experiment) => experiment.runs)
    .filter((run) => Object.values(run.averages).some((value) => value !== null));
  const distinctRunPrompts = new Set(scoredRuns.map((run) => run.promptVersions.join(",")));

  const steps: QualityStep[] = [
    {
      step: "02",
      title: "Tracing",
      status: liveTurns.length > 0 ? "done" : "todo",
      summary: `${liveTurns.length} live chat turns traced in this range.`,
      link: link("traces")
    },
    {
      step: "03",
      title: "Prompt management",
      status: !promptSection ? "todo" : linkedTurns > 0 ? "done" : "partial",
      summary: promptSection
        ? `v${promptSection.productionVersion ?? "?"} is live on "${env.langfusePromptLabel}"; ${linkedTurns} of ${liveTurns.length} turns linked to a version.`
        : "No managed prompt yet: the app uses its local fallback prompt.",
      link: link(`prompts/${encodeURIComponent(env.langfusePromptName)}`)
    },
    {
      step: "04",
      title: "Monitoring",
      status: judgeMonitors.length > 0 && codeMonitors.length > 0 ? "done" : codeMonitors.length + judgeMonitors.length > 0 ? "partial" : "todo",
      summary:
        codeMonitors.length + judgeMonitors.length === 0
          ? "No active evaluators on live traffic."
          : `${codeMonitors.length} code and ${judgeMonitors.length} LLM-judge monitors active${
              judgeMonitors.length === 0 ? "; LLM judges need an LLM connection in Langfuse" : ""
            }.`,
      link: link("evals")
    },
    {
      step: "05",
      title: "Dataset",
      status: dataset && dataset.items > 0 ? "done" : "todo",
      summary: datasets.length
        ? datasets.map((entry) => `"${entry.name}" has ${entry.items} items`).join("; ") + "."
        : `No "${env.datasetName}" dataset yet.`,
      link: dataset ? link(`datasets/${dataset.id}`) : link("datasets")
    },
    {
      step: "06",
      title: "Experiments",
      status: allScoredRuns.length > 0 ? "done" : "todo",
      summary: allScoredRuns.length
        ? `${allScoredRuns.length} scored runs across ${experiments.length} experiment${experiments.length === 1 ? "" : "s"}; latest correctness ${
            scoredRuns[0]?.averages.correctness?.toFixed(2) ?? "—"
          }.`
        : "No experiment runs yet.",
      link: dataset ? link(`datasets/${dataset.id}`) : null
    },
    {
      step: "07",
      title: "Evaluate a change",
      status: distinctRunPrompts.size >= 2 ? "done" : scoredRuns.length >= 2 ? "partial" : "todo",
      summary:
        distinctRunPrompts.size >= 2 && mainExperiment?.comparison
          ? `Compared prompt ${runs[1].promptVersions.map((v) => `v${v}`).join("/")} with ${runs[0].promptVersions.map((v) => `v${v}`).join("/")}.`
          : scoredRuns.length >= 2
            ? "Two runs exist but on the same prompt version."
            : "Needs two runs on different prompt versions.",
      link: dataset ? link(`datasets/${dataset.id}`) : null
    }
  ];

  return {
    generatedAt: new Date().toISOString(),
    range,
    langfuseBaseUrl: baseUrl,
    projectId,
    steps,
    prompt: promptSection,
    monitors: monitors.sort((a, b) => Number(b.active) - Number(a.active) || b.scored - a.scored),
    flagged,
    datasets,
    experiments,
    notices
  };
}

export async function getQualityResponse(range: DataRange, refresh = false): Promise<QualityResponse> {
  const cached = cache.get(range);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
  const data = await buildQuality(range);
  cache.set(range, { at: Date.now(), data });
  return data;
}
