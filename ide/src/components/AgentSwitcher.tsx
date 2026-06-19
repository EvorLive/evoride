import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRecord } from "../lib/tauri";
import { fuzzyScore } from "./CommandPalette";

export interface SwitcherItem {
  agent: AgentRecord;
  /** Display name of the agent's project (falls back to its id). */
  projectName: string;
  /** Whether the agent's terminal is live in this window right now. */
  live: boolean;
  /** Whether the agent is blocking on user input ("needs you"). */
  waiting: boolean;
}

// Quick agent / window switcher: a ⌘E overlay listing every running agent across
// all open projects so you can fuzzy-jump straight to one. Modelled on the
// command palette (same scrim/box/list styling and keyboard model) but each row
// is an agent, grouped by status and tagged with its project.
export default function AgentSwitcher({
  open,
  items,
  onSelect,
  onClose,
}: {
  open: boolean;
  items: SwitcherItem[];
  onSelect: (agent: AgentRecord) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset + focus on open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return items;
    const scored: { item: SwitcherItem; score: number }[] = [];
    for (const item of items) {
      // Match against title, command, and project so any of them can find it.
      const hay = `${item.agent.title} ${item.agent.command} ${item.projectName}`;
      const s = fuzzyScore(q, hay);
      if (s !== null) scored.push({ item, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.item);
  }, [query, items]);

  const count = results.length;

  // Keep selection in range as the result set shrinks.
  useEffect(() => {
    setSelected((s) => (count === 0 ? 0 : Math.min(s, count - 1)));
  }, [count]);

  // Reset selection to the top whenever the query changes.
  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Scroll the selected row into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${selected}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selected, count]);

  if (!open) return null;

  const run = (idx: number) => {
    const item = results[idx];
    if (item) {
      onSelect(item.agent);
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (count === 0 ? 0 : (s + 1) % count));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => (count === 0 ? 0 : (s - 1 + count) % count));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="cp-scrim" onMouseDown={onClose}>
      <div className="cp-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cp-input-row">
          <input
            ref={inputRef}
            className="cp-input"
            autoFocus
            spellCheck={false}
            placeholder="Switch to a running agent…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="cp-mode">Switch agent</span>
        </div>

        <div className="cp-list" ref={listRef}>
          {items.length === 0 ? (
            <div className="cp-empty">No running agents</div>
          ) : count === 0 ? (
            <div className="cp-empty">No matches</div>
          ) : (
            results.map((item, idx) => (
              <button
                key={item.agent.id}
                data-idx={idx}
                className={`cp-row sw-row ${idx === selected ? "sel" : ""}`}
                onMouseEnter={() => setSelected(idx)}
                onClick={() => run(idx)}
                title={`${item.agent.title} — ${item.projectName}`}
              >
                <span
                  className={`dot ${item.waiting ? "dot-wait" : item.live ? "dot-live" : "dot-dead"}`}
                />
                <span className="sw-title">{item.agent.title}</span>
                {item.waiting && <span className="agent-wait-pill">needs you</span>}
                <span className="sw-cmd">{item.agent.command || "shell"}</span>
                <span className="sw-project">{item.projectName}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
