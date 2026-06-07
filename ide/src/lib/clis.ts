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
