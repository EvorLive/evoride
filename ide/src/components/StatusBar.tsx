import { useState } from "react";
import type { AgentRecord, ClaudeUsage, GitStatus } from "../lib/tauri";
import BranchSwitcher from "./BranchSwitcher";
import { midTruncate } from "../lib/util";

function agentKind(command: string): "claude" | "codex" | "shell" {
  const base = command.split(/\s+/)[0]?.split("/").pop() ?? "";
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  return "shell";
}

function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${n}`;
}

// Bottom bar: git branch/status on the left, active agent + Claude info right.
export default function StatusBar({
  git,
  version,
  activeAgent,
  live,
  model,
  usage,
  url,
  onOpenUrl,
  theme,
  onCycleTheme,
  onOpenSettings,
  cwd,
  onGitRefresh,
}: {
  git: GitStatus | null;
  /** App version from the release tag; falls back to the bundled default. */
  version: string;
  /** Active project name, shown so it's clear which project the bar describes. */
  projectName: string | null;
  activeAgent: AgentRecord | null;
  live: boolean;
  model: string | null;
  usage: ClaudeUsage | null;
  url: string | null;
  onOpenUrl: (url: string) => void;
  theme: "system" | "light" | "dark";
  onCycleTheme: () => void;
  onOpenSettings: () => void;
  cwd: string | null;
  onGitRefresh: () => void;
}) {
  const [branchOpen, setBranchOpen] = useState(false);
  const themeIcon = theme === "light" ? "☀" : theme === "dark" ? "☾" : "⚙";
  const kind = activeAgent ? agentKind(activeAgent.command) : null;
  const shownModel = usage?.model ?? model;

  return (
    <footer className="statusbar">
      <div className="status-left">
        <span className="status-ver">Evor{version ? ` v${version}` : ""}</span>
        {git?.is_repo ? (
          <>
            <span className="status-branch-wrap">
              <button
                className="status-git"
                onClick={() => setBranchOpen((o) => !o)}
                title={
                  git.detached
                    ? "Detached HEAD — pick a branch to get back on one"
                    : "Switch branch"
                }
              >
                {git.detached ? `➦ ${git.branch} (detached)` : `⎇ ${git.branch}`} ▾
              </button>
              {branchOpen && cwd && (
                <BranchSwitcher
                  cwd={cwd}
                  current={git.detached ? "" : git.branch}
                  onClose={() => setBranchOpen(false)}
                  onChanged={onGitRefresh}
                />
              )}
            </span>
            <span className={git.dirty > 0 ? "status-dirty" : "status-clean"}>
              {git.dirty > 0 ? `●${git.dirty}` : "✓ clean"}
            </span>
            {git.ahead > 0 && <span className="status-ab">↑{git.ahead}</span>}
            {git.behind > 0 && <span className="status-ab">↓{git.behind}</span>}
          </>
        ) : (
          <span className="status-muted">not a git repo</span>
        )}
      </div>

      <div className="status-right">
        <button
          className="status-theme"
          onClick={onCycleTheme}
          title={`Theme: ${theme} (click to change)`}
        >
          {themeIcon} {theme}
        </button>
        <button className="status-theme" onClick={onOpenSettings} title="Settings (⌘,)">
          ⚙
        </button>
        {url && (
          <button className="status-url" onClick={() => onOpenUrl(url)} title={url}>
            ↗ Open {midTruncate(url.replace(/^https?:\/\//, ""), 40)}
          </button>
        )}
        {activeAgent && (
          <>
            <span className={`status-dot ${live ? "dot-live" : "dot-dead"}`} />
            {kind === "claude" && (
              <span className="status-claude">
                ✻ Claude{shownModel ? ` · ${shownModel}` : ""}
                {usage && usage.input_tokens > 0 && (
                  <span className="status-usage">
                    {" · "}
                    {fmtK(usage.input_tokens)} ctx · ↓{fmtK(usage.output_tokens)}
                  </span>
                )}
              </span>
            )}
            {kind === "codex" && <span className="status-claude">Codex</span>}
          </>
        )}
      </div>
    </footer>
  );
}
