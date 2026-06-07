import type { AgentRecord, ClaudeUsage, GitStatus } from "../lib/tauri";

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

const APP_VERSION = "0.1.0";

// Bottom bar: git branch/status on the left, active agent + Claude info right.
export default function StatusBar({
  git,
  activeAgent,
  live,
  model,
  usage,
  url,
  onOpenUrl,
  theme,
  onCycleTheme,
}: {
  git: GitStatus | null;
  activeAgent: AgentRecord | null;
  live: boolean;
  model: string | null;
  usage: ClaudeUsage | null;
  url: string | null;
  onOpenUrl: (url: string) => void;
  theme: "system" | "light" | "dark";
  onCycleTheme: () => void;
}) {
  const themeIcon = theme === "light" ? "☀" : theme === "dark" ? "☾" : "⚙";
  const kind = activeAgent ? agentKind(activeAgent.command) : null;
  const shownModel = usage?.model ?? model;

  return (
    <footer className="statusbar">
      <div className="status-left">
        <span className="status-ver">EvorIde v{APP_VERSION}</span>
        {git?.is_repo ? (
          <>
            <span className="status-git">⎇ {git.branch}</span>
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
        {url && (
          <button className="status-url" onClick={() => onOpenUrl(url)} title={url}>
            ↗ Open {url.replace(/^https?:\/\//, "")}
          </button>
        )}
        {activeAgent && (
          <>
            <span className={`status-dot ${live ? "dot-live" : "dot-dead"}`} />
            <span className="status-agent">{activeAgent.title}</span>
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
