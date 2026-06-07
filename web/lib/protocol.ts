// TypeScript mirror of the Rust `shared` crate wire protocol.
// Control frames arrive as WebSocket *text* (JSON); terminal output as *binary*.

export type AgentKind = "claude_code" | "codex" | "unknown";
export type AgentState =
  | "idle"
  | "thinking"
  | "running_tool"
  | "waiting_input";

export interface SessionMeta {
  id: string;
  /** Human-meaningful label (working dir / title). */
  title: string;
  cols: number;
  rows: number;
  shell: string;
  started_at: number;
}

/** `/sessions` row: metadata plus liveness. */
export interface SessionSummary extends SessionMeta {
  ended: boolean;
}

export interface AgentStatus {
  kind: AgentKind;
  state: AgentState;
  model?: string | null;
  context_pct?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd?: number | null;
  action?: string | null;
}

// Discriminated union matching Rust's `#[serde(tag = "type")]` Control enum.
export type Control =
  | ({ type: "start" } & SessionMeta)
  | { type: "marker"; label: string; t: number }
  | { type: "resize"; cols: number; rows: number }
  | { type: "agent"; kind: AgentKind; state: AgentState; model?: string | null; context_pct?: number | null; tokens_in?: number | null; tokens_out?: number | null; cost_usd?: number | null; action?: string | null }
  | { type: "permission_request"; request_id: string; prompt: string; options: string[] }
  | { type: "end" };

export interface PermissionRequest {
  request_id: string;
  prompt: string;
  options: string[];
}

export function parseControl(text: string): Control | null {
  try {
    const v = JSON.parse(text);
    return typeof v?.type === "string" ? (v as Control) : null;
  } catch {
    return null;
  }
}

// A control with type "agent" carries the AgentStatus fields inline.
export function asAgentStatus(c: Control): AgentStatus | null {
  return c.type === "agent" ? (c as unknown as AgentStatus) : null;
}

export interface TimelineMarker {
  label: string;
  t: number;
}
