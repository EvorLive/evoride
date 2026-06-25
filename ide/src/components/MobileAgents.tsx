import { useState } from "react";
import type { AgentRecord, Project } from "../lib/tauri";

type Cli = { id: string; label: string; command: string };

/**
 * Cross-project agent view for the mobile home: every running agent grouped under
 * its project, each group with a one-tap "+ New" to start another agent there, and
 * a launcher at the bottom to start a fresh agent in any project. Tapping an agent
 * opens it in its workspace. Purely a launcher/overview — no destructive actions
 * (those are desktop-only on the remote client).
 */
export default function MobileAgents({
  projects,
  running,
  waitingAgents,
  clis,
  onOpenAgent,
  onNewAgent,
}: {
  /** Projects in scope (already filtered by the active super-project). */
  projects: Project[];
  /** Running agents across those projects. */
  running: AgentRecord[];
  waitingAgents: Set<string>;
  /** Launchable CLIs (Claude/Codex/Shell…); first non-empty is the default. */
  clis: Cli[];
  onOpenAgent: (a: AgentRecord) => void;
  onNewAgent: (p: Project, label: string, command: string) => void;
}) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  // Group running agents by project, keeping only in-scope projects.
  const groups = new Map<string, AgentRecord[]>();
  for (const a of running) {
    if (!byId.has(a.project_id)) continue;
    (groups.get(a.project_id) ?? groups.set(a.project_id, []).get(a.project_id)!).push(a);
  }

  const defaultCli = clis.find((c) => c.command.trim()) ?? clis[0];
  const [launchProject, setLaunchProject] = useState("");

  return (
    <div className="magents">
      <section className="magents-sec">
        <h2 className="mhome-h2">Running agents</h2>
        {groups.size === 0 ? (
          <p className="mhome-empty">No agents running. Start one below.</p>
        ) : (
          <ul className="magents-groups">
            {[...groups.entries()].map(([pid, ags]) => {
              const p = byId.get(pid)!;
              return (
                <li key={pid} className="magents-group">
                  <div className="magents-ghead">
                    <span className="magents-gname">{p.name}</span>
                    <span className="magents-gcount">{ags.length}</span>
                    {defaultCli && (
                      <button
                        className="btn-ghost magents-gnew"
                        onClick={() => onNewAgent(p, defaultCli.label, defaultCli.command)}
                        title={`New ${defaultCli.label} in ${p.name}`}
                      >
                        ＋ New
                      </button>
                    )}
                  </div>
                  <ul className="magents-rows">
                    {ags.map((a) => (
                      <li key={a.id} className="magents-row">
                        <span className={`magents-dot ${waitingAgents.has(a.id) ? "wait" : "live"}`} />
                        <button className="magents-atitle" onClick={() => onOpenAgent(a)}>
                          {a.title}
                        </button>
                        {waitingAgents.has(a.id) && <span className="magents-badge">needs you</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Launch a new agent in any project. */}
      <section className="magents-sec">
        <h2 className="mhome-h2">Start a new agent</h2>
        <select
          className="magents-pick"
          value={launchProject}
          onChange={(e) => setLaunchProject(e.target.value)}
        >
          <option value="">Choose a project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="magents-clis">
          {clis.map((c) => {
            const p = projects.find((x) => x.id === launchProject);
            return (
              <button
                key={c.id}
                className="btn"
                disabled={!p}
                onClick={() => p && onNewAgent(p, c.label, c.command)}
                title={p ? `Start ${c.label} in ${p.name}` : "Pick a project first"}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
