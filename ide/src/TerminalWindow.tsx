import { lazy, Suspense, useEffect, useState } from "react";
import "./App.css";

const AgentTerminal = lazy(() => import("./components/AgentTerminal"));

// Terminal-only window: a single agent's terminal, popped out into its own
// window. It shares the same pty (state is in-process), so it's live + writable.
export default function TerminalWindow({ id }: { id: string }) {
  // Resolve the IDE's saved theme so this window matches.
  const theme = (localStorage.getItem("evoride-theme") as "system" | "light" | "dark") || "system";
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);
  const mode: "light" | "dark" = theme === "system" ? (prefersDark ? "dark" : "light") : theme;

  return (
    <div className="term-window">
      <Suspense fallback={null}>
        <AgentTerminal id={id} active mode={mode} />
      </Suspense>
    </div>
  );
}
