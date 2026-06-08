// Demo / screenshot mode. When on, the UI is seeded with realistic FAKE data so
// you can screenshot the dashboard (for a README/Show HN) without exposing your
// real repos.
//
// It is intentionally NOT reachable from the UI (no palette command, no toggle,
// no localStorage). It only activates when the app is built/run with the env var
// VITE_EVORIDE_DEMO set to the exact secret below — e.g.:
//   VITE_EVORIDE_DEMO=evor-demo-7Qx2k9 pnpm tauri dev

import type { AgentRecord, Project } from "./tauri";

// Password-like sentinel — demo mode only turns on for this exact value.
const DEMO_SECRET = "evor-demo-7Qx2k9";

export function isDemo(): boolean {
  return import.meta.env?.VITE_EVORIDE_DEMO === DEMO_SECRET;
}

const now = Math.floor(Date.now() / 1000);
const ago = (m: number) => now - m * 60;

export const demoProjects: Project[] = [
  { id: "p-api", name: "acme-api", path: "/Users/you/code/acme-api", created_at: ago(9000) },
  { id: "p-store", name: "storefront", path: "/Users/you/code/storefront", created_at: ago(8000) },
  { id: "p-ml", name: "ml-pipeline", path: "/Users/you/code/ml-pipeline", created_at: ago(7000) },
  { id: "p-docs", name: "docs-site", path: "/Users/you/code/docs-site", created_at: ago(6000) },
  { id: "p-mobile", name: "mobile-app", path: "/Users/you/code/mobile-app", created_at: ago(5000) },
];

const A = (
  id: string,
  project_id: string,
  title: string,
  command: string,
  min: number,
): AgentRecord => ({
  id,
  project_id,
  title,
  command,
  cwd: demoProjects.find((p) => p.id === project_id)?.path ?? "",
  created_at: ago(min),
  status: "running",
});

export const demoRunning: AgentRecord[] = [
  A("a1", "p-api", "Add rate limiting to the gateway", "claude", 42),
  A("a2", "p-api", "Fix the flaky auth tests", "claude", 18),
  A("a3", "p-store", "Checkout redesign", "codex", 27),
  A("a4", "p-ml", "Tune the embedding retriever", "claude", 63),
  A("a5", "p-store", "Migrate to the new pricing API", "claude", 6),
];

// The "needs you" hero: one real menu (numbered) + one free-text "wants direction".
export const demoWaitingIds = ["a2", "a3"];

export const demoOptions: Record<string, string[]> = {
  a2: ["Yes", "Yes, and don’t ask again this session", "No, and tell Claude what to change"],
  a3: ["Stripe first", "Adyen first", "Do both in parallel"],
};

export const demoQuestion: Record<string, string> = {
  a2: "Do you want to apply the database migration now?",
  a3: "Which payment provider should I wire up first?",
};

// a2 is a real numbered menu (send number); a3 is free-text (send the label).
export const demoTextMode: Record<string, boolean> = { a3: true };

export const demoState: Record<string, "working" | "passive" | "active"> = {
  a1: "working",
  a2: "active",
  a3: "active",
  a4: "working",
  a5: "passive",
};

export const demoRecap = `Productive morning across **3 projects**. On **acme-api** you shipped the gateway **rate limiter** (+312 / −47) and have an agent mid-way through the flaky **auth tests** — it’s paused waiting on the DB migration. **ml-pipeline** is running a long retriever-tuning pass, and **storefront** kicked off the checkout redesign (asking which payment provider to wire first). Tokens: **1.8M** across Opus & Sonnet. Next: clear the two agents waiting on you, then land the checkout branch.`;
