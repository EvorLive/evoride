import { useEffect, useState } from "react";
import { intentConfig, readIntent, setIntent, updateIntent, type IntentConfig } from "../lib/tauri";
import Markdown from "./Markdown";

// Right panel: the project's living intent doc (.evoride/intent.md) + the
// per-project enable toggle. Committed alongside the code.
export default function IntentPanel({ projectPath }: { projectPath: string }) {
  const [cfg, setCfg] = useState<IntentConfig | null>(null);
  const [doc, setDoc] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    intentConfig(projectPath).then(setCfg).catch(() => {});
    readIntent(projectPath).then(setDoc).catch(() => {});
  };
  useEffect(load, [projectPath]);

  const toggle = async () => {
    if (!cfg) return;
    setBusy(true);
    try {
      const next = await setIntent(projectPath, !cfg.enabled, cfg.mode || "both");
      setCfg(next);
      readIntent(projectPath).then(setDoc).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const updated = await updateIntent(projectPath);
      setDoc(updated);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="intent">
      <div className="intent-head">
        <span>Intent</span>
        <label className="intent-switch" title="Maintain intent doc for this project">
          <input
            type="checkbox"
            checked={!!cfg?.enabled}
            onChange={toggle}
            disabled={busy}
          />
          <span>{cfg?.enabled ? "on" : "off"}</span>
        </label>
      </div>

      {cfg?.enabled ? (
        <>
          <div className="intent-sub">
            mode: {cfg.mode} · {cfg.path}
            <button className="intent-refresh" onClick={refresh} disabled={busy} title="Update from session">
              ↻
            </button>
          </div>
          <div className="intent-doc">
            <Markdown text={doc || "_(empty)_"} />
          </div>
        </>
      ) : (
        <div className="intent-off">
          <p>
            Capture what this project is for using <strong>IntentFlow</strong> —
            a committed <code>.intentflow/</code> with vision + a timeline. EvorIDE
            distills entries from your sessions and credits <em>who</em> wrote the
            intent and <em>which coding agent</em> was used; the agent keeps it
            current too. Because it lives in the repo, any IDE opening the project
            sees it.
          </p>
          <button className="btn" onClick={toggle} disabled={busy}>
            Enable IntentFlow
          </button>
        </div>
      )}
    </aside>
  );
}
