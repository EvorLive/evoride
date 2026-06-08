import { useMemo, useState } from "react";
import type { Project, Task } from "../lib/tauri";

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const taskDay = (t: Task) => t.planned_for || localDay(new Date(t.created_at * 1000));

const NEXT: Record<Task["status"], Task["status"]> = { todo: "doing", doing: "done", done: "todo" };
const DOT: Record<Task["status"], string> = { todo: "○", doing: "◐", done: "●" };

// Daily planning across all projects: Today / Yesterday with status, plus an
// Unassigned lane for agent-created tasks that couldn't be related to a project.
export default function TasksView({
  tasks,
  projects,
  onAdd,
  onCycle,
  onAssign,
  onDelete,
}: {
  tasks: Task[];
  projects: Project[];
  onAdd: (title: string, projectId: string, plannedFor: string) => void;
  onCycle: (t: Task) => void;
  onAssign: (id: string, projectId: string) => void;
  onDelete: (id: string) => void;
}) {
  const today = localDay(new Date());
  const yesterday = localDay(new Date(Date.now() - 86400_000));
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "Unknown";

  const [draft, setDraft] = useState("");
  const [draftProject, setDraftProject] = useState("");

  const { todays, yesterdays, unassigned } = useMemo(() => {
    const todays: Task[] = [];
    const yesterdays: Task[] = [];
    const unassigned: Task[] = [];
    for (const t of tasks) {
      if (!t.project_id) {
        unassigned.push(t);
        continue;
      }
      const d = taskDay(t);
      if (d === today) todays.push(t);
      else if (d === yesterday) yesterdays.push(t);
    }
    return { todays, yesterdays, unassigned };
  }, [tasks, today, yesterday]);

  const add = () => {
    const title = draft.trim();
    if (!title) return;
    onAdd(title, draftProject, today);
    setDraft("");
  };

  const Row = ({ t, assignable }: { t: Task; assignable?: boolean }) => (
    <li className={`tk-row ${t.status === "done" ? "done" : ""}`}>
      <button className={`tk-dot ${t.status}`} onClick={() => onCycle(t)} title={`Mark ${NEXT[t.status]}`}>
        {DOT[t.status]}
      </button>
      <span className="tk-title">{t.title}</span>
      {assignable ? (
        <select
          className="tk-assign"
          value=""
          onChange={(e) => e.target.value && onAssign(t.id, e.target.value)}
          title="Assign to a project"
        >
          <option value="">Assign to…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="tk-proj">{projectName(t.project_id)}</span>
      )}
      <button className="tk-del" onClick={() => onDelete(t.id)} title="Delete" aria-label="Delete task">
        🗑
      </button>
    </li>
  );

  const Section = ({ title, items, assignable, empty }: { title: string; items: Task[]; assignable?: boolean; empty: string }) => (
    <section className="tk-section">
      <div className="tk-section-head">
        <h2>{title}</h2>
        <span className="tk-count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="tk-empty">{empty}</p>
      ) : (
        <ul className="tk-list">
          {items.map((t) => (
            <Row key={t.id} t={t} assignable={assignable} />
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <div className="tasks-view">
      <div className="tasks-inner">
        <h1 className="tk-h1">Plan your day</h1>

        <div className="tk-add">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="Add a task for today…"
          />
          <select value={draftProject} onChange={(e) => setDraftProject(e.target.value)} title="Project">
            <option value="">Unassigned</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn primary" onClick={add} disabled={!draft.trim()}>
            Add
          </button>
        </div>

        {unassigned.length > 0 && (
          <Section title="Unassigned" items={unassigned} assignable empty="" />
        )}
        <Section title="Today" items={todays} empty="Nothing planned yet — add a task above." />
        <Section title="Yesterday" items={yesterdays} empty="Nothing from yesterday." />
      </div>
    </div>
  );
}
