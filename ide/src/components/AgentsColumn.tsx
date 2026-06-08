import { useState, type FormEvent } from "react";
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
}: {
  agents: AgentRecord[];
  archived: AgentRecord[];
  live: Set<string>;
  /** Agent ids currently blocking on user input. */
  waiting: Set<string>;
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
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [title, setTitle] = useState("");
  const [command, setCommand] = useState("");
  const [adding, setAdding] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onNew(title.trim(), command.trim());
    setTitle("");
    setCommand("");
    setAdding(false);
  };

  return (
    <div className="agents">
      <div className="agents-head">
        <span>Agents</span>
        {git?.is_repo && git.dirty > 0 && (
          <span className="agents-dirty" title={`${git.dirty} changed`}>
            ●{git.dirty}
          </span>
        )}
      </div>

      <ul className="agents-list">
        {agents.map((a) => {
          const isLive = live.has(a.id);
          const isWaiting = waiting.has(a.id);
          const isPassive = !isWaiting && isLive && states[a.id] === "passive";
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
      </ul>

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
