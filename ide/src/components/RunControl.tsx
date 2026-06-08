import { useState } from "react";
import type { Service } from "../lib/tauri";

// Run/Stop control. One service → a single toggle button; multiple (monorepo) →
// a dropdown with per-service start/stop.
export default function RunControl({
  services,
  running,
  onStart,
  onStop,
  onCreateConfig,
  onSetupAi,
}: {
  services: Service[];
  running: Record<string, boolean>;
  onStart: (s: Service) => void;
  onStop: (s: Service) => void;
  onCreateConfig: () => void;
  onSetupAi: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isRunning = (s: Service) => !!running[s.name];

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
    return isRunning(s) ? (
      <button className="btn-sm stop" onClick={() => onStop(s)} title={s.command}>
        ■ Stop
      </button>
    ) : (
      <button
        className="btn-sm primary"
        onClick={() => onStart(s)}
        title={s.command || "$SHELL"}
      >
        ▷ Run
      </button>
    );
  }

  const anyRunning = services.some(isRunning);

  return (
    <div className="run-control">
      <button className="btn-sm primary" onClick={() => setOpen((o) => !o)}>
        {anyRunning ? "▷ Services ▾" : "▷ Run ▾"}
      </button>
      {open && (
        <div className="run-menu" onMouseLeave={() => setOpen(false)}>
          {services.map((s) => (
            <div key={s.name} className="run-item">
              <span className="run-name">{s.name}</span>
              <span className="run-cmd" title={s.command}>
                {s.command}
              </span>
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
