import { useState } from "react";
import type { Project, SuperProject } from "../lib/tauri";

// A filter bar above the Home dashboard: pick "All projects" or a super-project
// (a named group of separate repos) to scope the aggregate overview to it. Also
// hosts lightweight management — create a group, rename/delete it, and choose
// which projects belong via a checklist popover.
export default function SuperProjectBar({
  superProjects,
  projects,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onSetMembers,
}: {
  superProjects: SuperProject[];
  projects: Project[];
  /** Active group id, or null for "All projects". */
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onSetMembers: (id: string, projectIds: string[]) => void;
}) {
  // Which group's manage popover is open (by id), if any.
  const [managing, setManaging] = useState<string | null>(null);
  // Inline name entry — window.prompt is a no-op in the webview.
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const active = superProjects.find((s) => s.id === activeId) ?? null;

  const submit = () => {
    const n = name.trim();
    if (n) onCreate(n);
    setName("");
    setNaming(false);
  };

  return (
    <div className="spb">
      <div className="spb-pills">
        <button
          className={`spb-pill ${activeId === null ? "active" : ""}`}
          onClick={() => onSelect(null)}
        >
          All projects
        </button>
        {superProjects.map((s) => (
          <button
            key={s.id}
            className={`spb-pill ${s.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(s.id)}
            title={`${s.project_ids.length} project${s.project_ids.length === 1 ? "" : "s"}`}
          >
            {s.name}
            <span className="spb-count">{s.project_ids.length}</span>
          </button>
        ))}
        {naming ? (
          <input
            className="spb-pill spb-newinput"
            autoFocus
            placeholder="Group name…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              else if (e.key === "Escape") {
                setName("");
                setNaming(false);
              }
            }}
            onBlur={submit}
          />
        ) : (
          <button
            className="spb-pill spb-new"
            onClick={() => setNaming(true)}
            title="New super-project"
          >
            + Group
          </button>
        )}
      </div>

      {active && (
        <div className="spb-tools">
          <button
            className="spb-tool"
            onClick={() => setManaging((m) => (m === active.id ? null : active.id))}
          >
            {managing === active.id ? "Done" : "Edit members"}
          </button>
          <button
            className="spb-tool"
            onClick={() => {
              const name = window.prompt("Rename group", active.name);
              if (name && name.trim()) onRename(active.id, name.trim());
            }}
          >
            Rename
          </button>
          <button
            className="spb-tool del"
            onClick={() => {
              if (window.confirm(`Delete group “${active.name}”? Projects are kept.`)) {
                onDelete(active.id);
                onSelect(null);
              }
            }}
          >
            Delete
          </button>
        </div>
      )}

      {active && managing === active.id && (
        <div className="spb-members">
          <div className="spb-members-head">Projects in “{active.name}”</div>
          {projects.length === 0 ? (
            <div className="spb-members-empty">No projects to add.</div>
          ) : (
            projects.map((p) => {
              const checked = active.project_ids.includes(p.id);
              return (
                <label key={p.id} className="spb-member">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const next = checked
                        ? active.project_ids.filter((id) => id !== p.id)
                        : [...active.project_ids, p.id];
                      onSetMembers(active.id, next);
                    }}
                  />
                  <span className="spb-member-name">{p.name}</span>
                  <span className="spb-member-path" title={p.path}>
                    {p.path}
                  </span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
