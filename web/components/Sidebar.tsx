"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { sessionsUrl } from "@/lib/config";
import type { SessionSummary } from "@/lib/protocol";

// Show the last path segment, keeping the parent for context.
function shortTitle(title: string): string {
  if (!title) return "session";
  const parts = title.split("/").filter(Boolean);
  if (parts.length <= 2) return title;
  return "…/" + parts.slice(-2).join("/");
}

// Live-polling list of sessions known to the relay.
export default function Sidebar({ activeId }: { activeId?: string }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(sessionsUrl(), { cache: "no-store" });
        const data: SessionSummary[] = await res.json();
        if (alive) {
          setSessions(data);
          setReachable(true);
        }
      } catch {
        if (alive) setReachable(false);
      }
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <span className="text-base font-semibold tracking-tight text-fg">
          eterm
        </span>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted">
          relay
        </span>
      </div>

      <div className="flex items-center justify-between px-4 py-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">
        <span>Sessions</span>
        <span className="tabular-nums">{sessions.length}</span>
      </div>

      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2">
        {sessions.map((s) => {
          const active = s.id === activeId;
          return (
            <li key={s.id}>
              <Link
                href={`/session/${s.id}`}
                className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-brand/10 text-brand ring-1 ring-inset ring-brand/20"
                    : "text-fg-muted hover:bg-surface-2 hover:text-fg"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      s.ended
                        ? "bg-fg-subtle"
                        : "bg-live shadow-[0_0_6px_var(--color-live)]"
                    }`}
                    title={s.ended ? "ended" : "live"}
                  />
                  <span className="truncate text-[13px]" title={s.title}>
                    {shortTitle(s.title)}
                  </span>
                </div>
                <div className="truncate pl-3 text-[11px] text-fg-subtle">
                  {s.shell} · {s.cols}×{s.rows}
                </div>
              </Link>
            </li>
          );
        })}
        {sessions.length === 0 && (
          <li className="px-3 py-2 text-sm text-fg-subtle">
            {reachable === false
              ? "Relay unreachable."
              : "No active sessions."}
          </li>
        )}
      </ul>

      <div className="border-t border-border px-4 py-2.5 text-[11px] font-medium">
        {reachable === false ? (
          <span className="flex items-center gap-1.5 text-danger">
            <span className="h-1.5 w-1.5 rounded-full bg-danger" />
            relay offline
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-live">
            <span className="h-1.5 w-1.5 rounded-full bg-live shadow-[0_0_6px_var(--color-live)]" />
            relay online
          </span>
        )}
      </div>
    </nav>
  );
}
