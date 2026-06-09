import { useEffect, useState } from "react";
import * as api from "../lib/tauri";
import type { JiraIssue } from "../lib/tauri";

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// "See all" Jira issues: the full list of issues assigned to you, each with its
// real Jira status + description, importable into Today. Imported ones show a
// badge and can't be imported again.
export default function JiraIssuesDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after an import so the board/home can refresh. */
  onImported: () => void;
}) {
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setErr("");
    api
      .jiraMyIssues()
      .then(setIssues)
      .catch((e) => setErr(typeof e === "string" ? e : (e as Error)?.message || "Couldn't load Jira issues."))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const importToToday = async (it: JiraIssue) => {
    setBusy(it.key);
    try {
      await api.jiraImport(it, today());
      setIssues((prev) => prev.map((x) => (x.key === it.key ? { ...x, imported: true } : x)));
      onImported();
    } catch {
      /* surfaced via the row staying un-imported */
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="set-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="set-modal jira-all-modal" onClick={(e) => e.stopPropagation()}>
        <div className="set-head">
          <span className="set-title">Jira issues assigned to you</span>
          <button className="set-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="set-body">
          {loading ? (
            <p className="set-row-hint">Loading…</p>
          ) : err ? (
            <p className="jira-status err">{err}</p>
          ) : issues.length === 0 ? (
            <p className="set-row-hint">No issues match your JQL.</p>
          ) : (
            <ul className="jira-all-list">
              {issues.map((it) => (
                <li key={it.key} className="jira-all-row">
                  <div className="jira-all-main">
                    <div className="jira-all-top">
                      <a className="jira-inbox-key" href={it.url} target="_blank" rel="noreferrer">
                        {it.key}
                      </a>
                      {it.status_name && <span className={`jira-stat s-${it.status}`}>{it.status_name}</span>}
                      <span className="jira-all-title">{it.summary}</span>
                    </div>
                    {it.description && <p className="jira-all-desc">{it.description}</p>}
                  </div>
                  {it.imported ? (
                    <span className="jira-imported">✓ imported</span>
                  ) : (
                    <button
                      className="btn-sm primary"
                      disabled={busy === it.key}
                      onClick={() => importToToday(it)}
                      title="Import into Today"
                    >
                      {busy === it.key ? "…" : "Import to today"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
