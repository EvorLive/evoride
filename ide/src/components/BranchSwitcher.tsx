import { useEffect, useState } from "react";
import { gitBranches, gitCheckout, gitCreateBranch } from "../lib/tauri";

// Popover anchored to the status-bar branch: list/checkout/create branches.
export default function BranchSwitcher({
  cwd,
  current,
  onClose,
  onChanged,
}: {
  cwd: string;
  current: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [all, setAll] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    gitBranches(cwd).then((b) => setAll(b.all)).catch(() => {});
  }, [cwd]);

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = all.filter((b) => b.toLowerCase().includes(q));
  const canCreate = q.length > 0 && !all.some((b) => b.toLowerCase() === q);

  return (
    <>
      <div className="branch-backdrop" onClick={onClose} />
      <div className="branch-pop" onClick={(e) => e.stopPropagation()}>
        <div className="branch-pop-head">Switch branch</div>
        <input
          className="branch-filter"
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter or new branch name…"
        />
        <ul className="branch-list">
          {shown.map((b) => (
            <li key={b}>
              <button
                className={`branch-item ${b === current ? "current" : ""}`}
                disabled={busy || b === current}
                onClick={() => act(() => gitCheckout(cwd, b))}
              >
                <span className="branch-check">{b === current ? "✓" : ""}</span>
                <span className="branch-name">{b}</span>
              </button>
            </li>
          ))}
          {shown.length === 0 && !canCreate && (
            <li className="branch-empty">No branches</li>
          )}
        </ul>
        {canCreate && (
          <button
            className="branch-create"
            disabled={busy}
            onClick={() => act(() => gitCreateBranch(cwd, filter.trim()))}
          >
            ＋ Create branch “{filter.trim()}”
          </button>
        )}
        {error && <div className="branch-err">{error}</div>}
      </div>
    </>
  );
}
