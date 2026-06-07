import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

// A simple subsequence fuzzy scorer: every query char must appear in order.
// Higher score = more contiguous + earlier match. Returns null on no match.
function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let ti = 0;
  let lastMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (; ti < t.length; ti++) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
    }
    if (found === -1) return null;
    // Reward contiguous matches and earlier positions.
    if (found === lastMatch + 1) score += 6;
    else score += 1;
    score -= Math.min(found, 20) * 0.05;
    lastMatch = found;
    ti = found + 1;
  }
  // Bonus when the match starts at the basename.
  const slash = t.lastIndexOf("/");
  if (slash >= 0 && t.indexOf(q[0]) > slash) score += 2;
  return score;
}

const MAX_RESULTS = 50;

function splitPath(rel: string): { base: string; dir: string } {
  const i = rel.lastIndexOf("/");
  if (i === -1) return { base: rel, dir: "" };
  return { base: rel.slice(i + 1), dir: rel.slice(0, i) };
}

export default function CommandPalette({
  open,
  mode,
  files,
  commands,
  projectPath,
  onOpenFile,
  onClose,
}: {
  open: boolean;
  mode: "files" | "commands";
  files: string[];
  commands: Command[];
  projectPath: string | null;
  onOpenFile: (relPath: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset on open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      // autoFocus is unreliable across re-mounts; force it.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, mode]);

  // A leading ">" forces command mode regardless of the prop.
  const forcedCommand = query.startsWith(">");
  const effectiveMode: "files" | "commands" =
    forcedCommand ? "commands" : mode;
  const rawQuery = forcedCommand ? query.slice(1).trim() : query.trim();

  const fileResults = useMemo(() => {
    if (effectiveMode !== "files") return [];
    if (!rawQuery) return files.slice(0, MAX_RESULTS);
    const scored: { rel: string; score: number }[] = [];
    for (const rel of files) {
      const s = fuzzyScore(rawQuery, rel);
      if (s !== null) scored.push({ rel, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((x) => x.rel);
  }, [effectiveMode, rawQuery, files]);

  const commandResults = useMemo(() => {
    if (effectiveMode !== "commands") return [];
    if (!rawQuery) return commands;
    const scored: { cmd: Command; score: number }[] = [];
    for (const cmd of commands) {
      const s = fuzzyScore(rawQuery, cmd.label);
      if (s !== null) scored.push({ cmd, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.cmd);
  }, [effectiveMode, rawQuery, commands]);

  const count =
    effectiveMode === "files" ? fileResults.length : commandResults.length;

  // Keep selection in range when the result set changes.
  useEffect(() => {
    setSelected((s) => (count === 0 ? 0 : Math.min(s, count - 1)));
  }, [count]);

  // Reset selection to top whenever the query changes.
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
    if (effectiveMode === "files") {
      const rel = fileResults[idx];
      if (rel) {
        onOpenFile(rel);
        onClose();
      }
    } else {
      const cmd = commandResults[idx];
      if (cmd) {
        cmd.run();
        onClose();
      }
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

  const noProject = effectiveMode === "files" && !projectPath;
  const hint =
    effectiveMode === "files"
      ? "Go to File"
      : "Commands · type to filter";

  return (
    <div className="cp-scrim" onMouseDown={onClose}>
      <div className="cp-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cp-input-row">
          <input
            ref={inputRef}
            className="cp-input"
            autoFocus
            spellCheck={false}
            placeholder={
              effectiveMode === "files"
                ? "Search files by name…"
                : "Type a command… (or > to filter)"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="cp-mode">{hint}</span>
        </div>

        <div className="cp-list" ref={listRef}>
          {noProject ? (
            <div className="cp-empty">Open a project first.</div>
          ) : count === 0 ? (
            <div className="cp-empty">No matches</div>
          ) : effectiveMode === "files" ? (
            fileResults.map((rel, idx) => {
              const { base, dir } = splitPath(rel);
              return (
                <button
                  key={rel}
                  data-idx={idx}
                  className={`cp-row ${idx === selected ? "sel" : ""}`}
                  onMouseEnter={() => setSelected(idx)}
                  onClick={() => run(idx)}
                  title={rel}
                >
                  <span className="cp-file-base">{base}</span>
                  {dir && <span className="cp-file-dir">{dir}</span>}
                </button>
              );
            })
          ) : (
            commandResults.map((cmd, idx) => (
              <button
                key={cmd.id}
                data-idx={idx}
                className={`cp-row ${idx === selected ? "sel" : ""}`}
                onMouseEnter={() => setSelected(idx)}
                onClick={() => run(idx)}
                title={cmd.label}
              >
                <span className="cp-cmd-label">{cmd.label}</span>
                {cmd.hint && <span className="cp-cmd-hint">{cmd.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
