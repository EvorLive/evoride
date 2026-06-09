// Registry of launchable CLIs. Generic so new tools can be added in one place
// (later: user-configurable). `command` empty = the default shell.

export interface CliDef {
  id: string;
  label: string;
  command: string;
}

export const CLIS: CliDef[] = [
  { id: "shell", label: "Shell", command: "" },
  { id: "claude", label: "Claude", command: "claude" },
  { id: "codex", label: "Codex", command: "codex" },
];

// Map an agent command to its fully-autonomous variant so EvorIDE can author a
// run config (and do the work) without the user accepting each step — "autopilot".
// The user only watches; nothing to confirm. Falls through unchanged for agents
// we don't have an auto flag for.
export function autopilotCommand(command: string): string {
  const c = command.trim();
  if (!c) return c;
  const base = (c.split(/\s+/)[0].split("/").pop() ?? "").toLowerCase();
  if (base === "claude" && !/--dangerously-skip-permissions/.test(c))
    return `${c} --dangerously-skip-permissions`;
  if (base === "codex" && !/--full-auto|--dangerously-bypass/.test(c))
    return `${c} --full-auto`;
  return c;
}
