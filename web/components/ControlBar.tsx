"use client";

import { useState } from "react";
import type { PermissionRequest } from "@/lib/protocol";
import type { ControlState } from "@/lib/useControlChannel";

// Common keys for one-tap replies — the "reply with a button" affordance.
const QUICK = [
  { label: "Enter", data: "\r" },
  { label: "y", data: "y\r" },
  { label: "n", data: "n\r" },
  { label: "Esc", data: "\x1b" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "Ctrl-C", data: "\x03" },
];

const STATE_LABEL: Record<ControlState, string> = {
  off: "view-only",
  connecting: "connecting…",
  open: "control active",
  denied: "token rejected",
  closed: "disconnected",
};

export default function ControlBar({
  controlState,
  onSetToken,
  onReply,
  permission,
  waiting,
}: {
  controlState: ControlState;
  onSetToken: (token: string | null) => void;
  onReply: (data: string) => void;
  permission: PermissionRequest | null;
  waiting?: boolean;
}) {
  const [tokenInput, setTokenInput] = useState("");
  const active = controlState === "open";

  return (
    <div className="rounded-lg border border-border bg-surface/60 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-2 py-0.5 text-[11px] font-medium ${
            active
              ? "bg-live/15 text-live"
              : controlState === "denied"
                ? "bg-danger/15 text-danger"
                : "bg-surface-2 text-fg-muted"
          }`}
        >
          {STATE_LABEL[controlState]}
        </span>

        {!active ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (tokenInput.trim()) onSetToken(tokenInput.trim());
            }}
          >
            <input
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="control token (from eterm status bar)"
              className="w-72 rounded border border-border-strong bg-surface-2 px-2 py-1 font-mono text-xs text-fg placeholder:text-fg-subtle outline-none transition-colors focus:border-brand"
            />
            <button
              type="submit"
              className="cursor-pointer rounded bg-brand px-3 py-1 text-xs font-semibold text-bg transition-colors hover:bg-brand-hover"
            >
              Take control
            </button>
          </form>
        ) : (
          <>
            <span className="text-xs text-fg-subtle">
              type in the terminal, or:
            </span>
            {QUICK.map((q) => (
              <button
                key={q.label}
                onClick={() => onReply(q.data)}
                className="cursor-pointer rounded border border-border-strong bg-surface-2 px-2 py-1 font-mono text-xs text-fg transition-colors hover:border-brand hover:text-brand"
              >
                {q.label}
              </button>
            ))}
            <button
              onClick={() => onSetToken(null)}
              className="ml-auto cursor-pointer rounded px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              release
            </button>
          </>
        )}
      </div>

      {/* Explicit permission prompt detected from the agent. */}
      {permission && (
        <div className="mt-2 rounded-md border border-thinking/30 bg-thinking/5 p-2.5">
          <div className="mb-2 text-sm text-thinking">{permission.prompt}</div>
          <div className="flex flex-wrap gap-2">
            {permission.options.map((opt, i) => (
              <button
                key={`${opt}-${i}`}
                disabled={!active}
                onClick={() => onReply(`${opt}\r`)}
                className="cursor-pointer rounded bg-thinking/20 px-3 py-1 text-xs font-medium text-thinking transition-colors hover:bg-thinking/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {opt}
              </button>
            ))}
          </div>
          {!active && (
            <p className="mt-1.5 text-[11px] text-thinking/70">
              Take control with the session token to reply.
            </p>
          )}
        </div>
      )}

      {waiting && !permission && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-waiting">
          <span className="h-1.5 w-1.5 rounded-full bg-waiting animate-pulse" />
          Agent is waiting for input.
        </p>
      )}
    </div>
  );
}
