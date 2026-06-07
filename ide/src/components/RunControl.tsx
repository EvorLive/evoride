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
}: {
  services: Service[];
  running: Record<string, boolean>;
  onStart: (s: Service) => void;
  onStop: (s: Service) => void;
  onCreateConfig: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isRunning = (s: Service) => !!running[s.name];

  if (services.length <= 1) {
    const s = services[0];
    if (!s) {
      return (
        <button className="btn-sm primary" disabled title="No run command">
          ▷ Run
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
        </div>
      )}
    </div>
  );
}
