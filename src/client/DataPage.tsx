import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DataRange, DataResponse, SignalKind } from "../shared/types";
import { TopBar } from "./App";
import { QualityLoop } from "./QualityLoop";
import { RequestInsights } from "./RequestInsights";

const RANGES: { value: DataRange; label: string }[] = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" }
];

const SIGNAL_LABELS: Record<SignalKind, { label: string; description: string }> = {
  disagreement: {
    label: "Disagreement",
    description: "Dad says the steps didn't work or he can't find something."
  },
  frustration: {
    label: "Frustration",
    description: "Mostly capital letters, or repeated exclamation marks."
  },
  "context-correction": {
    label: "Context correction",
    description: "Dad corrects his device details, e.g. a new phone."
  }
};

// ── Formatting ─────────────────────────────────────────────────────────

const integer = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function formatCount(value: number) {
  return value >= 10_000 ? compact.format(value) : integer.format(value);
}

function formatCost(value: number) {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${compact.format(value)}`;
}

function formatLatency(ms: number | null) {
  if (ms === null) return "—";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

// Metrics API buckets: "2026-09-30" for days, "2026-09-30T08:00:00Z" for hours.
function formatBucket(time: string, granularity: "hour" | "day", long = false) {
  const date = new Date(granularity === "day" ? `${time}T00:00:00` : time);
  if (granularity === "hour") {
    const hour = date.toLocaleTimeString("en-US", { hour: "numeric" });
    return long ? `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${hour}` : hour;
  }
  return date.toLocaleDateString("en-US", long ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" });
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function niceMax(value: number) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

function truncate(text: string, max = 90) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── Layout primitives ─────────────────────────────────────────────────

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function Panel({
  title,
  subtitle,
  source,
  className = "",
  children
}: {
  title: string;
  subtitle?: string;
  source: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`dp-panel ${className}`}>
      <header className="dp-panel-head">
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </header>
      <div className="dp-panel-body">{children}</div>
      <footer className="dp-source">Source · {source}</footer>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="dp-empty">{children}</div>;
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="dp-tile">
      <span className="dp-tile-label">{label}</span>
      <span className="dp-tile-value">{value}</span>
      {hint && <span className="dp-tile-hint">{hint}</span>}
    </div>
  );
}

type Tip = { x: number; y: number; flip?: boolean; lines: string[] } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div className={`dp-tooltip ${tip.flip ? "flip" : ""}`} style={{ left: tip.x, top: tip.y }} role="status">
      {tip.lines.map((line, index) => (
        <div key={index} className={index === 0 ? "dp-tooltip-title" : undefined}>
          {line}
        </div>
      ))}
    </div>
  );
}

// ── Charts ─────────────────────────────────────────────────────────────

type Column = { key: string; label: string; value: number; tooltip: string[] };

function ColumnChart({ columns, height = 200, ariaLabel }: { columns: Column[]; height?: number; ariaLabel: string }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [tip, setTip] = useState<Tip>(null);

  const padLeft = 36;
  const padBottom = 24;
  const padTop = 8;
  const plotWidth = Math.max(0, width - padLeft);
  const plotHeight = height - padBottom - padTop;
  const max = niceMax(Math.max(0, ...columns.map((column) => column.value)));
  const ticks = Number.isInteger(max / 2) ? [0, max / 2, max] : [0, max];
  const band = columns.length ? plotWidth / columns.length : 0;
  const barWidth = Math.max(2, Math.min(24, band - 2));
  const labelEvery = Math.max(1, Math.ceil(56 / Math.max(band, 1)));

  return (
    <div className="dp-chart" ref={ref} onMouseLeave={() => { setHover(null); setTip(null); }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          {ticks.map((tick) => {
            const y = padTop + plotHeight - (tick / max) * plotHeight;
            return (
              <g key={tick}>
                <line className="dp-gridline" x1={padLeft} x2={width} y1={y} y2={y} />
                <text className="dp-axis" x={padLeft - 8} y={y} dy="0.32em" textAnchor="end">
                  {formatCount(tick)}
                </text>
              </g>
            );
          })}
          {columns.map((column, index) => {
            const barHeight = (column.value / max) * plotHeight;
            const x = padLeft + index * band + (band - barWidth) / 2;
            const y = padTop + plotHeight - barHeight;
            const radius = Math.min(4, barWidth / 2, barHeight);
            return (
              <g key={column.key}>
                {barHeight > 0 && (
                  <path
                    className={`dp-bar ${hover === index ? "is-hover" : ""}`}
                    d={`M${x},${y + barHeight} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + barWidth - radius} Q${x + barWidth},${y} ${x + barWidth},${y + radius} V${y + barHeight} Z`}
                  />
                )}
                {index % labelEvery === 0 && (
                  <text className="dp-axis" x={x + barWidth / 2} y={height - 6} textAnchor="middle">
                    {column.label}
                  </text>
                )}
                <rect
                  className="dp-hit"
                  x={padLeft + index * band}
                  y={padTop}
                  width={band}
                  height={plotHeight}
                  onMouseMove={(event) => {
                    const box = ref.current!.getBoundingClientRect();
                    setHover(index);
                    setTip({ x: event.clientX - box.left, y: event.clientY - box.top, flip: event.clientX - box.left > box.width / 2, lines: column.tooltip });
                  }}
                />
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

type BarRow = { key: string; label: string; note?: string; value: number; display: string; tooltip: string[] };

function BarList({ rows }: { rows: BarRow[] }) {
  const [tip, setTip] = useState<Tip>(null);
  const ref = useRef<HTMLDivElement>(null);
  const max = Math.max(0, ...rows.map((row) => row.value)) || 1;
  return (
    <div className="dp-barlist" ref={ref} onMouseLeave={() => setTip(null)}>
      {rows.map((row) => (
        <div
          key={row.key}
          className="dp-barrow"
          onMouseMove={(event) => {
            const box = ref.current!.getBoundingClientRect();
            setTip({ x: event.clientX - box.left, y: event.clientY - box.top, flip: event.clientX - box.left > box.width / 2, lines: row.tooltip });
          }}
        >
          <span className="dp-barrow-label">
            {row.label}
            {row.note && <small>{row.note}</small>}
          </span>
          <span className="dp-barrow-track">
            <span className="dp-barrow-fill" style={{ width: `${(row.value / max) * 100}%` }} />
            <span className="dp-barrow-value">{row.display}</span>
          </span>
        </div>
      ))}
      <Tooltip tip={tip} />
    </div>
  );
}

function TokenBars({ models }: { models: DataResponse["models"] }) {
  const [tip, setTip] = useState<Tip>(null);
  const ref = useRef<HTMLDivElement>(null);
  const max = Math.max(0, ...models.map((model) => model.inputTokens + model.outputTokens)) || 1;
  return (
    <div className="dp-barlist" ref={ref} onMouseLeave={() => setTip(null)}>
      <div className="dp-legend" aria-hidden="true">
        <span><i className="dp-swatch s1" /> Input tokens</span>
        <span><i className="dp-swatch s2" /> Output tokens</span>
      </div>
      {models.map((model) => {
        const total = model.inputTokens + model.outputTokens;
        return (
          <div
            key={model.model}
            className="dp-barrow stacked"
            onMouseMove={(event) => {
              const box = ref.current!.getBoundingClientRect();
              setTip({
                x: event.clientX - box.left,
                y: event.clientY - box.top,
                flip: event.clientX - box.left > box.width / 2,
                lines: [
                  model.model,
                  `Input: ${integer.format(model.inputTokens)} tokens`,
                  `Output: ${integer.format(model.outputTokens)} tokens`,
                  `${integer.format(model.calls)} calls · ${formatCost(model.totalCost)}`
                ]
              });
            }}
          >
            <span className="dp-barrow-label">
              {model.model}
              <small>
                {integer.format(model.calls)} calls · {formatCost(model.totalCost)}
              </small>
            </span>
            <span className="dp-barrow-track">
              <span className="dp-stack" style={{ width: `${(total / max) * 100}%` }}>
                <span className="dp-seg s1" style={{ flexGrow: model.inputTokens }} />
                <span className="dp-seg s2" style={{ flexGrow: model.outputTokens }} />
              </span>
              <span className="dp-barrow-value">
                {formatCount(model.inputTokens)} in · {formatCount(model.outputTokens)} out
              </span>
            </span>
          </div>
        );
      })}
      <Tooltip tip={tip} />
    </div>
  );
}

function SignalBadge({ kind }: { kind: SignalKind }) {
  return (
    <span className={`dp-badge ${kind}`}>
      <span aria-hidden="true">{kind === "context-correction" ? "↻" : "!"}</span>
      {SIGNAL_LABELS[kind].label}
    </span>
  );
}

// ── Page ───────────────────────────────────────────────────────────────

export function DataPage() {
  const [range, setRange] = useState<DataRange>("7d");
  const [data, setData] = useState<DataResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);

  const load = useCallback(async (nextRange: DataRange, refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/data?range=${nextRange}${refresh ? "&refresh=1" : ""}`);
      if (!response.ok) throw new Error(await response.text());
      setData((await response.json()) as DataResponse);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Data · Dad IT Support Agent";
    void load(range);
  }, [load, range]);

  const langfuseLink = (path: string) =>
    data?.projectId ? `${data.langfuseBaseUrl}/project/${data.projectId}/${path}` : undefined;

  return (
    <div className="data-page">
      <TopBar active="data" />
      <main className="dp-main">
        <div className="dp-heading">
          <div>
            <span className="dp-eyebrow">// analytics</span>
            <h1>How Dad uses Specs</h1>
            <p>Every chat turn is traced to Langfuse. This page reads it back through the Langfuse public API.</p>
          </div>
          <div className="dp-controls">
            <div className="dp-segmented" role="group" aria-label="Time range">
              {RANGES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={range === option.value}
                  onClick={() => setRange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button className="dp-refresh" type="button" onClick={() => {
                void load(range, true);
                setRefreshToken((token) => token + 1);
              }} disabled={loading}>
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>

        {error && <div className="dp-error">{error}</div>}

        {data && (
          <div className={`dp-content ${loading ? "is-loading" : ""}`}>
            <div className="dp-tiles">
              <StatTile label="Sessions" value={formatCount(data.totals.sessions)} hint={`${data.totals.users} user${data.totals.users === 1 ? "" : "s"}`} />
              <StatTile label="Chat turns" value={formatCount(data.totals.turns)} hint="one per message Dad sends" />
              <StatTile
                label="Turns per session"
                value={data.totals.avgTurnsPerSession === null ? "—" : data.totals.avgTurnsPerSession.toFixed(1)}
                hint="average"
              />
              <StatTile label="Model cost" value={formatCost(data.totals.totalCost)} hint={`${formatCount(data.totals.modelCalls)} model calls`} />
              <StatTile
                label="Tokens"
                value={formatCount(data.totals.inputTokens + data.totals.outputTokens)}
                hint={`${formatCount(data.totals.inputTokens)} in · ${formatCount(data.totals.outputTokens)} out`}
              />
              <StatTile
                label="Turn latency"
                value={formatLatency(data.totals.p50TurnLatencyMs)}
                hint={`median · p95 ${formatLatency(data.totals.p95TurnLatencyMs)}`}
              />
            </div>
          </div>
        )}
        {!data && loading && <div className="dp-panel dp-insights-loading">Loading usage data from Langfuse…</div>}

        {/* Each section loads on its own so one slow source never blanks the page. */}
        <QualityLoop range={range} refreshToken={refreshToken} />
        <RequestInsights range={range} refreshToken={refreshToken} />

        {data && (
          <div className={`dp-content ${loading ? "is-loading" : ""}`}>
            <div className="dp-section-head">
              <div>
                <h2>Usage & performance</h2>
                <p>Traffic, cost, latency and conversation signals, straight from the Langfuse Metrics and Observations APIs.</p>
              </div>
            </div>

            <div className="dp-grid">
              <Panel
                className="span-2"
                title="Chat turns over time"
                subtitle={`Messages Dad sent, per ${data.granularity}. Hover a column for cost.`}
                source="Observations API · agent turns bucketed by start time"
              >
                {data.totals.turns === 0 ? (
                  <Empty>No chat turns in this range yet.</Empty>
                ) : (
                  <ColumnChart
                    ariaLabel="Chat turns over time"
                    columns={data.turnsOverTime.map((row) => ({
                      key: row.time,
                      label: formatBucket(row.time, data.granularity),
                      value: row.turns,
                      tooltip: [
                        formatBucket(row.time, data.granularity, true),
                        `${integer.format(row.turns)} turn${row.turns === 1 ? "" : "s"}`,
                        `${formatCost(row.cost)} model cost`
                      ]
                    }))}
                  />
                )}
              </Panel>

              <Panel
                title="Conversation length"
                subtitle="Sessions by number of turns"
                source="Observations API · agent turns grouped by sessionId"
              >
                {data.totals.sessions === 0 ? (
                  <Empty>No sessions yet.</Empty>
                ) : (
                  <ColumnChart
                    ariaLabel="Sessions by number of turns"
                    columns={data.sessionDepth.map((row) => ({
                      key: row.bucket,
                      label: `${row.bucket} turn${row.bucket === "1" ? "" : "s"}`,
                      value: row.sessions,
                      tooltip: [`${row.bucket} turn${row.bucket === "1" ? "" : "s"}`, `${row.sessions} session${row.sessions === 1 ? "" : "s"}`]
                    }))}
                  />
                )}
              </Panel>

              <Panel
                title="Conversation signals"
                subtitle="Keyword heuristics on Dad's messages, a preview of the step 04 monitoring evaluators"
                source="Observations API · user messages, matched in this app"
              >
                <ul className="dp-signals">
                  {data.signals.map((signal) => (
                    <li key={signal.kind}>
                      <SignalBadge kind={signal.kind} />
                      <span className="dp-signal-desc">{SIGNAL_LABELS[signal.kind].description}</span>
                      <span className="dp-signal-count">{integer.format(signal.count)}</span>
                    </li>
                  ))}
                </ul>
                <p className="dp-note">
                  {data.totals.turns > 0
                    ? `${Math.round((data.totals.flaggedTurns / Math.max(1, data.totals.turns)) * 100)}% of turns flagged. See the messages below.`
                    : "Nothing to flag yet."}
                </p>
              </Panel>

              <Panel
                className="span-2"
                title="Models, tokens, cost"
                subtitle="Token usage per model, split into input and output"
                source="Observations API · generations in chat turns, grouped by model"
              >
                {data.models.length === 0 ? <Empty>No model calls yet.</Empty> : <TokenBars models={data.models} />}
              </Panel>

              <Panel
                className="span-3"
                title="Agent steps"
                subtitle="What runs inside a turn, and how long it takes"
                source="Observations API · observations in chat turns, grouped by type and name"
              >
                {data.steps.length === 0 ? (
                  <Empty>No observations yet.</Empty>
                ) : (
                  <table className="dp-table">
                    <thead>
                      <tr>
                        <th>Step</th>
                        <th className="num">Calls</th>
                        <th className="num">Per turn</th>
                        <th className="num">p50</th>
                        <th className="num">p95</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.steps.map((step) => (
                        <tr key={`${step.type}-${step.name}`}>
                          <td>
                            <span className="dp-step-name">{step.name}</span>
                            <span className="dp-type">{step.type.toLowerCase()}</span>
                          </td>
                          <td className="num">{integer.format(step.count)}</td>
                          <td className="num">{data.totals.turns ? (step.count / data.totals.turns).toFixed(1) : "—"}</td>
                          <td className="num">{formatLatency(step.p50LatencyMs)}</td>
                          <td className="num">{formatLatency(step.p95LatencyMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>

              <Panel
                className="span-3"
                title="Scores"
                subtitle="Evaluator, annotation and API scores attached to traces"
                source="Metrics API · scores-numeric and scores-categorical views"
              >
                {data.scoresNotice ? (
                  <Empty>{data.scoresNotice}</Empty>
                ) : data.scores.length === 0 ? (
                  <Empty>
                    No scores in this range. Once you set up the LLM-as-a-judge evaluators from step 04 (Monitoring), or add scores through the SDK,
                    their averages and value counts show up here.
                  </Empty>
                ) : (
                  <table className="dp-table">
                    <thead>
                      <tr>
                        <th>Score</th>
                        <th>Type</th>
                        <th className="num">Count</th>
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.scores.map((score) => (
                        <tr key={`${score.dataType}-${score.name}`}>
                          <td>{score.name}</td>
                          <td className="dp-type">{score.dataType.toLowerCase()}</td>
                          <td className="num">{integer.format(score.count)}</td>
                          <td>
                            {score.dataType === "NUMERIC"
                              ? `avg ${score.average === null ? "—" : score.average.toFixed(2)}`
                              : score.values
                                  .sort((a, b) => b.count - a.count)
                                  .map((value) => `${value.value} ${value.count}`)
                                  .join(" · ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>

              <Panel
                className="span-3"
                title="Flagged messages"
                subtitle="Most recent messages that tripped a signal. Open the trace to see what the agent answered."
                source="Observations API · user messages, matched in this app"
              >
                {data.flagged.length === 0 ? (
                  <Empty>No flagged messages in this range.</Empty>
                ) : (
                  <table className="dp-table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Message</th>
                        <th>Signals</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.flagged.map((item) => (
                        <tr key={item.traceId}>
                          <td className="dp-nowrap">{formatDateTime(item.time)}</td>
                          <td className="dp-quote">“{item.message}”</td>
                          <td>
                            <span className="dp-badges">
                              {item.kinds.map((kind) => (
                                <SignalBadge key={kind} kind={kind} />
                              ))}
                            </span>
                          </td>
                          <td className="num">
                            {langfuseLink(`traces/${item.traceId}`) && (
                              <a href={langfuseLink(`traces/${item.traceId}`)} target="_blank" rel="noreferrer">
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

              <Panel
                className="span-3"
                title="Recent sessions"
                subtitle="One row per conversation, newest first"
                source="Observations API · agent turns and generations grouped by sessionId"
              >
                {data.sessions.length === 0 ? (
                  <Empty>No sessions yet. Chat with Specs and refresh.</Empty>
                ) : (
                  <table className="dp-table">
                    <thead>
                      <tr>
                        <th>Last active</th>
                        <th className="num">Turns</th>
                        <th>First question</th>
                        <th>Last message</th>
                        <th className="num">Cost</th>
                        <th>Signals</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sessions.map((session) => {
                        const isRealSession = !session.sessionId.startsWith("trace:");
                        const link = isRealSession ? langfuseLink(`sessions/${encodeURIComponent(session.sessionId)}`) : undefined;
                        return (
                          <tr key={session.sessionId}>
                            <td className="dp-nowrap">{formatDateTime(session.lastSeen)}</td>
                            <td className="num">{session.turns}</td>
                            <td>{truncate(session.firstQuestion || "—", 70)}</td>
                            <td>{session.turns > 1 ? truncate(session.lastQuestion, 70) : <span className="dp-muted">same</span>}</td>
                            <td className="num">{formatCost(session.totalCost)}</td>
                            <td>
                              <span className="dp-badges">
                                {session.signals.length ? session.signals.map((kind) => <SignalBadge key={kind} kind={kind} />) : <span className="dp-muted">—</span>}
                              </span>
                            </td>
                            <td className="num">
                              {link && (
                                <a href={link} target="_blank" rel="noreferrer">
                                  Session ↗
                                </a>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </Panel>
            </div>

            <footer className="dp-footer">
              <p>
                Updated {formatDateTime(data.generatedAt)}. Usage numbers are computed from raw chat-turn, generation and tool observations
                (Langfuse Observations API){data.truncated ? ", capped to the most recent observations" : ""}. Scores come from the Metrics API,
                which has a daily request limit on smaller plans, so they are cached for 10 minutes. Langfuse can take a few minutes to show new
                traces; the server caches results for 30 seconds, so use Refresh to re-query.
              </p>
            </footer>
          </div>
        )}
      </main>
    </div>
  );
}
