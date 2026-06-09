import { useState, type FormEvent } from "react";
import type { Task } from "../lib/tauri";

const PILL: Record<Task["status"], string> = {
  todo: "pill-todo",
  doing: "pill-doing",
  done: "pill-done",
  verified: "pill-done",
};

// Right panel: the project's plan as a simple task list.
export default function TasksPanel({
  tasks,
  onAdd,
  onCycle,
  onDelete,
}: {
  tasks: Task[];
  onAdd: (title: string) => void;
  onCycle: (t: Task) => void;
  onDelete: (id: string) => void;
}) {
  const [title, setTitle] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) {
      onAdd(title.trim());
      setTitle("");
    }
  };

  const done = tasks.filter((t) => t.status === "done").length;

  return (
    <aside className="tasks">
      <div className="tasks-head">
        <span>Plan</span>
        <span className="tasks-count">
          {done}/{tasks.length}
        </span>
      </div>

      <form className="tasks-add" onSubmit={submit}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="add a task…"
        />
      </form>

      <ul className="tasks-list">
        {tasks.map((t) => (
          <li key={t.id} className={`task ${t.status === "done" ? "task-done" : ""}`}>
            <button
              className={`pill ${PILL[t.status]}`}
              title="cycle status"
              onClick={() => onCycle(t)}
            >
              {t.status}
            </button>
            <span className="task-title">{t.title}</span>
            <button className="task-x" onClick={() => onDelete(t.id)}>
              ✕
            </button>
          </li>
        ))}
        {tasks.length === 0 && <li className="tasks-empty">No tasks yet</li>}
      </ul>
    </aside>
  );
}
