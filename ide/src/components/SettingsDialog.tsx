import { useEffect, useState } from "react";
import * as api from "../lib/tauri";
import type { SkillInfo } from "../lib/tauri";
import type { AgentConfig } from "../lib/agents";

type Tab = "general" | "agents" | "skills" | "jira" | "remote" | "mobile" | "cloud";

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

// The Remote tab: connect this IDE to the hosted Evor dashboard (evor.dev) so
// agent-waiting prompts can be answered from anywhere. Create a device in the
// dashboard, paste its one-time token + the server URL here.
function RemoteTab({ onChanged }: { onChanged?: () => void }) {
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const apply = (s: api.RemoteStatus) => {
    setUrl(s.url);
    setEnabled(s.enabled);
    setHasToken(s.has_token);
    setConfigured(s.configured);
  };

  useEffect(() => {
    api.remoteStatus().then(apply).catch(() => {});
  }, []);

  const note = (m: string, isErr = false) => {
    setMsg(isErr ? "" : m);
    setErr(isErr ? m : "");
  };
  const fail = (e: unknown) =>
    note(typeof e === "string" ? e : (e as Error)?.message || "Failed.", true);

  // Persist URL + enabled together. If a token is staged, save it first so
  // enabling can immediately become "configured".
  const save = async (nextEnabled: boolean) => {
    setBusy(true);
    note("");
    try {
      if (token.trim()) {
        apply(await api.setRemoteToken(token.trim()));
        setToken("");
      }
      apply(await api.setRemoteConfig(url.trim(), nextEnabled));
      note("Saved.");
      onChanged?.();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const clearToken = async () => {
    setBusy(true);
    note("");
    try {
      apply(await api.setRemoteToken(null));
      note("Token cleared.");
      onChanged?.();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-section">
      <div className="set-section-title">Remote control</div>
      <p className="set-row-hint" style={{ marginBottom: 14 }}>
        Push “agent is waiting for you” prompts to the Evor dashboard and answer
        them from your phone or browser. In the dashboard open{" "}
        <strong>Devices</strong>, add a device, then paste its server URL + token
        here.
      </p>

      <Toggle
        label="Enable remote control"
        hint={
          configured
            ? "Connected. Waiting prompts sync to the dashboard; replies come back automatically."
            : "Add a URL and token below, then enable."
        }
        checked={enabled}
        onChange={(v) => void save(v)}
      />

      <label className="jira-field">
        <span>Dashboard URL</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://evor.dev"
          spellCheck={false}
        />
      </label>
      <label className="jira-field">
        <span>Device token</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={hasToken ? "•••••••• (saved — leave blank to keep)" : "paste device token"}
        />
      </label>

      {(msg || err) && <p className={`jira-status ${err ? "err" : ""}`}>{err || msg}</p>}

      <div className="jira-actions">
        <button className="btn primary" onClick={() => void save(enabled)} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        {hasToken && (
          <button
            className="btn-ghost danger"
            onClick={() => void clearToken()}
            disabled={busy}
            style={{ marginLeft: "auto" }}
          >
            Clear token
          </button>
        )}
      </div>
    </div>
  );
}

// The Mobile tab: open this IDE on your phone. Starts a local LAN server (the
// bundled evor-daemon) and shows a QR + code to connect from a phone on the same
// Wi-Fi — no app install, the browser loads the mobile IDE.
function MobileTab() {
  const [st, setSt] = useState<api.MobileStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.mobileStatus().then(setSt).catch(() => {});
  }, []);

  const start = async () => {
    setBusy(true);
    setErr("");
    try {
      setSt(await api.mobileStart());
    } catch (e) {
      setErr(typeof e === "string" ? e : (e as Error)?.message || "Could not start.");
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      setSt(await api.mobileStop());
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-section">
      <div className="set-section-title">Mobile access</div>
      <p className="set-row-hint" style={{ marginBottom: 14 }}>
        Open this IDE on your phone. This starts a small server on your local
        network — scan the QR from a phone on the <strong>same Wi-Fi</strong> (no
        app install) and you get the mobile IDE. Anyone on the network with the
        code can connect, so stop it when you’re done.
      </p>

      {!st?.running ? (
        <button className="btn primary" onClick={start} disabled={busy}>
          {busy ? "Starting…" : "Start mobile access"}
        </button>
      ) : (
        <>
          {st.qr_svg && (
            <div className="mobile-qr" dangerouslySetInnerHTML={{ __html: st.qr_svg }} />
          )}
          <label className="jira-field">
            <span>URL</span>
            <input readOnly value={st.url} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <label className="jira-field">
            <span>Code</span>
            <input readOnly value={st.code} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <p className="set-row-hint" style={{ marginTop: 4 }}>
            Scan the QR (it includes the code), or open the URL on your phone and
            enter the code once.
          </p>
          <div className="jira-actions">
            <button className="btn-ghost danger" onClick={stop} disabled={busy}>
              {busy ? "Stopping…" : "Stop mobile access"}
            </button>
          </div>
        </>
      )}

      {err && <p className="jira-status err" style={{ marginTop: 10 }}>{err}</p>}
    </div>
  );
}

// The Cloud tab: reach this IDE from anywhere via evor.dev, end-to-end
// encrypted. Dials out to the relay; the phone scans a QR carrying the E2E key
// (evor.dev only relays ciphertext). Requires evor.dev connected in Remote.
function CloudTab() {
  const [status, setStatus] = useState<api.CloudStatus | null>(null);
  const [pairing, setPairing] = useState<api.CloudPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api
      .cloudStatus()
      .then((s) => {
        setStatus(s);
        if (s.running) api.cloudPairing().then(setPairing).catch(() => {});
      })
      .catch(() => {});
  }, []);

  const start = async () => {
    setBusy(true);
    setErr("");
    try {
      setStatus(await api.cloudStart());
      setPairing(await api.cloudPairing());
    } catch (e) {
      setErr(typeof e === "string" ? e : (e as Error)?.message || "Could not start.");
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      setStatus(await api.cloudStop());
      setPairing(null);
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-section">
      <div className="set-section-title">Cloud access</div>
      <p className="set-row-hint" style={{ marginBottom: 14 }}>
        Reach this IDE from anywhere through <strong>evor.dev</strong> — not just
        your Wi-Fi. The connection is <strong>end-to-end encrypted</strong>:
        evor.dev only relays ciphertext, and the key travels in the QR you scan,
        never to the server. Connect evor.dev in <strong>Remote</strong> first.
      </p>

      {!status?.running ? (
        <button className="btn primary" onClick={start} disabled={busy}>
          {busy ? "Connecting…" : "Start cloud access"}
        </button>
      ) : (
        <>
          {pairing?.qr_svg && (
            <div className="mobile-qr" dangerouslySetInnerHTML={{ __html: pairing.qr_svg }} />
          )}
          <p className="set-row-hint" style={{ marginTop: 4 }}>
            Scan this on your phone (it carries the encryption key — treat it like
            a password). Connected via {status.url}.
          </p>
          <div className="jira-actions">
            <button className="btn-ghost danger" onClick={stop} disabled={busy}>
              {busy ? "Stopping…" : "Stop cloud access"}
            </button>
          </div>
        </>
      )}

      {err && <p className="jira-status err" style={{ marginTop: 10 }}>{err}</p>}
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
  autoContinueRL,
  setAutoContinueRL,
  agents,
  setAgents,
  initialTab = "general",
  onRemoteChanged,
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
  autoContinueRL: boolean;
  setAutoContinueRL: (v: boolean) => void;
  agents: AgentConfig[];
  setAgents: (a: AgentConfig[]) => void;
  /** Which tab to open on (e.g. "jira" from the Home shortcut). */
  initialTab?: Tab;
  /** Called after a Jira sync / auto-assign so the board can refresh. */
  onTasksChanged?: () => void;
  /** Called after remote-control settings change so the app can re-check state. */
  onRemoteChanged?: () => void;
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

  const toggleAutoContinue = (v: boolean) => {
    setAutoContinueRL(v);
    api.setAutoContinueRateLimit(v).catch(() => {});
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
    { id: "remote", label: "Remote" },
    { id: "mobile", label: "Mobile" },
    { id: "cloud", label: "Cloud" },
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
                  <span>Evor{version ? ` v${version}` : ""}</span>
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
                  label="Auto-continue after rate limit"
                  hint="When an agent hits a usage/session limit, send “continue” the moment it resets so the task carries on unattended."
                  checked={autoContinueRL}
                  onChange={toggleAutoContinue}
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

          {tab === "remote" && <RemoteTab onChanged={onRemoteChanged} />}

          {tab === "mobile" && <MobileTab />}

          {tab === "cloud" && <CloudTab />}
        </div>
      </div>
    </div>
  );
}
