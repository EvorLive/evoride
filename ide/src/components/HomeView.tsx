import { useCallback, useEffect, useState } from "react";
import Markdown from "./Markdown";
import * as api from "../lib/tauri";
import type { AgentRecord, Project } from "../lib/tauri";

/* ---- inline icons (no emoji as structural icons) ---- */
const Ic = {
  folder: (
    <svg viewBox="0 0 24 24" className="ic" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 24 24" className="ic" aria-hidden="true">
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" className="ic" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  arrow: (
    <svg viewBox="0 0 24 24" className="ic" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  ),
};

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// Top-level dashboard across every project: who needs you, your projects, the
// agents running, and today's activity.
export default function HomeView({
  projects,
  runningList,
  waitingAgents,
  waitingOptions,
  runningByProject,
  waitingProjects,
  onOpenProject,
  onOpenAgent,
  onAccept,
  onYes,
  onNo,
  onPick,
}: {
  projects: Project[];
  runningList: AgentRecord[];
  waitingAgents: Set<string>;
  /** Parsed numbered-menu choices per waiting agent id (empty for y/n). */
  waitingOptions: Record<string, string[]>;
  runningByProject: Record<string, number>;
  waitingProjects: Set<string>;
  onOpenProject: (p: Project) => void;
  onOpenAgent: (agent: AgentRecord) => void;
  onAccept: (id: string) => void;
  onYes: (id: string) => void;
  onNo: (id: string) => void;
  onPick: (id: string, n: number) => void;
}) {
  const [summary, setSummary] = useState<string>("");
  const [dailyOn, setDailyOn] = useState(true);
  const [aiSummary, setAiSummary] = useState<string>("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Show the previously-generated summary on (re)open — no need to click again.
  useEffect(() => {
    api.dailySummaryAiCached().then((c) => c && setAiSummary(c)).catch(() => {});
  }, []);

  const generateAi = () => {
    setAiBusy(true);
    setAiError(null);
    api
      .dailySummaryAi()
      .then(setAiSummary)
      .catch((e) => setAiError(String(e)))
      .finally(() => setAiBusy(false));
  };

  const projectName = useCallback(
    (id: string) => projects.find((p) => p.id === id)?.name ?? "Unknown project",
    [projects],
  );

  useEffect(() => {
    api.getSettings().then((s) => setDailyOn(s.daily_summary)).catch(() => {});
  }, []);

  const refreshSummary = useCallback(() => {
    api.dailySummary().then(setSummary).catch(() => setSummary(""));
  }, []);
  useEffect(() => {
    refreshSummary();
  }, [refreshSummary, runningList.length]);

  const toggleDaily = () => {
    const next = !dailyOn;
    setDailyOn(next);
    api.setDailySummary(next).then(() => refreshSummary()).catch(() => {});
  };

  const waitingList = runningList.filter((a) => waitingAgents.has(a.id));
  // Running but not waiting — the calm "active" list (waiting ones live in the hero).
  const activeList = runningList.filter((a) => !waitingAgents.has(a.id));

  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-head">
          <h1>{timeGreeting()}</h1>
          <p className="home-sub">
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
            {" · "}
            {projects.length} project{projects.length === 1 ? "" : "s"} ·{" "}
            {runningList.length} agent{runningList.length === 1 ? "" : "s"} running
          </p>
        </header>

        {/* Urgent when something needs you; calm when nothing does. */}
        {waitingList.length > 0 ? (
          <section className="home-alert" role="region" aria-label="Agents waiting for input">
            <div className="home-alert-head">
              <span className="home-alert-icon">{Ic.bell}</span>
              <span>
                {waitingList.length} agent{waitingList.length === 1 ? "" : "s"} need your input
              </span>
            </div>
            <ul className="home-rows">
              {waitingList.map((a) => {
                const opts = waitingOptions[a.id] ?? [];
                return (
                  <li key={a.id} className={`home-wrow ${opts.length > 0 ? "menu" : ""}`}>
                    <div className="home-wrow-meta">
                      <span className="home-title">{a.title}</span>
                      <span className="home-proj">{projectName(a.project_id)}</span>
                    </div>
                    {opts.length > 0 ? (
                      // A numbered select menu — offer its actual choices.
                      <div className="home-actions home-choices">
                        {opts.map((label, i) => (
                          <button
                            key={i}
                            className={`btn ${i === 0 ? "primary" : "btn-ghost"} home-choice`}
                            onClick={() => onPick(a.id, i + 1)}
                            title={`Send ${i + 1} + Enter`}
                          >
                            <span className="home-choice-n">{i + 1}</span>
                            <span className="home-choice-label">{label}</span>
                          </button>
                        ))}
                        <button className="btn-ghost" onClick={() => onOpenAgent(a)} title="Open in workspace">
                          Open {Ic.arrow}
                        </button>
                      </div>
                    ) : (
                      // A y/n or free-text prompt — generic quick replies.
                      <div className="home-actions">
                        <button className="btn primary" onClick={() => onAccept(a.id)} title="Send Enter">
                          Accept
                        </button>
                        <button className="btn-ghost" onClick={() => onYes(a.id)} title="Send y + Enter">
                          Yes
                        </button>
                        <button className="btn-ghost" onClick={() => onNo(a.id)} title="Send n + Enter">
                          No
                        </button>
                        <button className="btn-ghost" onClick={() => onOpenAgent(a)} title="Open in workspace">
                          Open {Ic.arrow}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <div className="home-allclear">
            <span className="home-allclear-icon">{Ic.check}</span>
            All caught up — no agents are waiting on you.
          </div>
        )}

        <section className="home-section">
          <h2 className="home-h2">Projects</h2>
          {projects.length === 0 ? (
            <p className="home-empty">No projects yet — open one to get started.</p>
          ) : (
            <ul className="home-cards">
              {projects.map((p) => {
                const running = runningByProject[p.id] ?? 0;
                const waiting = waitingProjects.has(p.id);
                return (
                  <li key={p.id}>
                    <button className="home-card" onClick={() => onOpenProject(p)} title={p.path}>
                      <span className="home-card-top">
                        <span className="home-card-folder">{Ic.folder}</span>
                        <span className="home-card-name">{p.name}</span>
                        {waiting && <span className="home-pill wait">waiting</span>}
                      </span>
                      <span className="home-card-path">{p.path}</span>
                      <span className="home-card-foot">
                        {running > 0 ? (
                          <span className="home-stat live">
                            <span className="home-dot live" /> {running} running
                          </span>
                        ) : (
                          <span className="home-stat idle">
                            <span className="home-dot idle" /> idle
                          </span>
                        )}
                        <span className="home-card-go">{Ic.arrow}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {activeList.length > 0 && (
          <section className="home-section">
            <h2 className="home-h2">Running agents</h2>
            <ul className="home-rows">
              {activeList.map((a) => (
                <li key={a.id} className="home-arow">
                  <span className="home-dot live" />
                  <span className="home-title">{a.title}</span>
                  <span className="home-proj">{projectName(a.project_id)}</span>
                  <button
                    className="btn-ghost home-arow-open"
                    onClick={() => onOpenAgent(a)}
                    title="Open in workspace"
                  >
                    Open {Ic.arrow}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="home-section">
          <div className="home-today-head">
            <h2 className="home-h2">Today</h2>
            <div className="home-today-actions">
              {dailyOn && (
                <button className="btn-ghost" onClick={generateAi} disabled={aiBusy}>
                  {aiBusy ? "Summarizing…" : "✨ Summarize with Claude"}
                </button>
              )}
              <label className="home-toggle" title="Generate a daily activity summary">
                <input type="checkbox" checked={dailyOn} onChange={toggleDaily} />
                <span>Daily summaries</span>
              </label>
            </div>
          </div>

          {dailyOn && aiSummary && (
            <div className="home-ai">
              <div className="home-ai-tag">✦ Claude’s recap</div>
              <Markdown text={aiSummary} />
            </div>
          )}
          {aiError && <p className="home-ai-err">Couldn’t generate: {aiError}</p>}

          <div className="home-summary">
            {!dailyOn ? (
              <p className="home-empty">Daily summaries are off.</p>
            ) : summary ? (
              <Markdown text={summary} />
            ) : (
              <p className="home-empty">No activity yet today.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
