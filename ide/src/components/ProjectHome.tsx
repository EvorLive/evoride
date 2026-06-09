import { useMemo, useState } from "react";
import type { GitStatus, Project, Step, Task } from "../lib/tauri";
import type { CliDef } from "../lib/clis";
import TaskCard from "./TaskCard";

// Doing first (in-flight), then todo, then done — an at-a-glance work queue.
const ORDER: Record<Task["status"], number> = { doing: 0, todo: 1, done: 2, verified: 3 };

// The project's default / overview page: a glance at the project (git + task
// status) and a task list where each task can be handed to an agent to work on
// or brainstorm — no need to type a prompt. Shown whenever no agent is focused.
export default function ProjectHome({
  project,
  git,
  tasks,
  clis,
  agentsWorking = [],
  onOpenAgent,
  onAdd,
  onCycle,
  onDelete,
  onWork,
  onBrainstorm,
  onNew,
  onSetDescription,
  onBreakdown,
  onToggleStep,
  onPushJira,
}: {
  project: Project;
  git: GitStatus | null;
  tasks: Task[];
  /** Enabled launchable CLIs (incl. shell). */
  clis: CliDef[];
  /** Agents currently live in THIS project (most-recent first). */
  agentsWorking?: { id: string; title: string; waiting: boolean }[];
  /** Focus an agent's terminal. */
  onOpenAgent?: (id: string) => void;
  onAdd: (title: string) => void;
  onCycle: (t: Task) => void;
  onDelete: (t: Task) => void;
  /** Start an agent working on this task. */
  onWork: (t: Task, command: string) => void;
  /** Start an agent brainstorming this task (no code changes). */
  onBrainstorm: (t: Task, command: string) => void;
  /** Open a blank session. */
  onNew: (title: string, command: string) => void;
  onSetDescription: (id: string, description: string) => void;
  onBreakdown: (id: string) => Promise<void>;
  onToggleStep: (taskId: string, stepId: string, status: Step["status"]) => void;
  /** Push a local task up to Jira (create an issue). */
  onPushJira?: (t: Task) => void;
}) {
  const [draft, setDraft] = useState("");
  // Agents (non-shell) you can hand a task to.
  const agentClis = useMemo(() => clis.filter((c) => c.command.trim()), [clis]);
  const [agent, setAgent] = useState(agentClis[0]?.command ?? "claude");
  const agentLabel = agentClis.find((c) => c.command === agent)?.label ?? "agent";

  const sorted = useMemo(
    () => [...tasks].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.created_at - b.created_at),
    [tasks],
  );
  const counts = useMemo(() => {
    const c = { todo: 0, doing: 0, done: 0, verified: 0 };
    for (const t of tasks) c[t.status]++;
    return c;
  }, [tasks]);

  const add = () => {
    const title = draft.trim();
    if (!title) return;
    onAdd(title);
    setDraft("");
  };

  return (
    <div className="phome">
      <div className="phome-inner">
        <header className="phome-head">
          <h1 className="phome-name">{project.name}</h1>
          <div className="phome-sub">
            <span className="phome-path">{project.path}</span>
            {git?.is_repo && (
              <span className="phome-git">
                <span className="phome-branch">⎇ {git.branch}</span>
                {git.dirty > 0 && <span className="phome-dirty">●{git.dirty}</span>}
                {git.ahead > 0 && <span>↑{git.ahead}</span>}
                {git.behind > 0 && <span>↓{git.behind}</span>}
              </span>
            )}
          </div>
        </header>

        <div className="phome-stats">
          <span className="phome-stat doing">{counts.doing} in progress</span>
          <span className="phome-stat todo">{counts.todo} to do</span>
          <span className="phome-stat done">{counts.done} done</span>
        </div>

        {agentsWorking.length > 0 && (
          <section className="phome-working">
            <h2>Working now</h2>
            <ul className="phome-working-list">
              {agentsWorking.map((a) => (
                <li key={a.id}>
                  <button
                    className="phome-working-item"
                    onClick={() => onOpenAgent?.(a.id)}
                    title="Open this agent’s terminal"
                  >
                    <span className={`dot ${a.waiting ? "dot-wait" : "dot-live"}`} />
                    <span className="phome-working-title">{a.title}</span>
                    <span className="phome-working-state">
                      {a.waiting ? "waiting for input" : "working"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="phome-tasks">
          <div className="phome-tasks-head">
            <h2>Tasks</h2>
            {agentClis.length > 0 && (
              <label className="phome-agent">
                Start with
                <select value={agent} onChange={(e) => setAgent(e.target.value)}>
                  {agentClis.map((c) => (
                    <option key={c.id} value={c.command}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="phome-add">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="Add a task for this project…"
            />
            <button className="btn primary" onClick={add} disabled={!draft.trim()}>
              Add
            </button>
          </div>

          {sorted.length === 0 ? (
            <p className="phome-empty">No tasks yet. Add one above, or plan your day from the Tasks page.</p>
          ) : (
            <ul className="tc-list">
              {sorted.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  agentCommand={agentClis.length > 0 ? agent : undefined}
                  agentLabel={agentLabel}
                  onCycle={onCycle}
                  onDelete={onDelete}
                  onSetDescription={onSetDescription}
                  onBreakdown={onBreakdown}
                  onToggleStep={onToggleStep}
                  onWork={onWork}
                  onBrainstorm={onBrainstorm}
                  onPushJira={onPushJira}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="phome-blank">
          <span className="phome-blank-label">Or open a blank session</span>
          <div className="phome-blank-actions">
            {clis.map((c) => (
              <button key={c.id} className="phome-blank-btn" onClick={() => onNew(c.label, c.command)}>
                ＋ {c.label}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
