import { useEffect, useRef, useState } from "react";
import AgentTerminal from "./AgentTerminal";

export interface PreviewAgent {
  id: string;
  title: string;
  /** Blocked waiting for input → "halted" (needs you). */
  waiting: boolean;
  /** Shown in the tile header (used on the cross-project Home). */
  projectName?: string;
}

// How long after the last byte of output an agent still counts as "working".
const ACTIVE_MS = 2500;

type Activity = "working" | "halted" | "idle";

// A responsive grid of live terminal thumbnails — two per row (≈50% width),
// each ~100px tall. The terminals render the real pty output read-only (scaled
// to fit, never resizing the shared pty); a click opens the agent's full page.
// Each tile carries an activity indicator: working (producing output), halted
// (waiting for your input), or idle (live but quiet — not working). Agents that
// need input are always shown first. Used by the project overview and Home.
export default function AgentPreviewGrid({
  agents,
  termMode,
  onOpen,
  onContinue,
}: {
  agents: PreviewAgent[];
  termMode: "light" | "dark";
  /** Open this agent's main terminal page. */
  onOpen: (id: string) => void;
  /** Nudge a waiting agent to keep going (accepts its current prompt). */
  onContinue?: (id: string) => void;
}) {
  // id → timestamp of the last output byte we saw (drives working vs idle).
  const lastOutRef = useRef<Record<string, number>>({});
  // A 1s heartbeat so the working/idle state re-renders as output goes quiet.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (agents.length === 0) return null;

  // Needs-input first, so the agents you have to deal with sit at the top.
  const ordered = [...agents].sort(
    (a, b) => Number(b.waiting) - Number(a.waiting),
  );

  const activityOf = (a: PreviewAgent): Activity => {
    if (a.waiting) return "halted";
    const last = lastOutRef.current[a.id] ?? 0;
    return Date.now() - last < ACTIVE_MS ? "working" : "idle";
  };

  const LABEL: Record<Activity, string> = {
    working: "working",
    halted: "halted — needs you",
    idle: "idle",
  };

  return (
    <div className="phome-previews">
      {ordered.map((a) => {
        const act = activityOf(a);
        return (
          <div key={a.id} className={`phome-preview ${act}`}>
            <div className="phome-preview-head">
              <span className={`activity-dot ${act}`} aria-hidden="true" />
              <span className="phome-preview-title" title={a.title}>
                {a.title}
              </span>
              {a.projectName && (
                <span className="phome-preview-proj">{a.projectName}</span>
              )}
              <span className={`phome-preview-state ${act}`}>{LABEL[act]}</span>
              {a.waiting && onContinue && (
                <button
                  className="phome-preview-continue"
                  onClick={(e) => {
                    e.stopPropagation();
                    onContinue(a.id);
                  }}
                  title="Continue — accept the current prompt and keep going"
                >
                  ▶ Continue
                </button>
              )}
            </div>
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
              {/* Transparent overlay: a click opens the agent's main page instead
                  of typing into the (read-only) thumbnail. */}
              <button
                className="phome-preview-open"
                onClick={() => onOpen(a.id)}
                title="Open this agent’s terminal"
                aria-label={`Open ${a.title}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
