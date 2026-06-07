import { useCallback, useEffect, useState } from "react";
import {
  gitChanges,
  gitCommitPush,
  gitFetch,
  gitPull,
  gitPush,
  type FileChange,
  type GitStatus,
} from "../lib/tauri";

function statusClass(code: string): string {
  const c = code.trim();
  if (c === "??") return "ch-new";
  if (c.includes("D")) return "ch-del";
  if (c.includes("A")) return "ch-add";
  return "ch-mod";
}

// Right-side per-window git panel: branch sync (pull/push/merge), changed files
// (click to view the diff in the center), and commit & push.
export default function GitPanel({
  cwd,
  git,
  canAsk,
  onAskAgent,
  onRefreshStatus,
  onOpenDiff,
  onBeforeCommit,
}: {
  cwd: string;
  git: GitStatus | null;
  canAsk: boolean;
  onAskAgent: (message: string) => void;
  onRefreshStatus: () => void;
  onOpenDiff: (file: string | null) => void;
  onBeforeCommit?: () => Promise<void>;
}) {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    gitChanges(cwd).then(setChanges).catch(() => {});
  }, [cwd]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // Fetch periodically so behind/ahead reflects the remote, then re-poll status.
  useEffect(() => {
    const sync = () => gitFetch(cwd).then(onRefreshStatus).catch(() => {});
    sync();
    const t = setInterval(sync, 30000);
    return () => clearInterval(t);
  }, [cwd, onRefreshStatus]);

  const runSync = async (fn: () => Promise<string>, label: string) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const out = await fn();
      setResult(out || label);
      refresh();
      onRefreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const directCommit = async () => {
    if (onBeforeCommit) await onBeforeCommit();
    await runSync(() => gitCommitPush(cwd, message), "committed & pushed");
    setMessage("");
  };

  const askAgent = () => {
    const instruction = message.trim()
      ? `Please stage all changes, commit with the message "${message.trim()}", and push to the remote.`
      : "Please stage all current changes, write a clear and descriptive commit message, commit, and push to the remote.";
    onAskAgent(instruction);
  };

  const ahead = git?.ahead ?? 0;
  const behind = git?.behind ?? 0;

  return (
    <aside className="gitpanel">
      <div className="gitpanel-head">
        <span>Changes</span>
        {git?.is_repo && <span className="gp-branch">⎇ {git.branch}</span>}
        <button className="gp-refresh" title="Refresh" onClick={refresh}>
          ↻
        </button>
      </div>

      {!git?.is_repo ? (
        <div className="gp-empty">Not a git repository.</div>
      ) : (
        <>
          {(behind > 0 || ahead > 0) && (
            <div className="gp-sync">
              <div className="gp-sync-state">
                {behind > 0 && <span className="gp-behind">↓ {behind} behind</span>}
                {ahead > 0 && <span className="gp-ahead">↑ {ahead} ahead</span>}
              </div>
              <div className="gp-sync-actions">
                {behind > 0 && (
                  <button
                    className="btn-sm primary"
                    disabled={busy}
                    onClick={() => runSync(() => gitPull(cwd), "pulled")}
                  >
                    Pull
                  </button>
                )}
                {ahead > 0 && (
                  <button
                    className="btn-sm"
                    disabled={busy}
                    onClick={() => runSync(() => gitPush(cwd), "pushed")}
                  >
                    Push
                  </button>
                )}
                {behind > 0 && (
                  <button
                    className="btn-sm"
                    disabled={!canAsk}
                    title={canAsk ? "Have the agent pull & resolve conflicts" : "No live agent"}
                    onClick={() =>
                      onAskAgent(
                        "The remote has new commits. Please pull and merge them into this branch, resolving any merge conflicts carefully, then summarize what changed.",
                      )
                    }
                  >
                    Merge via agent
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="gp-files-head">
            <span>Files</span>
            {changes.length > 0 && (
              <button className="gp-viewall" onClick={() => onOpenDiff(null)}>
                view all diff
              </button>
            )}
          </div>
          <ul className="gp-files">
            {changes.map((c) => (
              <li key={c.path}>
                <button
                  className="gp-file"
                  onClick={() => onOpenDiff(c.path)}
                  title="View diff"
                >
                  <span className={`gp-status ${statusClass(c.status)}`}>
                    {c.status.trim() || "•"}
                  </span>
                  <span className="gp-path">{c.path}</span>
                </button>
              </li>
            ))}
            {changes.length === 0 && <li className="gp-clean">working tree clean</li>}
          </ul>

          <div className="gp-actions">
            <input
              className="gp-msg"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="commit message (optional for agent)"
            />
            <button
              className="btn"
              onClick={askAgent}
              disabled={!canAsk}
              title={canAsk ? "Send commit & push instruction to the active agent" : "No live agent"}
            >
              Ask agent to commit &amp; push
            </button>
            <button
              className="btn-ghost"
              onClick={directCommit}
              disabled={busy || !message.trim() || changes.length === 0}
              title="Commit & push directly via git"
            >
              {busy ? "Working…" : "Commit & push (direct)"}
            </button>
            {result && <div className="gp-ok">{result}</div>}
            {error && <div className="gp-err">{error}</div>}
          </div>
        </>
      )}
    </aside>
  );
}
