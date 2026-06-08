import { useEffect, useState } from "react";
import * as api from "../lib/tauri";
import type { AgentConfig } from "../lib/agents";

// A simple on/off switch row.
function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="set-row">
      <span className="set-row-text">
        <span className="set-row-label">{label}</span>
        {hint && <span className="set-row-hint">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`set-switch ${checked ? "on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="set-knob" />
      </button>
    </label>
  );
}

// Preferences dialog — opened from the File ▸ Settings… menu (⌘,), the gear
// icon, or the command palette. Works the same on macOS and Windows.
export default function SettingsDialog({
  open,
  onClose,
  version,
  theme,
  setTheme,
  alwaysOnTop,
  setAlwaysOnTop,
  judgeEnabled,
  setJudgeEnabled,
  agents,
  setAgents,
}: {
  open: boolean;
  onClose: () => void;
  version: string;
  theme: "system" | "light" | "dark";
  setTheme: (t: "system" | "light" | "dark") => void;
  alwaysOnTop: boolean;
  setAlwaysOnTop: (v: boolean) => void;
  judgeEnabled: boolean;
  setJudgeEnabled: (v: boolean) => void;
  agents: AgentConfig[];
  setAgents: (a: AgentConfig[]) => void;
}) {
  const [dailySummary, setDailySummary] = useState(true);
  const [helper, setHelper] = useState<string | null>(null);
  // Resolved program path per agent id (null = not found).
  const [detected, setDetected] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (!open) return;
    api.getSettings().then((s) => setDailySummary(s.daily_summary)).catch(() => {});
    api.judgeHelper().then(setHelper).catch(() => {});
  }, [open]);

  // Resolve each agent's program so we can show detected ✓ / not-found ✗.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all(
      agents.map((a) =>
        a.command.trim()
          ? api.whichAgent(a.command).then((p) => [a.id, p] as const).catch(() => [a.id, null] as const)
          : Promise.resolve([a.id, ""] as const),
      ),
    ).then((pairs) => {
      if (!cancelled) setDetected(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [open, agents]);

  const updateAgent = (id: string, patch: Partial<AgentConfig>) =>
    setAgents(agents.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const toggleDaily = (v: boolean) => {
    setDailySummary(v);
    api.setDailySummary(v).catch(() => {});
  };

  return (
    <div className="set-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="set-modal" onClick={(e) => e.stopPropagation()}>
        <div className="set-head">
          <span className="set-title">Settings</span>
          <button className="set-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="set-body">
          <div className="set-section">
            <div className="set-section-title">Appearance</div>
            <div className="set-row">
              <span className="set-row-text">
                <span className="set-row-label">Theme</span>
                <span className="set-row-hint">Follow the system, or force light / dark.</span>
              </span>
              <div className="set-seg">
                {(["system", "light", "dark"] as const).map((t) => (
                  <button
                    key={t}
                    className={`set-seg-btn ${theme === t ? "on" : ""}`}
                    onClick={() => setTheme(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="set-section">
            <div className="set-section-title">Window</div>
            <Toggle
              label="Keep window always on top"
              hint="“Stick out” above other apps. Off by default."
              checked={alwaysOnTop}
              onChange={setAlwaysOnTop}
            />
          </div>

          <div className="set-section">
            <div className="set-section-title">Agents</div>
            <Toggle
              label="AI idle analyzer"
              hint={
                helper
                  ? `Uses ${helper} to tell “needs you” from “just idle”. Runs only when an agent is idle.`
                  : "No claude/codex found on PATH — analyzer is unavailable."
              }
              checked={judgeEnabled && !!helper}
              onChange={setJudgeEnabled}
            />
            <Toggle
              label="Daily summary on Home"
              hint="Show a generated activity summary on the Home dashboard."
              checked={dailySummary}
              onChange={toggleDaily}
            />
          </div>

          <div className="set-section">
            <div className="set-section-title">Agent CLIs</div>
            <p className="set-row-hint" style={{ marginBottom: 8 }}>
              Enable the agents you use. Leave the path on <b>automatic</b> to find it on your
              PATH, or set an explicit path if it isn’t found.
            </p>
            {agents.map((a) => {
              const det = detected[a.id];
              const isShell = a.command.trim() === "";
              return (
                <div className="agent-cfg" key={a.id}>
                  <div className="agent-cfg-top">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={a.enabled}
                      className={`set-switch ${a.enabled ? "on" : ""}`}
                      onClick={() => updateAgent(a.id, { enabled: !a.enabled })}
                    >
                      <span className="set-knob" />
                    </button>
                    <span className="agent-cfg-name">{a.label}</span>
                    {isShell ? (
                      <span className="agent-cfg-ok">default shell</span>
                    ) : det ? (
                      <span className="agent-cfg-ok" title={det}>
                        ✓ found
                      </span>
                    ) : det === "" ? null : (
                      <span className="agent-cfg-bad">✗ not found</span>
                    )}
                  </div>
                  {!isShell && (
                    <input
                      className="agent-cfg-path"
                      value={a.command}
                      placeholder="automatic (on PATH) — e.g. claude, or /full/path/to/claude"
                      onChange={(e) => updateAgent(a.id, { command: e.target.value })}
                      spellCheck={false}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div className="set-section">
            <div className="set-section-title">About</div>
            <div className="set-about">
              <span>EvorIDE{version ? ` v${version}` : ""}</span>
              <a
                href="https://github.com/EvorLive/evoride"
                target="_blank"
                rel="noreferrer"
              >
                github.com/EvorLive/evoride
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
