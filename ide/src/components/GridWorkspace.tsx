import { useEffect, useState } from "react";
import AgentTerminal from "./AgentTerminal";
import type { CliDef } from "../lib/clis";
import type { AgentRecord, Project } from "../lib/tauri";

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

// A multi-terminal workspace: a responsive grid of live agent terminals, pinned
// from any project. Pull in a running agent or spawn a new one — all tiles render
// their xterm simultaneously (that's the point of this view).
interface Workspace {
  id: string;
  name: string;
  tiles: string[];
}

export default function GridWorkspace({
  tileIds,
  maxTiles,
  live,
  agentsById,
  projectsById,
  runningList,
  inactiveAgents,
  projects,
  clis,
  termMode,
  workspaces,
  activeWs,
  onSwitchWs,
  onNewWs,
  onCloseWs,
  onRenameWs,
  menu,
  onMenu,
  onAddRunning,
  onResumeToGrid,
  onSpawn,
  onRemoveTile,
  onAgentInput,
  onPopOut,
}: {
  tileIds: string[];
  maxTiles: number;
  /** Agent ids that currently have a live pty (vs. saved-but-stopped tiles). */
  live: Set<string>;
  agentsById: Record<string, AgentRecord>;
  projectsById: Record<string, Project>;
  runningList: AgentRecord[];
  inactiveAgents: AgentRecord[];
  projects: Project[];
  /** Enabled, configured launchable agents. */
  clis: CliDef[];
  /** Resolved IDE color mode for the tile terminals. */
  termMode: "light" | "dark";
  workspaces: Workspace[];
  activeWs: string;
  onSwitchWs: (id: string) => void;
  onNewWs: () => void;
  onCloseWs: (id: string) => void;
  onRenameWs: (id: string, name: string) => void;
  /** Which overlay is open ("pull"/"new") — controlled by the parent so the
   *  command palette can open it too. */
  menu: "pull" | "new" | null;
  onMenu: (m: "pull" | "new" | null) => void;
  onAddRunning: (id: string) => void;
  onResumeToGrid: (id: string) => void;
  onSpawn: (projectId: string, command: string, title: string) => void;
  onRemoveTile: (id: string) => void;
  /** User typed into a tile's terminal (clear its "needs you"). */
  onAgentInput?: (id: string) => void;
  /** Pop a tile's terminal out into its own window. */
  onPopOut?: (id: string) => void;
}) {
  const full = tileIds.length >= maxTiles;
  // Pull overlay is a two-step picker: project first, then agent.
  const [pullProject, setPullProject] = useState<string | null>(null);
  // Reset the project step whenever the pull overlay (re)opens.
  useEffect(() => {
    if (menu === "pull") setPullProject(null);
  }, [menu]);
  // New-agent draft: chosen project (defaults to the first project).
  const [newProject, setNewProject] = useState<string>(projects[0]?.id ?? "");

  const pinned = new Set(tileIds);
  const pullable = runningList.filter((a) => !pinned.has(a.id));

  const close = () => {
    onMenu(null);
    setPullProject(null);
  };
  const openPull = () => {
    setPullProject(null);
    onMenu("pull");
  };

  const projName = (id: string) =>
    projectsById[id]?.name ?? "Unknown project";

  // Group the pullable (running, not pinned) + inactive agents by project, so the
  // overlay can show projects first and the agents inside the one you pick.
  const byProject: Record<string, { running: AgentRecord[]; inactive: AgentRecord[] }> = {};
  for (const a of pullable) (byProject[a.project_id] ??= { running: [], inactive: [] }).running.push(a);
  for (const a of inactiveAgents) (byProject[a.project_id] ??= { running: [], inactive: [] }).inactive.push(a);
  const pullProjectIds = Object.keys(byProject).sort((x, y) =>
    projName(x).localeCompare(projName(y)),
  );

  const Toolbar = (
    <div className="grid-toolbar">
      <div className="grid-toolbar-title">
        <GridIcon />
        {/* Workspace tabs: switch, rename (double-click), close, add. */}
        <div className="ws-tabs">
          {workspaces.map((w) => (
            <span
              key={w.id}
              className={`ws-tab ${w.id === activeWs ? "active" : ""}`}
              onClick={() => onSwitchWs(w.id)}
              onDoubleClick={() => {
                const name = window.prompt("Rename workspace", w.name);
                if (name && name.trim()) onRenameWs(w.id, name.trim());
              }}
              title={`${w.name} · ${w.tiles.length}/${maxTiles}${w.id === activeWs ? "" : " — click to switch"}`}
            >
              {w.name}
              {workspaces.length > 1 && (
                <button
                  className="ws-tab-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseWs(w.id);
                  }}
                  title="Close workspace"
                  aria-label="Close workspace"
                >
                  ✕
                </button>
              )}
            </span>
          ))}
          <button className="ws-tab-add" onClick={onNewWs} title="New workspace">
            ＋
          </button>
        </div>
        <span className="grid-toolbar-count">
          {tileIds.length}/{maxTiles}
        </span>
      </div>
      <div className="grid-toolbar-actions">
        {/* Pull a running/inactive agent — opens the project→agent overlay. */}
        <button className="btn-ghost" onClick={openPull} disabled={full} title={full ? `Full (${maxTiles} max)` : undefined}>
          Pull agent ▾
        </button>

        {/* Spawn a fresh agent into any project. */}
        <div className="grid-pop-wrap">
          <button
            className="btn-ghost"
            onClick={() => onMenu(menu === "new" ? null : "new")}
            disabled={full}
            title={full ? `Full (${maxTiles} max)` : undefined}
          >
            ＋ New agent ▾
          </button>
          {menu === "new" && (
            <div className="grid-pop wide" onMouseLeave={close}>
              <div className="grid-pop-label">Project</div>
              <select
                className="grid-pop-select"
                value={newProject}
                onChange={(e) => setNewProject(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <div className="grid-pop-label">CLI</div>
              <div className="grid-pop-clis">
                {clis.map((c) => (
                  <button
                    key={c.id}
                    className="grid-pop-item"
                    disabled={!newProject}
                    onClick={() => {
                      if (!newProject) return;
                      onSpawn(newProject, c.command, c.label);
                      close();
                    }}
                  >
                    <span className="grid-pop-name">＋ {c.label}</span>
                    <span className="grid-pop-cmd">{c.command || "$SHELL"}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // Two-step "pull agent" overlay: pick a project, then an agent inside it.
  const pullOverlay = menu === "pull" && (
    <div className="pull-overlay" onClick={close} role="dialog" aria-modal="true">
      <div className="pull-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pull-head">
          {pullProject ? (
            <button className="pull-back" onClick={() => setPullProject(null)}>
              ‹ Projects
            </button>
          ) : (
            <span className="pull-title">Pull a terminal into the workspace</span>
          )}
          {pullProject && <span className="pull-crumb">{projName(pullProject)}</span>}
          <button className="pull-x" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="pull-body">
          {pullProjectIds.length === 0 ? (
            <div className="pull-empty">No other agents to pull. Spawn a new one instead.</div>
          ) : !pullProject ? (
            // Step 1 — projects that have pullable/inactive agents.
            <ul className="pull-list">
              {pullProjectIds.map((pid) => {
                const g = byProject[pid];
                return (
                  <li key={pid}>
                    <button className="pull-proj-row" onClick={() => setPullProject(pid)}>
                      <span className="pull-proj-name">{projName(pid)}</span>
                      <span className="pull-proj-counts">
                        {g.running.length > 0 && (
                          <span className="pull-badge live">{g.running.length} running</span>
                        )}
                        {g.inactive.length > 0 && (
                          <span className="pull-badge idle">{g.inactive.length} inactive</span>
                        )}
                      </span>
                      <span className="pull-chev">›</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            // Step 2 — agents inside the chosen project.
            <ul className="pull-list">
              {byProject[pullProject].running.map((a) => (
                <li key={a.id}>
                  <button
                    className="pull-agent-row"
                    onClick={() => {
                      onAddRunning(a.id);
                      close();
                    }}
                  >
                    <span className="status-dot dot-live" />
                    <span className="pull-agent-title">{a.title}</span>
                    <span className="pull-agent-cmd">{a.command || "$SHELL"}</span>
                    <span className="pull-agent-action">Add</span>
                  </button>
                </li>
              ))}
              {byProject[pullProject].inactive.map((a) => (
                <li key={a.id}>
                  <button
                    className="pull-agent-row"
                    onClick={() => {
                      onResumeToGrid(a.id);
                      close();
                    }}
                  >
                    <span className="status-dot dot-dead" />
                    <span className="pull-agent-title">{a.title}</span>
                    <span className="pull-agent-cmd">{a.status}</span>
                    <span className="pull-agent-action">Resume</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="grid-view">
      {pullOverlay}
      {Toolbar}
      {tileIds.length === 0 ? (
        <div className="grid-empty">
          <span className="grid-empty-icon">
            <GridIcon />
          </span>
          <p className="grid-empty-title">
            Add terminals — pull a running agent or create a new one
          </p>
          <div className="grid-empty-actions">
            <button className="btn-ghost" onClick={openPull}>
              Pull agent ▾
            </button>
            <button
              className="btn-ghost"
              onClick={() => onMenu("new")}
            >
              ＋ New agent ▾
            </button>
          </div>
        </div>
      ) : (
        <div className="grid-tiles" data-count={tileIds.length}>
          {tileIds.map((id) => {
            const rec = agentsById[id];
            const title = rec?.title ?? "agent";
            const project = rec ? projName(rec.project_id) : "";
            const isLive = live.has(id);
            return (
              <div key={id} className="grid-tile">
                <div className="grid-tile-head">
                  <span className="grid-tile-proj">{project}</span>
                  <span className="grid-tile-sep">·</span>
                  <span className="grid-tile-title" title={title}>
                    {title}
                  </span>
                  <button
                    className="grid-tile-close"
                    onClick={() => onPopOut?.(id)}
                    title="Pop out into its own window"
                    aria-label="Pop out terminal"
                  >
                    ⧉
                  </button>
                  <button
                    className="grid-tile-close"
                    onClick={() => onRemoveTile(id)}
                    title="Remove from workspace (keeps the agent running)"
                    aria-label="Remove from workspace"
                  >
                    ✕
                  </button>
                </div>
                <div className="grid-tile-body">
                  {isLive ? (
                    <AgentTerminal id={id} active mode={termMode} onInput={() => onAgentInput?.(id)} />
                  ) : (
                    // Restored-but-stopped tile: resume its session on demand.
                    <button
                      className="grid-tile-resume"
                      onClick={() => onResumeToGrid(id)}
                      title="Resume this session"
                    >
                      <span className="grid-tile-resume-icon">↻</span>
                      <span>Resume session</span>
                      <span className="grid-tile-resume-sub">{title}</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
