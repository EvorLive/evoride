import type { Project } from "../lib/tauri";

// Leftmost rail: switch between projects, see which have running agents, and —
// crucially — which are waiting for your input.
export default function ProjectRail({
  projects,
  activeId,
  runningByProject,
  waitingProjects,
  onSelect,
  onOpen,
  onHome,
}: {
  projects: Project[];
  activeId: string | null;
  runningByProject: Record<string, number>;
  waitingProjects: Set<string>;
  onSelect: (p: Project) => void;
  onOpen: () => void;
  onHome: () => void;
}) {
  return (
    <nav className="prail">
      <button className="prail-brand" onClick={onHome} title="Home / overview">
        <span className="brand-mark">▮</span>
        <span className="prail-brand-name">EvorIde</span>
      </button>
      <div className="prail-section">Projects</div>
      <ul className="prail-list">
        {projects.map((p) => {
          const running = runningByProject[p.id] ?? 0;
          const waiting = waitingProjects.has(p.id);
          return (
            <li key={p.id}>
              <button
                className={`prail-item ${p.id === activeId ? "active" : ""}`}
                onClick={() => onSelect(p)}
                title={`${p.path}${running ? ` · ${running} running` : ""}${
                  waiting ? " · waiting for input" : ""
                }`}
              >
                <span
                  className={`prail-dot ${
                    waiting ? "wait" : running > 0 ? "live" : "idle"
                  }`}
                />
                <span className="prail-name">{p.name}</span>
                {running > 0 && <span className="prail-count">{running}</span>}
                {waiting && <span className="prail-bell">●</span>}
              </button>
            </li>
          );
        })}
        {projects.length === 0 && (
          <li className="prail-empty">No projects</li>
        )}
      </ul>
      <button className="prail-add" onClick={onOpen} title="Open another project">
        + Open
      </button>
    </nav>
  );
}
