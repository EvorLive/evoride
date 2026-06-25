import { useEffect, useRef, useState, type ReactNode } from "react";

/** Mobile tabs, in bottom-nav order. */
export type MobileTab = "agents" | "terminal" | "changes" | "tasks";

interface Props {
  projectName: string;
  /** Title of the active agent (shown in the header), or null. */
  activeTitle: string | null;
  /** Whether there's a live agent terminal to talk to. */
  hasTerminal: boolean;
  tab: MobileTab;
  setTab: (t: MobileTab) => void;
  /** Project rail (drawer) + the four tab bodies — built by App with full state. */
  projectRail: ReactNode;
  agentsColumn: ReactNode;
  terminal: ReactNode;
  changes: ReactNode;
  tasks: ReactNode;
  /** Write raw bytes to the active agent's pty (caller appends \r for commands). */
  onSend: (raw: string) => void;
  /** Enabled agent CLIs (Shell/Claude/Codex…) shown as quick-launch buttons
   *  when there's no active agent, so a fresh project starts work in one tap. */
  launchOptions: { id: string; label: string; command: string }[];
  onLaunch: (label: string, command: string) => void;
}

/**
 * Phone-first workspace: one tab visible at a time, a bottom nav to switch, and
 * a command bar under the terminal so you can drive the active agent without the
 * on-screen keyboard fighting xterm. All four tab bodies stay mounted (toggled
 * with CSS) so the terminal keeps its pty connection + scrollback across tabs.
 *
 * The project switcher is a left drawer (hamburger), matching "project change
 * can just be in the sidebar". Changes/Tasks are tabs you visit, not always-on.
 */
export default function MobileWorkspace({
  projectName,
  activeTitle,
  hasTerminal,
  tab,
  setTab,
  projectRail,
  agentsColumn,
  terminal,
  changes,
  tasks,
  onSend,
  launchOptions,
  onLaunch,
}: Props) {
  const [navOpen, setNavOpen] = useState(false);
  const [cmd, setCmd] = useState("");
  const cmdRef = useRef<HTMLInputElement>(null);

  // Nudge xterm to refit when the terminal tab becomes visible (its
  // ResizeObserver covers most cases; this is belt-and-suspenders for the
  // display:none → flex transition on some mobile browsers).
  useEffect(() => {
    if (tab === "terminal") {
      const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
      return () => clearTimeout(t);
    }
  }, [tab]);

  // Size the shell to the *visual* viewport so the on-screen keyboard can't
  // cover the command bar. `height: 100%` tracks the layout viewport, which
  // doesn't shrink when the keyboard opens — `visualViewport.height` does, so
  // the command bar stays just above the keyboard and the input is reachable.
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!vv) return;
    const apply = () => root.style.setProperty("--app-vh", `${Math.round(vv.height)}px`);
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--app-vh");
    };
  }, []);

  const send = (raw: string) => {
    if (raw) onSend(raw);
  };
  const submitCmd = (e: React.FormEvent) => {
    e.preventDefault();
    send(cmd + "\r");
    setCmd("");
    cmdRef.current?.focus();
  };

  const TABS: { id: MobileTab; label: string; icon: string }[] = [
    { id: "agents", label: "Agents", icon: "▦" },
    { id: "terminal", label: "Terminal", icon: ">_" },
    { id: "changes", label: "Changes", icon: "±" },
    { id: "tasks", label: "Tasks", icon: "☑" },
  ];

  return (
    <div className="mob">
      {navOpen && <div className="drawer-backdrop" onClick={() => setNavOpen(false)} />}
      <div
        className={`drawer prail-drawer ${navOpen ? "open" : ""}`}
        onClick={() => setNavOpen(false)}
      >
        {projectRail}
      </div>

      <header className="mob-top">
        <button
          className="mob-burger"
          onClick={() => setNavOpen(true)}
          aria-label="Switch project"
        >
          ☰
        </button>
        <div className="mob-title">
          <span className="mob-proj">{projectName}</span>
          {activeTitle && <span className="mob-agent"> · {activeTitle}</span>}
        </div>
      </header>

      <main className="mob-body">
        <section className={`mob-pane ${tab === "agents" ? "on" : ""}`}>
          {agentsColumn}
        </section>
        <section className={`mob-pane mob-pane-term ${tab === "terminal" ? "on" : ""}`}>
          {hasTerminal ? (
            terminal
          ) : (
            <div className="mob-empty">
              <div className="mob-empty-title">Start an agent</div>
              <div className="mob-launch">
                {launchOptions.map((o) => (
                  <button
                    key={o.id}
                    className="btn primary"
                    onClick={() => onLaunch(o.label, o.command)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <button className="mob-empty-more" onClick={() => setTab("agents")}>
                Resume a previous session →
              </button>
            </div>
          )}
        </section>
        <section className={`mob-pane ${tab === "changes" ? "on" : ""}`}>{changes}</section>
        <section className={`mob-pane ${tab === "tasks" ? "on" : ""}`}>{tasks}</section>
      </main>

      {tab === "terminal" && hasTerminal && (
        <form className="mob-cmd" onSubmit={submitCmd}>
          <div className="mob-keys">
            <button type="button" onClick={() => send("\r")} title="Enter">⏎</button>
            <button type="button" onClick={() => send("\x1b")} title="Escape">esc</button>
            <button type="button" onClick={() => send("\x03")} title="Ctrl-C">^C</button>
            <button type="button" onClick={() => send("y\r")} title="Yes">y</button>
            <button type="button" onClick={() => send("n\r")} title="No">n</button>
          </div>
          <div className="mob-cmd-row">
            <input
              ref={cmdRef}
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              placeholder="Message the agent…"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="send"
            />
            <button type="submit" className="btn">Send</button>
          </div>
        </form>
      )}

      <nav className="mob-nav">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "on" : ""}
            onClick={() => setTab(t.id)}
          >
            <span className="mob-nav-ic">{t.icon}</span>
            <span className="mob-nav-lbl">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
