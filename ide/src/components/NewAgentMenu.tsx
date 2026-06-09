import { useEffect, useRef, useState } from "react";
import type { AgentConfig } from "../lib/agents";

// The launcher's "new session" control. Lists every CONFIGURED agent (not just
// the enabled ones) so each agent's enable/disable switch lives right where you
// start a session — disable one to park it and flip it back on later, no trip to
// Settings. Enabled agents launch; disabled ones are muted until toggled on.
export default function NewAgentMenu({
  agents,
  onLaunch,
  onToggle,
}: {
  agents: AgentConfig[];
  onLaunch: (a: AgentConfig) => void;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="newagent" ref={ref}>
      <button
        className="btn-sm icon"
        onClick={() => setOpen((o) => !o)}
        title="New session"
        aria-label="New session"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ✦ ▾
      </button>
      {open && (
        <div className="newagent-menu" role="menu">
          <div className="newagent-head">New session</div>
          {agents.map((a) => (
            <div key={a.id} className={`newagent-row ${a.enabled ? "" : "off"}`}>
              <button
                className="newagent-launch"
                disabled={!a.enabled}
                onClick={() => {
                  onLaunch(a);
                  setOpen(false);
                }}
                title={a.enabled ? `Start ${a.label}` : `${a.label} is off — toggle it on to use it`}
              >
                <span className="newagent-plus">＋</span>
                <span className="newagent-name">{a.label}</span>
                {!a.enabled && <span className="newagent-off-tag">off</span>}
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={a.enabled}
                className={`set-switch sm ${a.enabled ? "on" : ""}`}
                onClick={() => onToggle(a.id, !a.enabled)}
                title={a.enabled ? "Disable (hide from the launcher)" : "Enable"}
              >
                <span className="set-knob" />
              </button>
            </div>
          ))}
          <div className="newagent-foot">Toggle an agent to enable/disable it everywhere.</div>
        </div>
      )}
    </div>
  );
}
