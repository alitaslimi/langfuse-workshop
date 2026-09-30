import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DataRange, InsightRecommendation, InsightsResponse, RequestCategory } from "../shared/types";

const KIND_LABELS: Record<InsightRecommendation["kind"], string> = {
  expand_category: "Expand a category",
  add_guide: "Add a help guide",
  improve_answers: "Clearer answers",
  replace_starter: "Refresh starter prompt"
};

const CATEGORY_SHORT: Record<RequestCategory, string> = {
  diagnosis: "Diagnosis",
  os_settings: "iOS & settings",
  apps: "Apps",
  connectivity: "Connectivity",
  hardware: "Hardware",
  accounts_privacy: "Accounts & privacy",
  out_of_scope: "Out of scope"
};

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function formatDate(iso: string) {
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

function CategoryBars({ data }: { data: InsightsResponse }) {
  const rows = data.categories.filter((category) => category.sessions > 0 || category.requests > 0);
  const max = Math.max(1, ...rows.map((row) => row.sessions));
  const [tip, setTip] = useState<{ x: number; y: number; flip: boolean; lines: string[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  if (rows.length === 0) return <div className="dp-empty">No requests labeled yet.</div>;
  return (
    <div className="dp-barlist" ref={ref} onMouseLeave={() => setTip(null)}>
      {rows.map((row) => (
        <div
          key={row.category}
          className="dp-barrow"
          onMouseMove={(event) => {
            const box = ref.current!.getBoundingClientRect();
            setTip({
              x: event.clientX - box.left,
              y: event.clientY - box.top,
              flip: event.clientX - box.left > box.width / 2,
              lines: [
                row.label,
                `${plural(row.sessions, "session")} mainly about this`,
                `${plural(row.requests, "request")} · ${plural(row.followUps, "follow-up")}`,
                `${plural(row.guides, "help guide")} · ${plural(row.starters, "starter prompt")}`
              ]
            });
          }}
        >
          <span className="dp-barrow-label">
            {row.label}
            <small>
              {plural(row.guides, "guide")} · {plural(row.starters, "starter")}
            </small>
          </span>
          <span className="dp-barrow-track">
            <span className="dp-barrow-fill" style={{ width: `${(row.sessions / max) * 100}%` }} />
            <span className="dp-barrow-value">
              {plural(row.sessions, "session")} · {plural(row.requests, "request")}
            </span>
          </span>
        </div>
      ))}
      {tip && (
        <div className={`dp-tooltip ${tip.flip ? "flip" : ""}`} style={{ left: tip.x, top: tip.y }} role="status">
          {tip.lines.map((line, index) => (
            <div key={index} className={index === 0 ? "dp-tooltip-title" : undefined}>
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RequestInsights({ range, refreshToken }: { range: DataRange; refreshToken: number }) {
  const [data, setData] = useState<InsightsResponse | null>(null);
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
        const response = await fetch(`/api/insights?range=${range}${refresh ? "&refresh=1" : ""}`);
        if (!response.ok) throw new Error(await response.text());
        const next = (await response.json()) as InsightsResponse;
        if (!cancelled) setData(next);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not load insights.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range, refreshToken]);

  return (
    <section className={`dp-insights ${loading && data ? "is-loading" : ""}`}>
      <div className="dp-section-head">
        <div>
          <h2>Request insights</h2>
          <p>
            An LLM labels each message Dad sends with a category and a task topic, then the counts below show what keeps coming up.
          </p>
        </div>
        <span className="dp-section-status">
          {loading
            ? "Labeling new requests…"
            : data
              ? `${plural(data.classifiedTurns, "turn")} labeled with ${data.model}${data.pendingTurns ? ` · ${data.pendingTurns} pending` : ""}`
              : ""}
        </span>
      </div>

      {error && <div className="dp-error">{error}</div>}
      {!data && loading && (
        <div className="dp-panel dp-insights-loading">
          Labeling Dad's requests. The first run labels every turn in the range and can take up to a minute; after that only new turns are
          labeled.
        </div>
      )}

      {data && (
        <div className="dp-grid">
          <Panel
            className="span-3"
            title="What to ship next"
            subtitle="Ranked by how many sessions each finding touches. Each one is backed by the counts shown."
          >
            {data.recommendations.length === 0 ? (
              <div className="dp-empty">No clear patterns yet. Recommendations appear once requests repeat across sessions.</div>
            ) : (
              <ol className="dp-recs">
                {data.recommendations.map((rec, index) => (
                  <li key={`${rec.kind}-${rec.title}`} className="dp-rec">
                    <div className="dp-rec-head">
                      <span className="dp-rec-rank">{index + 1}</span>
                      <span className={`dp-rec-kind ${rec.kind}`}>{KIND_LABELS[rec.kind]}</span>
                      <span className="dp-rec-evidence">
                        {plural(rec.sessions, "session")} · {plural(rec.requests, "request")}
                      </span>
                    </div>
                    <h3>{rec.title}</h3>
                    <p>{rec.detail}</p>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel
            className="span-2"
            title="What sessions are about"
            subtitle="Each session counted once, under the category of most of its requests, next to what the app covers today"
          >
            <CategoryBars data={data} />
          </Panel>

          <Panel title="Starter prompts" subtitle="How often the suggested questions match what Dad actually asks">
            <ul className="dp-starters">
              {data.starters.map((starter) => (
                <li key={starter.question}>
                  <div>
                    <div className="dp-starter-q">{starter.question}</div>
                    <div className="dp-starter-meta">
                      {CATEGORY_SHORT[starter.category]} · {starter.lastAsked ? `last asked ${formatDate(starter.lastAsked)}` : "not asked in range"}
                    </div>
                  </div>
                  <span className={`dp-pill ${starter.asked === 0 ? "warn" : ""}`}>
                    {starter.asked === 0 ? "Unused" : `${starter.asked}×`}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel
            className="span-3"
            title="Recurring requests"
            subtitle="Tasks grouped across sessions. Follow-ups are messages like “where is that?” after an answer."
          >
            {data.topics.length === 0 ? (
              <div className="dp-empty">No requests labeled yet.</div>
            ) : (
              <table className="dp-table">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Category</th>
                    <th className="num">Sessions</th>
                    <th className="num">Requests</th>
                    <th className="num">Follow-ups</th>
                    <th>Help guide</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topics.map((topic) => (
                    <tr key={topic.topic}>
                      <td>
                        <span className="dp-step-name">{topic.topic}</span>
                        {topic.isEmerging && <span className="dp-pill new">New</span>}
                        {topic.isStarter && <span className="dp-pill">Starter</span>}
                        {topic.examples[0] && <div className="dp-example">“{topic.examples[0]}”</div>}
                      </td>
                      <td className="dp-nowrap">
                        {CATEGORY_SHORT[topic.category]}
                        {topic.app && <span className="dp-type"> · {topic.app}</span>}
                      </td>
                      <td className="num">{topic.sessions}</td>
                      <td className="num">{topic.requests}</td>
                      <td className="num">{topic.followUps || "—"}</td>
                      <td>{topic.guideTitle ?? <span className="dp-pill warn">No guide</span>}</td>
                      <td className="dp-nowrap">{formatDate(topic.lastSeen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      )}
      <p className="dp-source dp-source-inline">
        Source · Observations API (agent-turn inputs) → LLM labels cached in .data/request-insights.json. Classifier calls are traced in Langfuse
        as “request-insights”.
      </p>
    </section>
  );
}
