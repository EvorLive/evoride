import { useEffect, useState } from "react";
import type { CliDef } from "../lib/clis";

// "Set up / regenerate run with AI": pick which agent does it, optionally add an
// initial prompt (e.g. extra context or what to do after), then generate. The
// spawned agent is a real chat session you can keep talking to.
export default function RunSetupDialog({
  open,
  onClose,
  clis,
  regenerate,
  onGenerate,
}: {
  open: boolean;
  onClose: () => void;
  clis: CliDef[];
  /** True when a config already exists (wording: regenerate). */
  regenerate: boolean;
  onGenerate: (command: string, extra: string) => void;
}) {
  // Only AI agents make sense here (a plain shell can't author the config).
  const agents = clis.filter((c) => c.command.trim());
  const [command, setCommand] = useState<string>("");
  const [extra, setExtra] = useState("");

  useEffect(() => {
    if (open) {
      const claude = agents.find((a) => a.id === "claude");
      setCommand((claude ?? agents[0])?.command ?? "claude");
      setExtra("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="set-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="set-modal" style={{ width: 540 }} onClick={(e) => e.stopPropagation()}>
        <div className="set-head">
          <span className="set-title">{regenerate ? "Regenerate run with AI" : "Set up run with AI"}</span>
          <button className="set-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="set-body">
          <p className="set-row-hint" style={{ marginBottom: 14 }}>
            An agent inspects the project (incl. monorepo apps and Docker) and writes a run
            config EvorIDE will use — one entry per app. It’s a normal chat session, so you can
            keep directing it afterwards.
          </p>

          <div className="set-row">
            <span className="set-row-text">
              <span className="set-row-label">Agent</span>
              <span className="set-row-hint">Which agent does the setup.</span>
            </span>
            <select className="home-day-select" value={command} onChange={(e) => setCommand(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.command}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginTop: 8 }}>
            <span className="set-row-label">Initial prompt (optional)</span>
            <textarea
              className="agent-cfg-path"
              style={{ marginLeft: 0, width: "100%", minHeight: 70, resize: "vertical", marginTop: 6 }}
              value={extra}
              placeholder="e.g. only the web + api apps for now; use the staging .env; after configuring, run the DB migrations…"
              onChange={(e) => setExtra(e.target.value)}
            />
          </div>

          <div className="welcome-actions" style={{ marginTop: 18 }}>
            <button className="btn primary" onClick={() => onGenerate(command, extra.trim())} disabled={!command}>
              {regenerate ? "Regenerate" : "Generate run config"}
            </button>
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
