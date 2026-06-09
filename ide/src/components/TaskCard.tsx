import { useEffect, useRef, useState } from "react";
import type { Project, Step, Task } from "../lib/tauri";

const DOT: Record<Task["status"], string> = { todo: "○", doing: "◐", done: "●", verified: "✔" };
const NEXT: Record<Task["status"], Task["status"]> = { todo: "doing", doing: "done", done: "verified", verified: "todo" };
const STEP_NEXT: Record<Step["status"], Step["status"]> = { todo: "doing", doing: "done", done: "todo" };
const STEP_DOT: Record<Step["status"], string> = { todo: "○", doing: "◐", done: "✓" };

// A single task: status, description, an architect breakdown of tracked steps,
// and one-click handoff to an agent ("Work on this" / "Brainstorm"). Shared by
// the project overview and the Tasks planning page.
export default function TaskCard({
  task,
  projects,
  agentCommand,
  agentLabel,
  showProject,
  projectName,
  onCycle,
  onDelete,
  onSetDescription,
  onBreakdown,
  onToggleStep,
  onWork,
  onBrainstorm,
  onAssign,
  onPushJira,
}: {
  task: Task;
  /** When provided (and the task is unassigned), show a project picker. */
  projects?: Project[];
  /** Chosen agent command for Work/Brainstorm (omit to hide those buttons). */
  agentCommand?: string;
  agentLabel?: string;
  showProject?: boolean;
  projectName?: string;
  onCycle: (t: Task) => void;
  onDelete: (t: Task) => void;
  onSetDescription: (id: string, description: string) => void;
  onBreakdown: (id: string) => Promise<void>;
  onToggleStep: (taskId: string, stepId: string, status: Step["status"]) => void;
  onWork?: (t: Task, command: string) => void;
  onBrainstorm?: (t: Task, command: string) => void;
  onAssign?: (id: string, projectId: string) => void;
  /** Push this (local) task up to Jira as a new issue. */
  onPushJira?: (t: Task) => void;
}) {
  const steps = task.steps ?? [];
  const hasDetail = !!task.description || steps.length > 0;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.description ?? "");
  const [breaking, setBreaking] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  const saveDesc = () => {
    onSetDescription(task.id, draft.trim());
    setEditing(false);
  };
  const breakdown = async () => {
    if (breaking) return;
    setBreaking(true);
    setOpen(true);
    try {
      await onBreakdown(task.id);
    } finally {
      setBreaking(false);
    }
  };

  const doneSteps = steps.filter((s) => s.status === "done").length;

  return (
    <li className={`tc ${task.status === "done" || task.status === "verified" ? "done" : ""}`}>
      <div className="tc-main">
        <button className={`tc-dot ${task.status}`} onClick={() => onCycle(task)} title={`Mark ${NEXT[task.status]}`}>
          {DOT[task.status]}
        </button>
        <button
          className="tc-title"
          onClick={() => setOpen((o) => !o)}
          title={hasDetail || steps.length ? "Show details" : "Add details"}
        >
          {task.title}
          {steps.length > 0 && (
            <span className="tc-steps-count" title={`${doneSteps}/${steps.length} steps done`}>
              {doneSteps}/{steps.length}
            </span>
          )}
          {task.description && <span className="tc-has-note" title="Has a description">📝</span>}
        </button>

        {showProject && <span className="tc-proj">{projectName}</span>}

        {onAssign && projects && (
          <select
            className="tc-assign"
            value=""
            onChange={(e) => e.target.value && onAssign(task.id, e.target.value)}
            title="Assign to a project"
          >
            <option value="">Assign to…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}

        {agentCommand && onWork && (
          <button
            className="tc-work"
            onClick={() => onWork(task, agentCommand)}
            title={`Have ${agentLabel ?? "the agent"} work on this`}
          >
            ▶ Work
          </button>
        )}
        {agentCommand && onBrainstorm && (
          <button
            className="tc-brainstorm"
            onClick={() => onBrainstorm(task, agentCommand)}
            title={`Brainstorm with ${agentLabel ?? "the agent"} (no code changes)`}
          >
            💡
          </button>
        )}
        {task.source === "jira" && task.external_id ? (
          <a
            className="tc-jira"
            href={task.external_url ?? undefined}
            target="_blank"
            rel="noreferrer"
            title={`Linked to Jira ${task.external_id}`}
          >
            {task.external_id}
          </a>
        ) : (
          onPushJira && (
            <button className="tc-jira-push" onClick={() => onPushJira(task)} title="Create a Jira issue from this task">
              ↑ Jira
            </button>
          )
        )}
        <button className="tc-expand" onClick={() => setOpen((o) => !o)} title="Details">
          {open ? "▾" : "▸"}
        </button>
        <button className="tc-del" onClick={() => onDelete(task)} title="Delete" aria-label="Delete task">
          🗑
        </button>
      </div>

      {open && (
        <div className="tc-detail">
          {/* Description */}
          {editing ? (
            <div className="tc-desc-edit">
              <textarea
                ref={taRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") saveDesc();
                  if (e.key === "Escape") {
                    setDraft(task.description ?? "");
                    setEditing(false);
                  }
                }}
                placeholder="Describe this task — context, acceptance criteria, links…"
                rows={3}
              />
              <div className="tc-desc-actions">
                <button className="btn-ghost" onClick={() => { setDraft(task.description ?? ""); setEditing(false); }}>
                  Cancel
                </button>
                <button className="btn primary" onClick={saveDesc}>Save</button>
              </div>
            </div>
          ) : task.description ? (
            <p className="tc-desc" onClick={() => setEditing(true)} title="Click to edit">
              {task.description}
            </p>
          ) : (
            <button className="tc-add-note" onClick={() => setEditing(true)}>＋ Add description</button>
          )}

          {/* Breakdown steps */}
          {steps.length > 0 && (
            <ul className="tc-steps">
              {steps.map((s) => (
                <li key={s.id} className={`tc-step ${s.status}`}>
                  <button
                    className={`tc-step-dot ${s.status}`}
                    onClick={() => onToggleStep(task.id, s.id, STEP_NEXT[s.status])}
                    title={`Mark ${STEP_NEXT[s.status]}`}
                  >
                    {STEP_DOT[s.status]}
                  </button>
                  <span className="tc-step-title">{s.title}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="tc-detail-actions">
            <button className="tc-breakdown" onClick={breakdown} disabled={breaking} title="Let an architect break this into steps">
              {breaking ? "Breaking down…" : steps.length > 0 ? "↻ Re-plan steps" : "🧩 Break into steps"}
            </button>
            {!editing && task.description && (
              <button className="btn-ghost" onClick={() => setEditing(true)}>Edit description</button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
