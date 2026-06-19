import { useMemo, useState, type FormEvent } from "react";
import type { AgentRecord, ClaudeSession, GitStatus } from "../lib/tauri";
import type { CliDef } from "../lib/clis";

function fmtAgo(unix: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Middle column: the project's agents (live + history), the new-agent launcher,
// and navigation between them.
export default function AgentsColumn({
  agents,
  archived,
  live,
  waiting,
  rateLimited,
  states,
  clis,
  activeAgentId,
  git,
  sessions,
  editCounts,
  onSelect,
  onNew,
  onResume,
  onClose,
  onArchive,
  onDelete,
  onUnarchive,
  onContinueSession,
  onRename,
  onHome,
  homeActive = false,
  projectName,
}: {
  agents: AgentRecord[];
  archived: AgentRecord[];
  live: Set<string>;
  /** Agent ids currently blocking on user input. */
  waiting: Set<string>;
  /** Agents blocked on a usage/session limit → message + reset epoch-ms (null
   * when the reset time couldn't be parsed). */
  rateLimited: Record<string, { message: string; resetAt: number | null }>;
  /** Helper-judge classification per agent (working/passive/active). */
  states: Record<string, "working" | "passive" | "active">;
  /** Enabled, configured launchable agents. */
  clis: CliDef[];
  activeAgentId: string | null;
  git: GitStatus | null;
  /** Past Claude sessions NOT already running in this window. */
  sessions: ClaudeSession[];
  /** Edited-file count per agent id. */
  editCounts: Record<string, number>;
  onSelect: (id: string) => void;
  onNew: (title: string, command: string) => void;
  onResume: (rec: AgentRecord) => void;
  onClose: (id: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onUnarchive: (id: string) => void;
  onContinueSession: (s: ClaudeSession) => void;
  onRename: (id: string, title: string) => void;
  /** Go to the project overview/home page. */
  onHome?: () => void;
  /** Whether the overview/home page is currently showing. */
  homeActive?: boolean;
  /** Current project name (shown on the home button). */
  projectName?: string;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [showOffline, setShowOffline] = useState(false);
  const [title, setTitle] = useState("");
  const [command, setCommand] = useState("");
  const [adding, setAdding] = useState(false);

  // Live agents float to the top, ranked by urgency (needs-you, then working,
  // then idle), and within a rank by when they first started — so a long-running
  // worker that drifted to the bottom climbs back up. Stopped (offline) agents
  // drop into a compacted, collapsed section so the live ones stay front-and-center.
  const { liveAgents, offlineAgents } = useMemo(() => {
    const liveAgents: AgentRecord[] = [];
    const offlineAgents: AgentRecord[] = [];
    for (const a of agents) (live.has(a.id) ? liveAgents : offlineAgents).push(a);
    const rank = (a: AgentRecord) =>
      waiting.has(a.id) ? 0 : states[a.id] === "passive" ? 2 : 1;
    liveAgents.sort((a, b) => rank(a) - rank(b) || a.created_at - b.created_at);
    return { liveAgents, offlineAgents };
  }, [agents, live, waiting, states]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onNew(title.trim(), command.trim());
    setTitle("");
    setCommand("");
    setAdding(false);
  };

  return (
    <div className="agents">
      {onHome && (
        <button
          className={`agents-home ${homeActive ? "active" : ""}`}
          onClick={onHome}
          title={projectName ? `${projectName} — overview & tasks` : "Project overview & tasks"}
        >
          <span className="agents-home-icon">⌂</span>
          <span className="agents-home-name">Project home</span>
        </button>
      )}
      <div className="agents-head">
        <span>Agents</span>
        {git?.is_repo && git.dirty > 0 && (
          <span className="agents-dirty" title={`${git.dirty} changed`}>
            ●{git.dirty}
          </span>
        )}
      </div>

      <ul className="agents-list">
        {liveAgents.map((a) => {
          const isLive = true;
          const isWaiting = waiting.has(a.id);
          const rl = rateLimited[a.id];
          const isPassive = !isWaiting && !rl && states[a.id] === "passive";
          const isWorking = !isWaiting && !rl && !isPassive;
          const resumeAt =
            rl?.resetAt != null
              ? new Date(rl.resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : null;
          return (
            <li key={a.id}>
              <div
                className={`agent-item ${a.id === activeAgentId ? "active" : ""} ${
                  isWaiting ? "waiting" : ""
                }`}
                onClick={() => onSelect(a.id)}
              >
                <span
                  className={`dot ${
                    isWaiting ? "dot-wait" : isLive ? "dot-live" : "dot-dead"
                  }`}
                  title={isWaiting ? "Waiting for your input" : undefined}
                />
                <div className="agent-meta">
                  <div className="agent-title">
                    <span
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        const name = window.prompt("Rename agent", a.title);
                        if (name && name.trim()) onRename(a.id, name.trim());
                      }}
                      title="Double-click to rename"
                    >
                      {a.title}
                    </span>
                    {isWaiting && (
                      <span className="agent-wait-pill" title="Actively waiting — needs your input">
                        needs you
                      </span>
                    )}
                    {rl && (
                      <span
                        className="agent-rl-pill"
                        title={
                          rl.message +
                          (resumeAt ? ` — auto-continues ~${resumeAt}` : " — reset time unknown")
                        }
                      >
                        {resumeAt ? `rate-limited · resumes ${resumeAt}` : "rate-limited"}
                      </span>
                    )}
                    {isWorking && (
                      <span className="agent-work-pill" title="Working — producing output">
                        working
                      </span>
                    )}
                    {isPassive && (
                      <span className="agent-idle-pill" title="Idle at its prompt — nothing required">
                        idle
                      </span>
                    )}
                  </div>
                  <div className="agent-sub">
                    <span className="agent-cmd">{a.command}</span>
                    {editCounts[a.id] > 0 && (
                      <span
                        className="agent-edits"
                        title={`${editCounts[a.id]} file${editCounts[a.id] === 1 ? "" : "s"} edited by this agent`}
                      >
                        ✎{editCounts[a.id]}
                      </span>
                    )}
                    <span className="agent-ago">{fmtAgo(a.created_at)} ago</span>
                  </div>
                </div>
                <div className="agent-actions">
                  {isLive ? (
                    <button
                      className="agent-x"
                      title="Stop agent"
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(a.id);
                      }}
                    >
                      ✕
                    </button>
                  ) : (
                    <button
                      className="agent-resume"
                      title="Resume (relaunch + continue)"
                      onClick={(e) => {
                        e.stopPropagation();
                        onResume(a);
                      }}
                    >
                      ↻
                    </button>
                  )}
                  <button
                    className="agent-extra"
                    title="Archive"
                    onClick={(e) => {
                      e.stopPropagation();
                      onArchive(a.id);
                    }}
                  >
                    ⊟
                  </button>
                  <button
                    className="agent-extra del"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(a.id);
                    }}
                  >
                    🗑
                  </button>
                </div>
              </div>
            </li>
          );
        })}
        {agents.length === 0 && <li className="agents-empty">No agents yet</li>}
        {liveAgents.length === 0 && offlineAgents.length > 0 && (
          <li className="agents-empty">No agents running</li>
        )}
      </ul>

      {offlineAgents.length > 0 && (
        <div className="offline-section">
          <button className="offline-head" onClick={() => setShowOffline((s) => !s)}>
            {showOffline ? "▾" : "▸"} Offline ({offlineAgents.length})
          </button>
          {showOffline && (
            <ul className="offline-list">
              {offlineAgents.map((a) => (
                <li key={a.id} className="offline-item">
                  <span className="dot dot-dead" />
                  <button
                    className="offline-title"
                    title={`${a.title} — click to resume`}
                    onClick={() => onSelect(a.id)}
                  >
                    {a.title}
                  </button>
                  <span className="offline-ago">{fmtAgo(a.created_at)}</span>
                  <button
                    className="agent-resume"
                    title="Resume (relaunch + continue)"
                    onClick={(e) => {
                      e.stopPropagation();
                      onResume(a);
                    }}
                  >
                    ↻
                  </button>
                  <button
                    className="agent-extra"
                    title="Archive"
                    onClick={(e) => {
                      e.stopPropagation();
                      onArchive(a.id);
                    }}
                  >
                    ⊟
                  </button>
                  <button
                    className="agent-extra del"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(a.id);
                    }}
                  >
                    🗑
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {adding ? (
        <div className="agent-new">
          <div className="cli-quick">
            {clis.map((c) => (
              <button
                key={c.id}
                className="cli-btn"
                onClick={() => {
                  onNew(c.label, c.command);
                  setAdding(false);
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
          <form className="agent-new-custom" onSubmit={submit}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="custom title"
            />
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="custom command"
            />
            <div className="agent-new-actions">
              <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button type="submit" className="btn">
                Launch
              </button>
            </div>
          </form>
        </div>
      ) : (
        <button className="agents-add" onClick={() => setAdding(true)}>
          + New session
        </button>
      )}

      {archived.length > 0 && (
        <div className="archived-section">
          <button
            className="archived-head"
            onClick={() => setShowArchived((s) => !s)}
          >
            {showArchived ? "▾" : "▸"} Archived ({archived.length})
          </button>
          {showArchived && (
            <ul className="archived-list">
              {archived.map((a) => (
                <li key={a.id} className="archived-item">
                  <span className="archived-title" title={a.title}>
                    {a.title}
                  </span>
                  <button
                    className="agent-extra"
                    title="Unarchive"
                    onClick={() => onUnarchive(a.id)}
                  >
                    ⤴
                  </button>
                  <button
                    className="agent-extra del"
                    title="Delete"
                    onClick={() => onDelete(a.id)}
                  >
                    🗑
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {sessions.length > 0 && (
        <div className="resume-section">
          <div className="resume-head">Continue previous session</div>
          <ul className="resume-list">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  className="resume-item"
                  onClick={() => onContinueSession(s)}
                  title={s.summary}
                >
                  <span className="resume-title">{s.summary}</span>
                  <span className="resume-meta">
                    {s.model && <span className="resume-model">{s.model}</span>}
                    <span>{fmtAgo(s.modified)} ago</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
