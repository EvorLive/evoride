import type { ReactNode } from "react";

/** Sub-tabs of the cross-project mobile home. */
export type HomeTab = "home" | "agents";

/**
 * Phone shell for the cross-project home — gives it the same bottom navigation the
 * project workspace has, so the two feel consistent. "Home" is the dashboard
 * (needs-you + tasks); "Agents" groups every running agent by project and can start
 * new ones. Both panes stay mounted (CSS-toggled) so the dashboard keeps its state
 * (e.g. the AI recap) when you flip tabs.
 */
export default function MobileHomeShell({
  tab,
  setTab,
  superBar,
  home,
  agents,
}: {
  tab: HomeTab;
  setTab: (t: HomeTab) => void;
  /** Super-project filter chips, shown above the body on both tabs. */
  superBar: ReactNode;
  home: ReactNode;
  agents: ReactNode;
}) {
  const TABS: { id: HomeTab; label: string; icon: string }[] = [
    { id: "home", label: "Home", icon: "⌂" },
    { id: "agents", label: "Agents", icon: "▦" },
  ];

  return (
    <div className="mob">
      <header className="mob-top">
        <div className="mob-title">
          <span className="mob-proj">Evor</span>
        </div>
      </header>

      <div className="mob-superbar">{superBar}</div>

      <main className="mob-body">
        <section className={`mob-pane mob-pane-scroll ${tab === "home" ? "on" : ""}`}>{home}</section>
        <section className={`mob-pane mob-pane-scroll ${tab === "agents" ? "on" : ""}`}>{agents}</section>
      </main>

      <nav className="mob-nav">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
            <span className="mob-nav-ic">{t.icon}</span>
            <span className="mob-nav-lbl">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
