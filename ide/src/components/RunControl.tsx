import { useState } from "react";
import type { Service } from "../lib/tauri";

// Run/Stop control. One service → a single toggle button; multiple (monorepo) →
// a dropdown with per-service start/stop. The raw shell command is never shown
// (kept silent, only in a tooltip); instead a running/ran service offers a
// "view console" action to inspect its live logs in its terminal.
export default function RunControl({
  services,
  running,
  viewable,
  onStart,
  onStop,
  onView,
  onCreateConfig,
  onSetupAi,
}: {
  services: Service[];
  running: Record<string, boolean>;
  /** Service name → has a terminal to inspect (running or stopped-with-logs). */
  viewable: Record<string, boolean>;
  onStart: (s: Service) => void;
  onStop: (s: Service) => void;
  onView: (s: Service) => void;
  onCreateConfig: () => void;
  onSetupAi: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isRunning = (s: Service) => !!running[s.name];
  const canView = (s: Service) => !!viewable[s.name];

  if (services.length <= 1) {
    const s = services[0];
    if (!s || !s.command.trim()) {
      // No runnable command detected → offer AI setup (writes runinfo.json).
      return (
        <button
          className="btn-sm primary"
          onClick={onSetupAi}
          title="Let an agent figure out how to run this (Docker, monorepo, custom) and configure it"
        >
          ✨ Set up run
        </button>
      );
    }
    return (
      <span className="run-single">
        {isRunning(s) ? (
          <button className="btn-sm stop" onClick={() => onStop(s)} title={s.command}>
            ■ Stop
          </button>
        ) : (
          <button
            className="btn-sm primary"
            onClick={() => onStart(s)}
            title={`Start the ${s.name} service${s.command ? ` (${s.command})` : ""}`}
          >
            ▷ Run service
          </button>
        )}
        {canView(s) && (
          <button className="btn-sm icon" onClick={() => onView(s)} title="View console / logs">
            ⛶
          </button>
        )}
        <button className="btn-sm icon" onClick={onSetupAi} title="Regenerate run config with AI">
          ✨
        </button>
      </span>
    );
  }

  const anyRunning = services.some(isRunning);

  return (
    <div className="run-control">
      <button
        className="btn-sm primary"
        onClick={() => setOpen((o) => !o)}
        title="Start / stop the project's services"
      >
        {anyRunning ? "● Services ▾" : "▷ Services ▾"}
      </button>
      {open && (
        <div className="run-menu" onMouseLeave={() => setOpen(false)}>
          {services.map((s) => (
            <div key={s.name} className="run-item" title={s.command}>
              <span className="run-name">{s.name}</span>
              {canView(s) && (
                <button className="run-toggle view" onClick={() => onView(s)} title="View console / logs">
                  ⛶
                </button>
              )}
              {isRunning(s) ? (
                <button className="run-toggle stop" onClick={() => onStop(s)} title="Stop">
                  ■
                </button>
              ) : (
                <button className="run-toggle" onClick={() => onStart(s)} title="Start">
                  ▷
                </button>
              )}
            </div>
          ))}
          <div className="run-menu-sep" />
          <button
            className="run-all"
            onClick={() => services.forEach((s) => !isRunning(s) && onStart(s))}
          >
            Start all
          </button>
          <button
            className="run-all"
            onClick={() => services.forEach((s) => isRunning(s) && onStop(s))}
          >
            Stop all
          </button>
          <button className="run-all" onClick={onCreateConfig}>
            ⚙ Refresh run config
          </button>
          <button className="run-all" onClick={onSetupAi}>
            ✨ Set up run with AI
          </button>
        </div>
      )}
    </div>
  );
}
