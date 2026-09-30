import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  DataRange,
  QualityDataset,
  QualityExperiment,
  QualityMonitor,
  QualityResponse,
  QualityStepStatus
} from "../shared/types";

const STATUS_LABEL: Record<QualityStepStatus, string> = { done: "Done", partial: "Partly done", todo: "Not started" };
const STATUS_ICON: Record<QualityStepStatus, string> = { done: "✓", partial: "◐", todo: "○" };

// Friendly column titles for the score names the monitors write.
const SCORE_LABELS: Record<string, string> = {
  asks_follow_up: "Follow-ups",
  user_all_caps_signal: "ALL CAPS",
  "User Disagreement": "Disagreement",
  "Out of scope request": "Out of scope",
  correctness: "Correctness",
  keyword_overlap: "Keyword overlap",
  memory_correct: "Saved the right facts",
  memory_false_saves: "Wrong saves"
};

// Scores where a lower value is better (count of facts saved by mistake).
const LOWER_IS_BETTER = new Set(["memory_false_saves"]);

function scoreLabel(name: string) {
  return SCORE_LABELS[name] ?? name;
}

function percent(value: number | null) {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function fixed(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : value.toFixed(2);
}

function formatDate(iso: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function Panel({ title, subtitle, className = "", children }: { title: string; subtitle: string; className?: string; children: ReactNode }) {
  return (
    <section className={`dp-panel ${className}`}>
      <header className="dp-panel-head">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </header>
      <div className="dp-panel-body">{children}</div>
    </section>
  );
}

function MonitorSpark({ monitor }: { monitor: QualityMonitor }) {
  const max = Math.max(1, ...monitor.daily.map((day) => day.scored));
  return (
    <div className="ql-spark" aria-hidden="true">
      {monitor.daily.map((day) => (
        <span key={day.day} className="ql-spark-col" title={`${day.day}: ${day.flagged} of ${day.scored} flagged`}>
          <span className="ql-spark-scored" style={{ height: `${(day.scored / max) * 100}%` }}>
            <span className="ql-spark-flagged" style={{ height: day.scored ? `${(day.flagged / day.scored) * 100}%` : 0 }} />
          </span>
        </span>
      ))}
    </div>
  );
}

function ExperimentPanel({ experiment, datasets }: { experiment: QualityExperiment; datasets: QualityDataset[] }) {
  const dataset = datasets.find((entry) => entry.name === experiment.datasetName);
  const changed = experiment.comparison?.items.filter((item) => item.change !== "same") ?? [];
  const comparison = experiment.comparison;
  return (
    <Panel
      className="span-3"
      title={experiment.name}
      subtitle={`Runs of the "${experiment.datasetName ?? "unknown"}" dataset${
        dataset ? ` (${dataset.items} items)` : ""
      }, newest first, scored by the runExperiment callbacks`}
    >
      <table className="dp-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Prompt</th>
            <th className="num">Items</th>
            {experiment.scoreNames.map((name) => (
              <th key={name} className="num">
                {scoreLabel(name)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {experiment.runs.map((run, index) => {
            const previous = experiment.runs[index + 1];
            return (
              <tr key={run.runName}>
                <td className="dp-nowrap">{formatDate(run.startedAt)}</td>
                <td>{run.promptVersions.length ? run.promptVersions.map((version) => `v${version}`).join(", ") : "fallback"}</td>
                <td className="num">{run.items}</td>
                {experiment.scoreNames.map((name) => {
                  const value = run.averages[name] ?? null;
                  const before = previous?.averages[name];
                  const delta = value !== null && before !== null && before !== undefined ? value - before : null;
                  const better = delta !== null && (LOWER_IS_BETTER.has(name) ? delta < 0 : delta > 0);
                  return (
                    <td key={name} className="num">
                      {fixed(value)}
                      {delta !== null && Math.abs(delta) >= 0.005 && (
                        <span className={`ql-delta ${better ? "up" : "down"}`}>
                          {delta > 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(2)}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      {comparison && (
        <div className="ql-compare">
          <div className="ql-diff-title">
            Latest run vs the one before: {changed.length} of {comparison.items.length} items changed
          </div>
          {changed.length > 0 && (
            <table className="dp-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  {experiment.scoreNames.map((name) => (
                    <th key={name} className="num">
                      {scoreLabel(name)} (before → after)
                    </th>
                  ))}
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {changed.map((item) => (
                  <tr key={item.itemId}>
                    <td className="dp-nowrap">{item.itemId}</td>
                    <td>{item.category ?? "—"}</td>
                    {experiment.scoreNames.map((name) => (
                      <td key={name} className="num">
                        {fixed(item.scores[name]?.[comparison.baseline])} → {fixed(item.scores[name]?.[comparison.latest])}
                      </td>
                    ))}
                    <td>
                      <span className={`dp-pill ${item.change === "regressed" ? "warn" : item.change === "improved" ? "new" : ""}`}>
                        {item.change}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}

export function QualityLoop({ range, refreshToken }: { range: DataRange; refreshToken: number }) {
  const [data, setData] = useState<QualityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lastToken = useRef(refreshToken);

  useEffect(() => {
    const refresh = refreshToken !== lastToken.current;
    lastToken.current = refreshToken;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/quality?range=${range}${refresh ? "&refresh=1" : ""}`);
        if (!response.ok) throw new Error(await response.text());
        const next = (await response.json()) as QualityResponse;
        if (!cancelled) setData(next);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not load the quality loop.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range, refreshToken]);

  const link = (path: string) => (data?.projectId ? `${data.langfuseBaseUrl}/project/${data.projectId}/${path}` : undefined);
  const monitorScoreNames = data
    ? [...new Set(data.prompt?.versions.flatMap((version) => Object.keys(version.monitorRates)) ?? [])]
    : [];
  const latestVersion = data?.prompt?.versions.find((version) => !version.missing && (version.added.length || version.removed.length));
  const hasJudge = data?.monitors.some((monitor) => monitor.type === "llm_as_judge" && monitor.active);

  return (
    <section className={`dp-insights ${loading && data ? "is-loading" : ""}`}>
      <div className="dp-section-head">
        <div>
          <h2>Quality loop</h2>
          <p>Prompt management, monitors, dataset and experiments — the workshop steps, read back from Langfuse.</p>
        </div>
        <span className="dp-section-status">{loading ? "Reading Langfuse…" : data ? `Updated ${formatDate(data.generatedAt)}` : ""}</span>
      </div>

      {error && <div className="dp-error">{error}</div>}
      {!data && loading && <div className="dp-panel dp-insights-loading">Reading prompts, evaluators, datasets and experiment runs…</div>}

      {data && (
        <>
          {data.notices.map((notice) => (
            <div key={notice} className="dp-error">
              {notice}
            </div>
          ))}

          <ol className="ql-steps">
            {data.steps.map((step) => (
              <li key={step.step} className={`ql-step ${step.status}`}>
                <div className="ql-step-head">
                  <span className="ql-step-num">{step.step}</span>
                  <span className={`ql-status ${step.status}`}>
                    <span aria-hidden="true">{STATUS_ICON[step.status]}</span> {STATUS_LABEL[step.status]}
                  </span>
                </div>
                <h3>{step.title}</h3>
                <p>{step.summary}</p>
                {step.link && (
                  <a href={step.link} target="_blank" rel="noreferrer">
                    Open in Langfuse ↗
                  </a>
                )}
              </li>
            ))}
          </ol>

          <div className="dp-grid">
            <Panel
              className="span-2"
              title="Prompt versions"
              subtitle="Which managed prompt served the live turns in this range, and how often the monitors fired on each version"
            >
              {!data.prompt ? (
                <div className="dp-empty">No managed prompt yet. Run npm run prompt:publish to put the system prompt under version control.</div>
              ) : (
                <>
                  <table className="dp-table">
                    <thead>
                      <tr>
                        <th>Version</th>
                        <th>Published</th>
                        <th className="num">Turns</th>
                        {monitorScoreNames.map((name) => (
                          <th key={name} className="num">
                            {scoreLabel(name)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.prompt.versions.map((version) => (
                        <tr key={version.version}>
                          <td className="dp-nowrap">
                            <span className="dp-step-name">v{version.version}</span>
                            {version.labels
                              .filter((label) => label !== "latest")
                              .map((label) => (
                                <span key={label} className={`dp-pill ${label === "production" ? "new" : ""}`}>
                                  {label}
                                </span>
                              ))}
                            {version.missing && <span className="dp-pill">seeded traffic</span>}
                          </td>
                          <td className="dp-nowrap">{version.missing ? "not in this project" : formatDate(version.createdAt)}</td>
                          <td className="num">{version.turns}</td>
                          {monitorScoreNames.map((name) => (
                            <td key={name} className="num">
                              {percent(version.monitorRates[name] ?? null)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {data.prompt.unlinkedTurns > 0 && (
                    <p className="dp-note">{data.prompt.unlinkedTurns} turns ran on the local fallback prompt (no managed version linked).</p>
                  )}
                  {latestVersion && (
                    <div className="ql-diff">
                      <div className="ql-diff-title">What changed in v{latestVersion.version}</div>
                      {latestVersion.added.map((line) => (
                        <div key={`+${line}`} className="ql-diff-line add">
                          <span aria-hidden="true">+</span> {line.replace(/^- /, "")}
                        </div>
                      ))}
                      {latestVersion.removed.map((line) => (
                        <div key={`-${line}`} className="ql-diff-line remove">
                          <span aria-hidden="true">−</span> {line.replace(/^- /, "")}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </Panel>

            <Panel title="Monitors" subtitle="Evaluators scoring live chat turns in Langfuse">
              {data.monitors.length === 0 ? (
                <div className="dp-empty">No evaluators yet.</div>
              ) : (
                <ul className="ql-monitors">
                  {data.monitors.map((monitor) => (
                    <li key={monitor.evaluatorId}>
                      <div className="ql-monitor-head">
                        <span className="dp-step-name">{monitor.name}</span>
                        <span className="dp-type">{monitor.type === "code" ? "code" : "LLM judge"}</span>
                        {!monitor.active && <span className="dp-pill warn">No active rule</span>}
                      </div>
                      <div className="ql-monitor-stat">
                        <strong>{percent(monitor.rate)}</strong> flagged · {monitor.flagged} of {monitor.scored} turns
                      </div>
                      <MonitorSpark monitor={monitor} />
                    </li>
                  ))}
                </ul>
              )}
              {!hasJudge && (
                <p className="dp-note">
                  The User Disagreement and Out-of-scope judges run inside Langfuse and need an LLM connection: add your OpenAI key under
                  Settings → LLM Connections in Langfuse, then they can be switched on.
                </p>
              )}
            </Panel>

            {data.experiments.length === 0 ? (
              <Panel className="span-3" title="Experiments" subtitle="Dataset runs scored by runExperiment callbacks">
                <div className="dp-empty">No experiment runs yet. Run npm run dataset:run to score the agent on the dataset.</div>
              </Panel>
            ) : (
              data.experiments.map((experiment) => (
                <ExperimentPanel key={experiment.name} experiment={experiment} datasets={data.datasets} />
              ))
            )}

            <Panel
              className="span-3"
              title="Turns flagged by monitors"
              subtitle="Most recent live turns where an evaluator fired — the best candidates to read, and to add to the dataset"
            >
              {data.flagged.length === 0 ? (
                <div className="dp-empty">No monitor has fired in this range.</div>
              ) : (
                <table className="dp-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Dad's message</th>
                      <th>Monitors</th>
                      <th>Prompt</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.flagged.map((turn) => (
                      <tr key={turn.traceId}>
                        <td className="dp-nowrap">{formatDate(turn.time)}</td>
                        <td className="dp-quote">“{turn.message}”</td>
                        <td>
                          <span className="dp-badges">
                            {turn.scoreNames.map((name) => (
                              <span key={name} className="dp-badge">
                                <span aria-hidden="true">!</span>
                                {scoreLabel(name)}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td>{turn.promptVersion ? `v${turn.promptVersion}` : "fallback"}</td>
                        <td className="num">
                          {link(`traces/${turn.traceId}`) && (
                            <a href={link(`traces/${turn.traceId}`)} target="_blank" rel="noreferrer">
                              Trace ↗
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>
        </>
      )}
      <p className="dp-source dp-source-inline">
        Source · Langfuse Prompts, Evaluators, Datasets, Observations and Scores (v3) APIs. Experiment runs are rebuilt from their traces.
      </p>
    </section>
  );
}
