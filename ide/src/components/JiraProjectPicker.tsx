import { useEffect, useState } from "react";
import type { JiraProject } from "../lib/tauri";

// Choose which Jira board/project to file a task into, when the task's project
// maps to more than one (or none) — shown by "↑ Jira" before creating the issue.
export default function JiraProjectPicker({
  open,
  taskTitle,
  projects,
  onPick,
  onClose,
}: {
  open: boolean;
  taskTitle: string;
  projects: JiraProject[];
  onPick: (projectKey: string) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState("");

  useEffect(() => {
    if (open) setSel(projects[0]?.key ?? "");
  }, [open, projects]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="set-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="set-modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="set-head">
          <span className="set-title">Push to Jira</span>
          <button className="set-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="set-body">
          <p className="set-row-hint" style={{ marginBottom: 12 }}>
            Create a Jira issue for <strong>“{taskTitle}”</strong>. Which board?
          </p>
          <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ width: "100%" }}>
            {projects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name} ({p.key})
              </option>
            ))}
          </select>
          <div className="welcome-actions" style={{ marginTop: 18 }}>
            <button className="btn primary" disabled={!sel} onClick={() => onPick(sel)}>
              Create issue
            </button>
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
