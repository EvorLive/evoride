import { useEffect, useRef, useState } from "react";
import { isTauri } from "../lib/bridge";
import type { Project, SuperProject } from "../lib/tauri";

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

// Compact "last worked on" age, e.g. 3m / 5h / 2d / 1w. Null when never touched.
function fmtAge(unix?: number): string | null {
  if (!unix) return null;
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 604800)}w`;
}

const MIN_W = 160;
const MAX_W = 420;
const DEFAULT_W = 200;

// Leftmost rail: the active project and its group up top, every other project
// below — each showing whether it has running agents, whether it's waiting on
// you, and when it was last worked on. Resizable and group-aware.
export default function ProjectRail({
  projects,
  activeId,
  currentProjectId,
  homeActive = false,
  workspaceActive = false,
  tasksActive = false,
  runningByProject,
  waitingProjects,
  lastActivityByProject,
  superProjects,
  onSelect,
  onOpen,
  onHome,
  onWorkspace,
  onTasks,
  onCreateGroup,
  onSetGroupMembers,
}: {
  projects: Project[];
  activeId: string | null;
  /** The currently-opened project (drives the ACTIVE section across all views). */
  currentProjectId: string | null;
  homeActive?: boolean;
  workspaceActive?: boolean;
  tasksActive?: boolean;
  runningByProject: Record<string, number>;
  waitingProjects: Set<string>;
  /** Unix-seconds of the last agent activity per project, for the age badge. */
  lastActivityByProject: Record<string, number>;
  superProjects: SuperProject[];
  onSelect: (p: Project) => void;
  onOpen: () => void;
  onHome: () => void;
  onWorkspace?: () => void;
  onTasks?: () => void;
  /** Create a new group with the given name (seeded with the current project by
      the host). Named here because window.prompt is a no-op in the webview. */
  onCreateGroup: (name: string) => void;
  onSetGroupMembers: (groupId: string, projectIds: string[]) => void;
}) {
  // Persisted, drag-resizable width.
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem("evor.railWidth"));
    return v >= MIN_W && v <= MAX_W ? v : DEFAULT_W;
  });
  useEffect(() => {
    localStorage.setItem("evor.railWidth", String(width));
  }, [width]);
  const dragging = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setWidth(Math.min(MAX_W, Math.max(MIN_W, e.clientX)));
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [allOpen, setAllOpen] = useState(true);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  // Inline name entry for a new group — window.prompt is a no-op in the webview.
  const [namingGroup, setNamingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const submitGroup = () => {
    const n = groupName.trim();
    if (n) onCreateGroup(n);
    setGroupName("");
    setNamingGroup(false);
  };

  const ageOf = (id: string) => lastActivityByProject[id] ?? 0;
  const byRecency = (a: Project, b: Project) => ageOf(b.id) - ageOf(a.id);

  // "Active" = every project currently working (a live agent/terminal), plus the
  // one you're viewing — so multiple projects can be active at once. A project
  // pops in here the instant a session starts there.
  const activeProjects = projects
    .filter((p) => (runningByProject[p.id] ?? 0) > 0 || p.id === currentProjectId)
    .sort(byRecency);
  const activeIds = new Set(activeProjects.map((p) => p.id));

  const activeGroup = currentProjectId
    ? superProjects.find((s) => s.project_ids.includes(currentProjectId)) ?? null
    : null;
  // Group members not already shown under Active, and the lower "all projects"
  // list (everything not active and not in the group), both newest-first.
  const groupSiblings = activeGroup
    ? projects
        .filter((p) => activeGroup.project_ids.includes(p.id) && !activeIds.has(p.id))
        .sort(byRecency)
    : [];
  const others = projects
    .filter((p) => !activeIds.has(p.id) && !activeGroup?.project_ids.includes(p.id))
    .sort(byRecency);

  const renderRow = (p: Project, opts?: { inGroup?: string }) => {
    const running = runningByProject[p.id] ?? 0;
    const waiting = waitingProjects.has(p.id);
    const isCurrent = p.id === currentProjectId;
    const age = fmtAge(ageOf(p.id));
    // Dot reflects what's true RIGHT NOW: needs-you > running > the one you're
    // viewing > idle. The "current" state matters because the open project lives
    // in the Active section even with no live agent — without it, the project you
    // just opened would render with the same dead-grey dot as everything dormant.
    const dot = waiting ? "wait" : running > 0 ? "live" : isCurrent ? "current" : "idle";
    return (
      <button
        className={`prail-item ${p.id === activeId ? "active" : ""}`}
        onClick={() => onSelect(p)}
        title={`${p.path}${running ? ` · ${running} running` : ""}${
          waiting ? " · waiting for input" : isCurrent ? " · open" : ""
        }${age ? ` · worked ${age} ago` : ""}`}
      >
        <span className={`prail-dot ${dot}`} />
        <span className="prail-name">{p.name}</span>
        {running > 0 && <span className="prail-count">{running}</span>}
        {waiting && <span className="prail-bell">●</span>}
        {age && <span className="prail-age">{age}</span>}
        {opts?.inGroup && (
          <span
            className="prail-rm"
            role="button"
            title="Remove from group"
            onClick={(e) => {
              e.stopPropagation();
              const g = superProjects.find((s) => s.id === opts.inGroup);
              if (g) onSetGroupMembers(g.id, g.project_ids.filter((id) => id !== p.id));
            }}
          >
            ✕
          </span>
        )}
      </button>
    );
  };

  return (
    <nav className="prail" style={{ width, flexBasis: width }}>
      <button
        className={`prail-brand ${homeActive ? "active" : ""}`}
        onClick={onHome}
        title="Home / overview"
      >
        <span className="brand-mark">▮</span>
        <span className="prail-brand-name">Evor</span>
      </button>
      {onWorkspace && (
        <button
          className={`prail-workspace ${workspaceActive ? "active" : ""}`}
          onClick={onWorkspace}
          title="Multi-terminal workspace"
        >
          <GridIcon />
          <span>Workspace</span>
        </button>
      )}
      {onTasks && (
        <button
          className={`prail-workspace ${tasksActive ? "active" : ""}`}
          onClick={onTasks}
          title="Tasks & daily planning"
        >
          <span className="brand-mark">☑</span>
          <span>Tasks</span>
        </button>
      )}

      <div className="prail-scroll">
        {activeProjects.length > 0 && (
          <>
            <div className="prail-section">Active</div>
            <ul className="prail-list">
              {activeProjects.map((p) => (
                <li key={p.id}>{renderRow(p)}</li>
              ))}
            </ul>
            {activeGroup && (
              <div className="prail-group">
                <div className="prail-group-head">
                  <button
                    className="prail-group-toggle"
                    onClick={() =>
                      setCollapsedGroups((prev) => {
                        const n = new Set(prev);
                        n.has(activeGroup.id) ? n.delete(activeGroup.id) : n.add(activeGroup.id);
                        return n;
                      })
                    }
                  >
                    <span className="prail-caret">
                      {collapsedGroups.has(activeGroup.id) ? "▸" : "▾"}
                    </span>
                    <span className="prail-group-name">{activeGroup.name}</span>
                    <span className="prail-count">{activeGroup.project_ids.length}</span>
                  </button>
                </div>
                {!collapsedGroups.has(activeGroup.id) && (
                  <>
                    <ul className="prail-list prail-group-list">
                      {groupSiblings.map((p) => (
                        <li key={p.id}>{renderRow(p, { inGroup: activeGroup.id })}</li>
                      ))}
                    </ul>
                    {addingTo === activeGroup.id ? (
                      <div className="prail-addlist">
                        {projects.filter((p) => !activeGroup.project_ids.includes(p.id)).length ===
                        0 ? (
                          <div className="prail-empty">All projects added</div>
                        ) : (
                          projects
                            .filter((p) => !activeGroup.project_ids.includes(p.id))
                            .sort(byRecency)
                            .map((p) => (
                              <button
                                key={p.id}
                                className="prail-additem"
                                onClick={() => {
                                  onSetGroupMembers(activeGroup.id, [
                                    ...activeGroup.project_ids,
                                    p.id,
                                  ]);
                                  setAddingTo(null);
                                }}
                              >
                                + {p.name}
                              </button>
                            ))
                        )}
                      </div>
                    ) : (
                      <button
                        className="prail-subadd"
                        onClick={() => setAddingTo(activeGroup.id)}
                      >
                        + Add project
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}

        <div className="prail-section prail-section-toggle">
          <button className="prail-group-toggle" onClick={() => setAllOpen((o) => !o)}>
            <span className="prail-caret">{allOpen ? "▾" : "▸"}</span>
            <span>{activeProjects.length > 0 ? "All projects" : "Projects"}</span>
          </button>
        </div>
        {allOpen && (
          <ul className="prail-list">
            {others.map((p) => (
              <li key={p.id}>{renderRow(p)}</li>
            ))}
            {others.length === 0 && <li className="prail-empty">No other projects</li>}
          </ul>
        )}
      </div>

      <div className="prail-foot">
        {namingGroup ? (
          <input
            className="prail-groupinput"
            autoFocus
            placeholder="Group name…"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitGroup();
              else if (e.key === "Escape") {
                setGroupName("");
                setNamingGroup(false);
              }
            }}
            onBlur={submitGroup}
          />
        ) : (
          <button
            className="prail-add"
            onClick={() => setNamingGroup(true)}
            title="Create a new group"
          >
            + New group
          </button>
        )}
        {/* Opening a new project is desktop-only — the daemon rejects add_project
            (it would widen path confinement). Hide it on the remote/web client. */}
        {isTauri() && (
          <button className="prail-add" onClick={onOpen} title="Open another project">
            + Open
          </button>
        )}
      </div>

      <div
        className="prail-resize"
        title="Drag to resize"
        onMouseDown={(e) => {
          e.preventDefault();
          dragging.current = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
      />
    </nav>
  );
}
