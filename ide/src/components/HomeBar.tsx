const APP_VERSION = "0.1.0";

// Bottom bar for context where there's no active project (Home / Workspace grid).
// Shows only what makes sense there — counts, the evor.live connection, the
// command-palette hint, and the theme toggle — not git/branch/agent details.
export default function HomeBar({
  projectCount,
  runningCount,
  waitingCount,
  evorConnected = false,
  onConnectEvor,
  onOpenPalette,
  theme,
  onCycleTheme,
}: {
  projectCount: number;
  runningCount: number;
  waitingCount: number;
  /** evor.live link status — wired later when the integration lands. */
  evorConnected?: boolean;
  onConnectEvor?: () => void;
  onOpenPalette?: () => void;
  theme: "system" | "light" | "dark";
  onCycleTheme: () => void;
}) {
  const themeIcon = theme === "light" ? "☀" : theme === "dark" ? "☾" : "⚙";

  return (
    <footer className="statusbar homebar">
      <div className="status-left">
        <span className="status-ver">EvorIde v{APP_VERSION}</span>
        <span className="hb-stat" title="Known projects">
          {projectCount} project{projectCount === 1 ? "" : "s"}
        </span>
        <span className="hb-stat" title="Agents running">
          <span className={`status-dot ${runningCount > 0 ? "dot-live" : "dot-dead"}`} />
          {runningCount} running
        </span>
        {waitingCount > 0 && (
          <span className="hb-stat hb-wait" title="Agents waiting for your input">
            <span className="status-dot dot-wait" />
            {waitingCount} need{waitingCount === 1 ? "s" : ""} you
          </span>
        )}
      </div>

      <div className="status-right">
        {onOpenPalette && (
          <button className="status-theme" onClick={onOpenPalette} title="Command palette">
            ⌘P
          </button>
        )}
        <button
          className={`hb-evor ${evorConnected ? "on" : ""}`}
          onClick={onConnectEvor}
          title={
            evorConnected
              ? "Connected to evor.live"
              : "Connect to evor.live to sync tasks and link this project (coming soon)"
          }
        >
          <span className={`status-dot ${evorConnected ? "dot-live" : "dot-dead"}`} />
          {evorConnected ? "evor.live" : "Connect evor.live"}
          {!evorConnected && <span className="hb-soon">soon</span>}
        </button>
        <button
          className="status-theme"
          onClick={onCycleTheme}
          title={`Theme: ${theme} (click to change)`}
        >
          {themeIcon} {theme}
        </button>
      </div>
    </footer>
  );
}
