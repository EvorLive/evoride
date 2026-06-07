import { useCallback, useEffect, useState } from "react";
import Markdown from "./Markdown";
import * as api from "../lib/tauri";
import type { AgentRecord, Project } from "../lib/tauri";

// Accept / Yes / No / Open action buttons shared by the agent rows. Lets the
// user respond to a waiting agent without entering its project.
function AgentActions({
  agent,
  waiting,
  onAccept,
  onYes,
  onNo,
  onOpen,
}: {
  agent: AgentRecord;
  waiting: boolean;
  onAccept: (id: string) => void;
  onYes: (id: string) => void;
  onNo: (id: string) => void;
  onOpen: (agent: AgentRecord) => void;
}) {
  return (
    <div className="home-actions">
      {waiting && (
        <>
          <button className="btn-sm" onClick={() => onAccept(agent.id)} title="Send Enter">
            Accept
          </button>
          <button className="btn-sm" onClick={() => onYes(agent.id)} title="Send y + Enter">
            Yes
          </button>
          <button className="btn-sm" onClick={() => onNo(agent.id)} title="Send n + Enter">
            No
          </button>
        </>
      )}
      <button className="btn-ghost" onClick={() => onOpen(agent)} title="Open in workspace">
        Open
      </button>
    </div>
  );
}

// Top-level dashboard across every project: projects, all active agents, who's
// waiting for input, and today's derived activity summary.
export default function HomeView({
  projects,
  runningList,
  waitingAgents,
  runningByProject,
  waitingProjects,
  onOpenProject,
  onOpenAgent,
  onAccept,
  onYes,
  onNo,
}: {
  projects: Project[];
  runningList: AgentRecord[];
  waitingAgents: Set<string>;
  runningByProject: Record<string, number>;
  waitingProjects: Set<string>;
  onOpenProject: (p: Project) => void;
  onOpenAgent: (agent: AgentRecord) => void;
  onAccept: (id: string) => void;
  onYes: (id: string) => void;
  onNo: (id: string) => void;
}) {
  const [summary, setSummary] = useState<string>("");
  const [dailyOn, setDailyOn] = useState(true);

  const projectName = useCallback(
    (id: string) => projects.find((p) => p.id === id)?.name ?? "Unknown project",
    [projects],
  );

  // Load the daily-summary preference + today's summary on mount.
  useEffect(() => {
    api
      .getSettings()
      .then((s) => setDailyOn(s.daily_summary))
      .catch(() => {});
  }, []);

  const refreshSummary = useCallback(() => {
    api
      .dailySummary()
      .then(setSummary)
      .catch(() => setSummary(""));
  }, []);

  // Re-derive the summary when the agent set changes (new sessions ⇒ new lines).
  useEffect(() => {
    refreshSummary();
  }, [refreshSummary, runningList.length]);

  const toggleDaily = () => {
    const next = !dailyOn;
    setDailyOn(next);
    api
      .setDailySummary(next)
      .then(() => refreshSummary())
      .catch(() => {});
  };

  // Agents currently waiting for the user, with their project resolved.
  const waitingList = runningList.filter((a) => waitingAgents.has(a.id));

  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-head">
          <h1>EvorIde</h1>
          <p className="home-sub">Your projects and agents at a glance.</p>
        </header>

        {waitingList.length > 0 && (
          <section className="home-section home-needs">
            <h2 className="home-h2">Needs your input</h2>
            <ul className="home-rows">
              {waitingList.map((a) => (
                <li key={a.id} className="home-row needs">
                  <span className="home-row-main">
                    <span className="home-proj">{projectName(a.project_id)}</span>
                    <span className="home-dot-sep">·</span>
                    <span className="home-title">{a.title}</span>
                    <span className="home-badge wait">waiting</span>
                  </span>
                  <AgentActions
                    agent={a}
                    waiting
                    onAccept={onAccept}
                    onYes={onYes}
                    onNo={onNo}
                    onOpen={onOpenAgent}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="home-grid">
          <section className="home-section">
            <h2 className="home-h2">Projects</h2>
            {projects.length === 0 ? (
              <p className="home-empty">No projects yet.</p>
            ) : (
              <ul className="home-cards">
                {projects.map((p) => {
                  const running = runningByProject[p.id] ?? 0;
                  const waiting = waitingProjects.has(p.id);
                  return (
                    <li key={p.id}>
                      <button className="home-card" onClick={() => onOpenProject(p)} title={p.path}>
                        <span className="home-card-name">{p.name}</span>
                        <span className="home-card-meta">
                          {running > 0 ? (
                            <span className="home-badge live">{running} running</span>
                          ) : (
                            <span className="home-card-idle">idle</span>
                          )}
                          {waiting && <span className="home-badge wait">waiting</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="home-section">
            <h2 className="home-h2">Active agents</h2>
            {runningList.length === 0 ? (
              <p className="home-empty">No agents are running.</p>
            ) : (
              <ul className="home-rows">
                {runningList.map((a) => {
                  const waiting = waitingAgents.has(a.id);
                  return (
                    <li key={a.id} className="home-row">
                      <span className="home-row-main">
                        <span className="home-proj">{projectName(a.project_id)}</span>
                        <span className="home-dot-sep">·</span>
                        <span className="home-title">{a.title}</span>
                        <span className={`home-badge ${waiting ? "wait" : "live"}`}>
                          {waiting ? "waiting" : a.status}
                        </span>
                      </span>
                      <AgentActions
                        agent={a}
                        waiting={waiting}
                        onAccept={onAccept}
                        onYes={onYes}
                        onNo={onNo}
                        onOpen={onOpenAgent}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <section className="home-section">
          <div className="home-today-head">
            <h2 className="home-h2">Today</h2>
            <label className="home-toggle" title="Generate a daily activity summary">
              <input type="checkbox" checked={dailyOn} onChange={toggleDaily} />
              Daily summaries
            </label>
          </div>
          {dailyOn ? (
            <div className="home-summary">
              {summary ? <Markdown text={summary} /> : <p className="home-empty">No activity yet today.</p>}
            </div>
          ) : (
            <p className="home-empty">Daily summaries are off.</p>
          )}
        </section>
      </div>
    </div>
  );
}
