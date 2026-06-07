import Sidebar from "@/components/Sidebar";

export default function Home() {
  return (
    <div className="flex h-full flex-1 overflow-hidden">
      <Sidebar />
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-border bg-surface text-brand">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-7 w-7"
            aria-hidden="true"
          >
            <rect x="2.5" y="4" width="19" height="16" rx="2" />
            <path d="m6.5 9 3 3-3 3" />
            <path d="M12.5 15h5" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          eterm dashboard
        </h1>
        <p className="max-w-md text-sm leading-relaxed text-fg-muted">
          Live view of your synced terminal sessions. Start a session in the
          eterm TUI and press{" "}
          <kbd className="rounded border border-border-strong bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-fg">
            Ctrl-S
          </kbd>{" "}
          to sync — it appears in the sidebar.
        </p>
      </main>
    </div>
  );
}
