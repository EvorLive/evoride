// User-configurable agent registry. Built on the CLIS defaults but each agent
// can be enabled/disabled and given an explicit path (e.g. when `claude` isn't
// on PATH in a packaged app). Persisted to localStorage.

import { CLIS, type CliDef } from "./clis";

export interface AgentConfig extends CliDef {
  /** Whether this agent shows in the launcher. */
  enabled: boolean;
  /** True for the built-in shell/claude/codex (can't be deleted, only disabled). */
  builtin: boolean;
}

const KEY = "evoride-agents";

function defaults(): AgentConfig[] {
  return CLIS.map((c) => ({ ...c, enabled: true, builtin: true }));
}

/** Load the agent registry, merging saved overrides with current built-ins. */
export function loadAgents(): AgentConfig[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const saved = JSON.parse(raw) as AgentConfig[];
    const byId = new Map(saved.map((a) => [a.id, a]));
    // Built-ins first (with any saved enable/path overrides applied)…
    const merged: AgentConfig[] = CLIS.map((c) => {
      const s = byId.get(c.id);
      return { ...c, command: s?.command ?? c.command, enabled: s?.enabled ?? true, builtin: true };
    });
    // …then any user-added custom agents.
    for (const a of saved) {
      if (!CLIS.find((c) => c.id === a.id)) merged.push({ ...a, builtin: false });
    }
    return merged;
  } catch {
    return defaults();
  }
}

export function saveAgents(agents: AgentConfig[]) {
  localStorage.setItem(KEY, JSON.stringify(agents));
}

/** Enabled agents as plain CliDefs for the launcher. */
export function enabledClis(agents: AgentConfig[]): CliDef[] {
  return agents.filter((a) => a.enabled).map(({ id, label, command }) => ({ id, label, command }));
}
