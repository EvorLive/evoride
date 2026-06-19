import { lazy, Suspense, useEffect, useState } from "react";
import "./App.css";

const AgentTerminal = lazy(() => import("./components/AgentTerminal"));

// Terminal-only window: a single agent's terminal, popped out into its own
// window. It shares the same pty (state is in-process), so it's live + writable.
const readTheme = (): "system" | "light" | "dark" =>
  (localStorage.getItem("evoride-theme") as "system" | "light" | "dark") || "system";

export default function TerminalWindow({ id }: { id: string }) {
  // Resolve the IDE's saved theme so this window matches — and keep it in sync
  // when the user changes the theme in the main IDE window. localStorage writes
  // in another window of the same origin fire a `storage` event here, so the
  // popped-out terminal follows the chosen background live (not just at open).
  const [theme, setTheme] = useState<"system" | "light" | "dark">(readTheme);
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
  );
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "evoride-theme") setTheme(readTheme());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
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
