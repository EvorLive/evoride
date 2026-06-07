import AgentCard from "./AgentCard";
import type {
  AgentStatus,
  SessionMeta,
  TimelineMarker,
} from "@/lib/protocol";

type Conn = "connecting" | "live" | "ended" | "closed";

const CONN: Record<Conn, { label: string; dot: string }> = {
  connecting: { label: "Connecting", dot: "bg-thinking animate-pulse" },
  live: { label: "Live", dot: "bg-live shadow-[0_0_6px_var(--color-live)]" },
  ended: { label: "Session ended", dot: "bg-fg-subtle" },
  closed: { label: "Disconnected", dot: "bg-danger" },
};

function fmtTime(unix?: number) {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString();
}

export default function StatusPanel({
  meta,
  agent,
  markers,
  conn,
}: {
  meta: SessionMeta | null;
  agent: AgentStatus | null;
  markers: TimelineMarker[];
  conn: Conn;
}) {
  const c = CONN[conn];
  return (
    <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface/50 p-4">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${c.dot}`} />
        <span className="text-sm font-medium text-fg">{c.label}</span>
      </div>

      <AgentCard agent={agent} />

      <div className="rounded-lg border border-border bg-surface p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
          Session
        </h3>
        <dl className="space-y-1.5 text-sm">
          <Row k="Title" v={meta?.title ?? "—"} />
          <Row k="ID" v={meta?.id ?? "—"} mono />
          <Row k="Shell" v={meta?.shell ?? "—"} mono />
          <Row
            k="Size"
            v={meta ? `${meta.cols}×${meta.rows}` : "—"}
          />
          <Row k="Started" v={fmtTime(meta?.started_at)} />
        </dl>
      </div>

      <div className="rounded-lg border border-border bg-surface p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
          Timeline
        </h3>
        {markers.length === 0 ? (
          <p className="text-sm text-fg-subtle">No events yet.</p>
        ) : (
          <ul className="space-y-2">
            {markers.map((m, i) => (
              <li key={`${m.t}-${i}`} className="flex gap-2 text-sm">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand/70" />
                <span className="text-fg-muted">{m.label}</span>
                <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-fg-subtle">
                  {m.t.toFixed(1)}s
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-fg-subtle">{k}</dt>
      <dd
        className={`truncate text-fg ${mono ? "font-mono text-xs" : ""}`}
        title={v}
      >
        {v}
      </dd>
    </div>
  );
}
