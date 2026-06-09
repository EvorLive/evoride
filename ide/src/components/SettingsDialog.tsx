import { useEffect, useState } from "react";
import * as api from "../lib/tauri";
import type { SkillInfo } from "../lib/tauri";
import type { AgentConfig } from "../lib/agents";

type Tab = "general" | "agents" | "skills" | "jira";

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

// The Jira tab: connect a Jira Cloud account and pull *your* issues in as tasks.
// No JQL, no upfront project mapping — issues arrive Unassigned (one board spans
// many repos) and you assign them yourself or let Claude do it.
function JiraTab() {
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState<"" | "test" | "save">("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    setMsg("");
    setErr("");
    setToken("");
    api
      .jiraConfigGet()
      .then((c) => {
        if (!c) return;
        setBaseUrl(c.base_url);
        setEmail(c.email);
        setHasToken(c.has_token);
      })
      .catch(() => {});
  }, []);

  // Save connection (token blank → keep stored). No JQL / mapping.
  const save = () =>
    api.jiraConfigSet({ baseUrl: baseUrl.trim(), email: email.trim(), token, jql: "", projectMap: {} });

  const run = async (kind: "test" | "save") => {
    setBusy(kind);
    setErr("");
    setMsg("");
    try {
      await save();
      setHasToken(true);
      setToken("");
      if (kind === "test") {
        const n = await api.jiraTest();
        setMsg(`Connected — ${n} issue${n === 1 ? "" : "s"} assigned to you. Import them from Tasks.`);
      } else {
        setMsg("Saved. Your assigned issues now show under Tasks to import.");
      }
    } catch (e) {
      setErr(typeof e === "string" ? e : (e as Error)?.message || "Something went wrong.");
    } finally {
      setBusy("");
    }
  };

  const disconnect = async () => {
    await api.jiraDisconnect().catch(() => {});
    setBaseUrl("");
    setEmail("");
    setToken("");
    setHasToken(false);
    setMsg("Disconnected.");
  };

  return (
    <div className="set-section">
      <div className="set-section-title">Jira</div>
      <p className="set-row-hint" style={{ marginBottom: 14 }}>
        Connect your Jira account; the issues assigned to you show up under Tasks, ready to import
        into your workflow. Create an API token at{" "}
        <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">
          id.atlassian.com → API tokens
        </a>
        .
      </p>

      <label className="jira-field">
        <span>Site URL</span>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-team.atlassian.net" spellCheck={false} />
      </label>
      <label className="jira-field">
        <span>Email</span>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" spellCheck={false} />
      </label>
      <label className="jira-field">
        <span>API token</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={hasToken ? "•••••••• (saved — leave blank to keep)" : "paste token"}
        />
      </label>

      {(msg || err) && <p className={`jira-status ${err ? "err" : ""}`}>{err || msg}</p>}

      <div className="jira-actions">
        <button className="btn primary" onClick={() => run("save")} disabled={!!busy}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <button className="btn" onClick={() => run("test")} disabled={!!busy}>
          {busy === "test" ? "Testing…" : "Test"}
        </button>
        {hasToken && (
          <button className="btn-ghost danger" onClick={disconnect} disabled={!!busy} style={{ marginLeft: "auto" }}>
            Disconnect
          </button>
        )}
      </div>
    </div>
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
  initialTab = "general",
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
  /** Which tab to open on (e.g. "jira" from the Home shortcut). */
  initialTab?: Tab;
  /** Called after a Jira sync / auto-assign so the board can refresh. */
  onTasksChanged?: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [dailySummary, setDailySummary] = useState(true);
  const [helper, setHelper] = useState<string | null>(null);
  const [detected, setDetected] = useState<Record<string, string | null>>({});
  // Bundled + git-installed skills with their state (loaded from the backend).
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  // Install-from-git state.
  const [repo, setRepo] = useState("");
  const [installing, setInstalling] = useState(false);
  const [skillMsg, setSkillMsg] = useState("");
  const [skillErr, setSkillErr] = useState("");

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    api.getSettings().then((s) => setDailySummary(s.daily_summary)).catch(() => {});
    api.judgeHelper().then(setHelper).catch(() => {});
    api.listSkills().then(setSkills).catch(() => {});
  }, [open]);

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

  // Toggle a skill: flip it locally for instant feedback, then persist + (un)install.
  const toggleSkill = (id: string, enabled: boolean) => {
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
    api.setSkillEnabled(id, enabled).catch(() => {});
  };

  const refreshSkills = () => api.listSkills().then(setSkills).catch(() => {});

  // Install a skill from a git repo — Claude Code clones, validates, installs.
  const installSkill = () => {
    const url = repo.trim();
    if (!url || installing) return;
    setInstalling(true);
    setSkillMsg("");
    setSkillErr("");
    api
      .installSkillFromGit(url)
      .then((msg) => {
        setSkillMsg(msg);
        setRepo("");
        return refreshSkills();
      })
      .catch((e) => setSkillErr(typeof e === "string" ? e : (e as Error)?.message || "Install failed."))
      .finally(() => setInstalling(false));
  };

  // Remove a git-installed (external) skill.
  const removeSkill = (id: string) => {
    setSkills((prev) => prev.filter((s) => s.id !== id));
    api.removeSkill(id).catch(() => {}).then(refreshSkills);
  };

  const TABS: { id: Tab; label: string }[] = [
    { id: "general", label: "General" },
    { id: "agents", label: "Agents" },
    { id: "skills", label: "Skills" },
    { id: "jira", label: "Jira" },
  ];

  return (
    <div className="set-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="set-modal" onClick={(e) => e.stopPropagation()}>
        <div className="set-head">
          <span className="set-title">Settings</span>
          <button className="set-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="set-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`set-tab ${tab === t.id ? "on" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="set-body">
          {tab === "general" && (
            <>
              <div className="set-section">
                <div className="set-section-title">Appearance</div>
                <div className="set-row">
                  <span className="set-row-text">
                    <span className="set-row-label">Theme</span>
                    <span className="set-row-hint">Follow the system, or force light / dark.</span>
                  </span>
                  <div className="set-seg">
                    {(["system", "light", "dark"] as const).map((t) => (
                      <button key={t} className={`set-seg-btn ${theme === t ? "on" : ""}`} onClick={() => setTheme(t)}>
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
                <div className="set-section-title">About</div>
                <div className="set-about">
                  <span>EvorIDE{version ? ` v${version}` : ""}</span>
                  <a href="https://github.com/EvorLive/evoride" target="_blank" rel="noreferrer">
                    github.com/EvorLive/evoride
                  </a>
                </div>
              </div>
            </>
          )}

          {tab === "agents" && (
            <>
              <div className="set-section">
                <div className="set-section-title">Behavior</div>
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
                  Enable the agents you use. Leave the path on <b>automatic</b> to find it on your PATH, or set an
                  explicit path if it isn’t found.
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
            </>
          )}

          {tab === "skills" && (
            <div className="set-section">
              <div className="set-section-title">Skills</div>
              <p className="set-row-hint" style={{ marginBottom: 8 }}>
                Agent skills install into your global skills folders (<code>~/.claude/skills</code>{" "}
                and <code>~/.agents/skills</code>) so every agent — Claude, Codex, and any new one
                you add — picks them up.
              </p>

              {/* Install from a git repo, via Claude Code. */}
              <div className="skill-install">
                <input
                  className="skill-install-input"
                  value={repo}
                  placeholder="Install from git — https://github.com/user/skill-repo"
                  onChange={(e) => setRepo(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && installSkill()}
                  disabled={installing}
                />
                <button className="btn primary" onClick={installSkill} disabled={installing || !repo.trim()}>
                  {installing ? "Installing…" : "Install"}
                </button>
              </div>
              <p className="set-row-hint" style={{ marginTop: 4 }}>
                Claude Code clones the repo, checks it’s a valid &amp; safe skill (a SKILL.md with
                name + description), then installs it.
              </p>
              {(skillMsg || skillErr) && (
                <p className={`jira-status ${skillErr ? "err" : ""}`} style={{ marginTop: 6 }}>
                  {skillErr || skillMsg}
                </p>
              )}

              <div style={{ marginTop: 14 }}>
                {skills.length === 0 ? (
                  <p className="set-row-hint">No skills yet.</p>
                ) : (
                  skills.map((s) => (
                    <div className="agent-cfg" key={s.id}>
                      <div className="agent-cfg-top">
                        {s.builtin ? (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={s.enabled}
                            className={`set-switch ${s.enabled ? "on" : ""}`}
                            onClick={() => toggleSkill(s.id, !s.enabled)}
                          >
                            <span className="set-knob" />
                          </button>
                        ) : (
                          <span className="set-switch on" aria-hidden="true">
                            <span className="set-knob" />
                          </span>
                        )}
                        <span className="agent-cfg-name">{s.name}</span>
                        <span className="agent-cfg-ok">{s.builtin ? "bundled" : "installed"}</span>
                        {!s.builtin && (
                          <button
                            className="btn-ghost danger skill-remove"
                            onClick={() => removeSkill(s.id)}
                            title="Remove this skill"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      {s.description && (
                        <p className="set-row-hint" style={{ marginTop: 2 }}>
                          {s.description}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {tab === "jira" && <JiraTab />}
        </div>
      </div>
    </div>
  );
}
