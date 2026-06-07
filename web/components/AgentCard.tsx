import type { AgentStatus, AgentKind, AgentState } from "@/lib/protocol";

const KIND_LABEL: Record<AgentKind, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  unknown: "Shell",
};

const STATE_STYLE: Record<AgentState, { label: string; dot: string }> = {
  idle: { label: "Idle", dot: "bg-fg-subtle" },
  thinking: { label: "Thinking", dot: "bg-thinking animate-pulse" },
  running_tool: { label: "Running tool", dot: "bg-brand animate-pulse" },
  waiting_input: { label: "Awaiting input", dot: "bg-waiting animate-pulse" },
};

function pct(n?: number | null) {
  return n == null ? "—" : `${Math.round(n)}%`;
}
function num(n?: number | null) {
  return n == null ? "—" : n.toLocaleString();
}
function usd(n?: number | null) {
  return n == null ? "—" : `$${n.toFixed(2)}`;
}

// The headline "what is the agent doing" card the user asked to surface.
export default function AgentCard({ agent }: { agent: AgentStatus | null }) {
  if (!agent) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="text-sm text-fg-subtle">No agent detected yet.</div>
      </div>
    );
  }

  const st = STATE_STYLE[agent.state];
  const ctx = agent.context_pct ?? null;
  const ctxColor =
    ctx == null
      ? "bg-border-strong"
      : ctx > 85
        ? "bg-danger"
        : ctx > 60
          ? "bg-thinking"
          : "bg-live";

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${st.dot}`} />
          <span className="font-medium text-fg">
            {KIND_LABEL[agent.kind]}
          </span>
        </div>
        <span className="text-xs font-medium uppercase tracking-wide text-fg-muted">
          {st.label}
        </span>
      </div>

      {agent.action && (
        <p className="mt-2 truncate text-sm text-fg-muted" title={agent.action}>
          {agent.action}
        </p>
      )}

      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-fg-muted">
          <span>Context</span>
          <span className="tabular-nums">{pct(ctx)}</span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className={`h-full ${ctxColor} transition-all duration-300`}
            style={{ width: `${Math.min(100, ctx ?? 0)}%` }}
          />
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Stat label="Model" value={agent.model ?? "—"} mono />
        <Stat label="Cost" value={usd(agent.cost_usd)} />
        <Stat label="Tokens in" value={num(agent.tokens_in)} />
        <Stat label="Tokens out" value={num(agent.tokens_out)} />
      </dl>
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd
        className={`text-fg ${mono ? "font-mono text-xs" : "tabular-nums"}`}
      >
        {value}
      </dd>
    </div>
  );
}
