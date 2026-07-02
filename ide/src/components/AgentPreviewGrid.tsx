import { useEffect, useRef, useState } from "react";
import AgentTerminal from "./AgentTerminal";

export interface PreviewAgent {
  id: string;
  title: string;
  /** Blocked waiting for input → "halted" (needs you). */
  waiting: boolean;
  /** Owning project id (for the "Open project" action in the expanded dialog). */
  projectId?: string;
  /** Shown in the tile header (used on the cross-project Home). */
  projectName?: string;
  /** A waiting agent's choices (numbered menu, or judge-inferred). */
  options?: string[];
  /** What the waiting agent is asking. */
  question?: string;
  /** true → choices are free-text (send the label), not a numbered menu. */
  textMode?: boolean;
}

// How long after the last byte of output an agent still counts as "working".
// Generous so a momentarily-quiet agent doesn't flip to "idle" too eagerly.
const ACTIVE_MS = 5000;

type Activity = "working" | "halted" | "idle";

const LABEL: Record<Activity, string> = {
  working: "working",
  halted: "halted — needs you",
  idle: "idle",
};

// A responsive grid of live terminal thumbnails — two per row, ~100px tall,
// rendering the real pty output read-only (scaled, never resizing the shared
// pty). Waiting agents sort first. Clicking a tile EXPANDS it into a dialog (a
// bigger live view + Open project / Open terminal), rather than navigating away.
export default function AgentPreviewGrid({
  agents,
  termMode,
  onOpen,
  onOpenProject,
  onContinue,
  onYes,
  onNo,
  onPick,
}: {
  agents: PreviewAgent[];
  termMode: "light" | "dark";
  /** Open this agent's main terminal page. */
  onOpen: (id: string) => void;
  /** Jump to the owning project's workspace. */
  onOpenProject?: (projectId: string) => void;
  /** Nudge a waiting agent to keep going (accepts its current prompt). */
  onContinue?: (id: string) => void;
  /** Answer a yes/no prompt (when there's no explicit numbered menu). */
  onYes?: (id: string) => void;
  onNo?: (id: string) => void;
  /** Pick a waiting agent's numbered choice (1-based) by its label. */
  onPick?: (id: string, n: number, label: string) => void;
}) {
  // id → timestamp of the last output byte we saw (drives working vs idle).
  const lastOutRef = useRef<Record<string, number>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // A 1s heartbeat so the working/idle state re-renders as output goes quiet.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => !document.hidden && setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Seed a "just appeared" timestamp so a freshly-shown agent reads as working
  // for the grace window instead of flashing "idle" before any output arrives.
  useEffect(() => {
    const now = Date.now();
    for (const a of agents) {
      if (lastOutRef.current[a.id] == null) lastOutRef.current[a.id] = now;
    }
  }, [agents]);

  if (agents.length === 0) return null;

  // Needs-input first, so the agents you have to deal with sit at the top.
  const ordered = [...agents].sort((a, b) => Number(b.waiting) - Number(a.waiting));

  const activityOf = (a: PreviewAgent): Activity => {
    if (a.waiting) return "halted";
    const last = lastOutRef.current[a.id] ?? 0;
    return Date.now() - last < ACTIVE_MS ? "working" : "idle";
  };

  const expanded = expandedId ? agents.find((a) => a.id === expandedId) ?? null : null;

  // The per-agent action row (Continue / Yes / No), shown when an agent is
  // waiting but offered no explicit numbered menu. Multiple options, not one.
  const actionRow = (a: PreviewAgent) => (
    <div className="phome-preview-yn">
      {onContinue && (
        <button
          className="phome-preview-continue primary"
          onClick={(e) => {
            e.stopPropagation();
            onContinue(a.id);
          }}
          title="Continue — accept the current prompt and keep going"
        >
          ▶ Continue
        </button>
      )}
      {onYes && (
        <button className="phome-preview-continue" onClick={(e) => { e.stopPropagation(); onYes(a.id); }}>
          Yes
        </button>
      )}
      {onNo && (
        <button className="phome-preview-continue" onClick={(e) => { e.stopPropagation(); onNo(a.id); }}>
          No
        </button>
      )}
    </div>
  );

  const choiceRow = (a: PreviewAgent) => (
    <div className="phome-preview-choices">
      {a.question && (
        <span className="phome-preview-q" title={a.question}>“{a.question}”</span>
      )}
      {(a.options ?? []).map((label, i) => (
        <button
          key={i}
          className={`phome-preview-choice ${i === 0 ? "primary" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onPick?.(a.id, i + 1, label);
          }}
          title={a.textMode ? `Reply “${label}”` : `Send ${i + 1} + Enter`}
        >
          {!a.textMode && <span className="phome-preview-choice-n">{i + 1}</span>}
          <span className="phome-preview-choice-label">{label}</span>
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="phome-previews">
        {ordered.map((a) => {
          const act = activityOf(a);
          const hasChoices = a.waiting && (a.options?.length ?? 0) > 0;
          return (
            <div key={a.id} className={`phome-preview ${act}`}>
              <div className="phome-preview-head">
                <span className={`activity-dot ${act}`} aria-hidden="true" />
                <span className="phome-preview-title" title={a.title}>{a.title}</span>
                {a.projectName && <span className="phome-preview-proj">{a.projectName}</span>}
                <span className={`phome-preview-state ${act}`}>{LABEL[act]}</span>
              </div>

              {hasChoices ? choiceRow(a) : a.waiting ? actionRow(a) : null}

              <div className="phome-preview-term">
                <AgentTerminal
                  id={a.id}
                  active={false}
                  mode={termMode}
                  preview
                  onOutput={() => {
                    lastOutRef.current[a.id] = Date.now();
                  }}
                />
                {/* Click expands the tile into a dialog (not navigate). */}
                <button
                  className="phome-preview-open"
                  onClick={() => setExpandedId(a.id)}
                  title="Expand"
                  aria-label={`Expand ${a.title}`}
                />
              </div>
            </div>
          );
        })}
      </div>

      {expanded && (
        <div className="preview-modal" onClick={() => setExpandedId(null)} role="dialog" aria-modal="true">
          <div className="preview-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="preview-modal-head">
              <span className={`activity-dot ${activityOf(expanded)}`} aria-hidden="true" />
              <span className="preview-modal-title">{expanded.title}</span>
              {expanded.projectName && (
                <span className="phome-preview-proj">{expanded.projectName}</span>
              )}
              <button className="set-x" onClick={() => setExpandedId(null)} aria-label="Close">✕</button>
            </div>

            {expanded.waiting &&
              ((expanded.options?.length ?? 0) > 0 ? choiceRow(expanded) : actionRow(expanded))}

            <div className="preview-modal-term">
              <AgentTerminal
                id={expanded.id}
                active={false}
                mode={termMode}
                preview
                onOutput={() => {
                  lastOutRef.current[expanded.id] = Date.now();
                }}
              />
            </div>

            <div className="preview-modal-actions">
              {onOpenProject && expanded.projectId && (
                <button
                  className="btn-ghost"
                  onClick={() => {
                    onOpenProject(expanded.projectId!);
                    setExpandedId(null);
                  }}
                >
                  Open project →
                </button>
              )}
              <button
                className="btn primary"
                onClick={() => {
                  onOpen(expanded.id);
                  setExpandedId(null);
                }}
              >
                Open terminal →
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
