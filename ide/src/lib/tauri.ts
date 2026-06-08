// Typed bridge to the Rust backend (commands + pty events + folder picker).
// Tauri converts camelCase JS arg keys to the snake_case Rust params.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";

/// The app's real version (from tauri.conf.json, which the release workflow
/// stamps from the git tag) — so the UI reflects the published release.
export const appVersion = () => getVersion();

export interface Project {
  id: string;
  name: string;
  path: string;
  created_at: number;
}

export interface AgentRecord {
  id: string;
  project_id: string;
  title: string;
  command: string;
  cwd: string;
  created_at: number;
  status: "running" | "exited" | "archived";
}

export interface Task {
  id: string;
  /** Owning project id, or "" when unassigned. */
  project_id: string;
  title: string;
  status: "todo" | "doing" | "done";
  agent_id: string | null;
  created_at: number;
  planned_for?: string | null;
  source?: string;
  external_id?: string | null;
  external_url?: string | null;
}

export interface GitStatus {
  is_repo: boolean;
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface FileContent {
  content: string;
  truncated: boolean;
  binary: boolean;
}

export interface ClaudeSession {
  id: string;
  summary: string;
  modified: number;
  model: string | null;
}

export interface ClaudeUsage {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  context_pct: number | null;
}

// --- projects ---
export const listProjects = () => invoke<Project[]>("list_projects");
export const addProject = (path: string) => invoke<Project>("add_project", { path });
export const removeProject = (id: string) => invoke("remove_project", { id });

/** Native folder picker; returns the chosen path or null. */
export async function pickFolder(): Promise<string | null> {
  const res = await open({ directory: true, multiple: false });
  return typeof res === "string" ? res : null;
}

// --- agents ---
export const listAgents = (projectId: string) =>
  invoke<AgentRecord[]>("list_agents", { projectId });
export const runningAgents = () => invoke<AgentRecord[]>("running_agents");
export const allAgents = () => invoke<AgentRecord[]>("all_agents");

/// Global listener: an agent started/stopped waiting for user input.
/// `options` holds menu labels (empty for y/n); `question` is what it's asking.
export async function onAgentWaiting(
  cb: (id: string, waiting: boolean, options: string[], question: string) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string; waiting: boolean; options?: string[]; question?: string }>(
    "agent-waiting",
    (ev) =>
      cb(ev.payload.id, ev.payload.waiting, ev.payload.options ?? [], ev.payload.question ?? ""),
  );
}

export const spawnAgent = (args: {
  projectId: string;
  title: string;
  command?: string;
  resumeFrom?: string;
  subdir?: string;
}) => invoke<AgentRecord>("spawn_agent", args);

export const resumeAgent = (id: string) =>
  invoke<AgentRecord>("resume_agent", { id });

export const writeInput = (id: string, data: string) =>
  invoke("write_input", { id, data });
export const resizeAgent = (id: string, rows: number, cols: number) =>
  invoke("resize_agent", { id, rows, cols });
export const closeAgent = (id: string) => invoke("close_agent", { id });
export const markAgentExited = (id: string) => invoke("mark_agent_exited", { id });
export const agentScrollback = (id: string) =>
  invoke<string>("agent_scrollback", { id });
export const archiveAgent = (id: string) => invoke("archive_agent", { id });
export const deleteAgent = (id: string) => invoke("delete_agent", { id });

// --- tasks ---
export const listTasks = (projectId: string) =>
  invoke<Task[]>("list_tasks", { projectId });
/// Every task across all projects (for the Tasks / planning page).
export const allTasks = () => invoke<Task[]>("all_tasks");
export const addTask = (
  projectId: string,
  title: string,
  agentId?: string,
  plannedFor?: string,
) => invoke<Task>("add_task", { projectId, title, agentId, plannedFor });
export const updateTask = (id: string, status: Task["status"]) =>
  invoke("update_task", { id, status });
/// Assign a task to a project ("" = unassigned).
export const assignTask = (id: string, projectId: string) =>
  invoke("assign_task", { id, projectId });
export const deleteTask = (id: string) => invoke("delete_task", { id });

// --- files ---
export const readDir = (path: string) => invoke<FileEntry[]>("read_dir", { path });
export const readFile = (path: string) => invoke<FileContent>("read_file", { path });
export const writeFile = (path: string, content: string) =>
  invoke("write_file", { path, content });
export const createFile = (path: string) => invoke("create_file", { path });
/** Recursive repo-relative file list for the command palette. */
export const listFiles = (path: string) => invoke<string[]>("list_files", { path });

// --- claude sessions ---
export const claudeSessions = (cwd: string) =>
  invoke<ClaudeSession[]>("claude_sessions", { cwd });
export const claudeUsage = (cwd: string) =>
  invoke<ClaudeUsage | null>("claude_usage", { cwd });

// --- windows ---
export const openWindow = () => invoke("open_window");

// --- git ---
export interface FileChange {
  path: string;
  status: string;
}
export const gitStatus = (cwd: string) => invoke<GitStatus>("git_status", { cwd });
export const gitChanges = (cwd: string) => invoke<FileChange[]>("git_changes", { cwd });
export const gitDiff = (cwd: string, file?: string) =>
  invoke<string>("git_diff", { cwd, file });
export const gitCommitPush = (cwd: string, message: string) =>
  invoke<string>("git_commit_push", { cwd, message });
export const gitFetch = (cwd: string) => invoke("git_fetch", { cwd });
export const gitPull = (cwd: string) => invoke<string>("git_pull", { cwd });
export const gitPush = (cwd: string) => invoke<string>("git_push", { cwd });
export interface Branches {
  current: string;
  all: string[];
}
export const gitBranches = (cwd: string) => invoke<Branches>("git_branches", { cwd });
export const gitCheckout = (cwd: string, branch: string) =>
  invoke<string>("git_checkout", { cwd, branch });
export const gitCreateBranch = (cwd: string, name: string) =>
  invoke<string>("git_create_branch", { cwd, name });

// --- run config ---
export interface Service {
  name: string;
  command: string;
  cwd: string;
  port?: number;
  url?: string;
  ready_when?: string;
}
export const runConfig = (projectId: string, path: string) =>
  invoke<Service[]>("run_config", { projectId, path });
export const createRunConfig = (path: string) =>
  invoke<Service[]>("create_run_config", { path });
/// Instruction to hand an agent so it writes ~/.evoride/{id}/runinfo.json.
export const runSetupPrompt = (projectId: string) =>
  invoke<string>("run_setup_prompt", { projectId });

// --- intent docs ---
export interface IntentConfig {
  enabled: boolean;
  mode: string;
  path: string;
}
export const intentConfig = (path: string) =>
  invoke<IntentConfig>("intent_config", { path });
export const setIntent = (path: string, enabled: boolean, mode: string) =>
  invoke<IntentConfig>("set_intent", { path, enabled, mode });
export const readIntent = (path: string) => invoke<string>("read_intent", { path });
export const updateIntent = (path: string) =>
  invoke<string>("update_intent", { path });

// --- per-agent edits ---
export interface EditRecord {
  file: string;
  info: string;
}
export const agentEdits = (project: string, agentId: string) =>
  invoke<EditRecord[]>("agent_edits", { project, agentId });
export const agentEditCounts = (project: string) =>
  invoke<Record<string, number>>("agent_edit_counts", { project });

// --- settings & daily summaries ---
export interface Settings {
  daily_summary: boolean;
}
export const getSettings = () => invoke<Settings>("get_settings");
export const setDailySummary = (enabled: boolean) =>
  invoke<Settings>("set_daily_summary", { enabled });
export const dailySummary = (date?: string) =>
  invoke<string>("daily_summary", { date });
export const dailySummaryAi = (date?: string, force?: boolean) =>
  invoke<string>("daily_summary_ai", { date, force });
/// Previously-generated AI summary for the day, if cached (no LLM call).
export const dailySummaryAiCached = (date?: string) =>
  invoke<string | null>("daily_summary_ai_cached", { date });
export const summaryDates = () => invoke<string[]>("summary_dates");

// --- misc ---
export const detectRunCommand = (path: string) =>
  invoke<string | null>("detect_run_command", { path });
export const homeDir = () => invoke<string | null>("home_dir");

// --- events ---
interface OutputEvent {
  id: string;
  data: string; // base64
}

export async function onAgentOutput(
  id: string,
  cb: (bytes: Uint8Array) => void,
): Promise<UnlistenFn> {
  return listen<OutputEvent>("pty-output", (ev) => {
    if (ev.payload.id !== id) return;
    cb(b64ToBytes(ev.payload.data));
  });
}

/// Lightweight global listener: fires with the agent id whenever it produces
/// output (data ignored). Used to track per-agent idleness for the judge.
export async function onAnyOutput(cb: (id: string) => void): Promise<UnlistenFn> {
  return listen<OutputEvent>("pty-output", (ev) => cb(ev.payload.id));
}

/// The hidden helper's verdict for an idle agent (see Rust `judge.rs`).
export interface Judgement {
  state: "working" | "waiting_passive" | "waiting_active";
  needs_input: boolean;
  summary: string;
  options: string[];
  helper: string;
}

export const judgeAgent = (id: string) => invoke<Judgement | null>("judge_agent", { id });
export const judgeHelper = () => invoke<string | null>("judge_helper");

/// Resolve an agent command to its program's absolute path, or null if missing.
export const whichAgent = (command: string) =>
  invoke<string | null>("which_agent", { command });

export interface JudgeResult {
  id: string;
  judgement: Judgement | null;
}
/// Classify several idle agents in one helper call (batched, cheaper).
export const judgeAgents = (ids: string[]) => invoke<JudgeResult[]>("judge_agents", { ids });

/// "Stick out" the window — float it above other apps (always-on-top).
export const setAlwaysOnTop = (on: boolean) => invoke("set_always_on_top", { on });

/// Pop an agent's terminal out into its own window (shares the same pty).
export const popOutTerminal = (id: string, title?: string) =>
  invoke("pop_out_terminal", { id, title });
/// Agent ids whose terminal is currently popped out into its own window.
export const poppedOut = () => invoke<string[]>("popped_out");
/// Close an agent's popped-out window (re-attaches it in the IDE).
export const closePopout = (id: string) => invoke("close_popout", { id });
/// Listen for popout open/close across windows.
export async function onPopoutChanged(
  cb: (id: string, open: boolean) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string; open: boolean }>("popout-changed", (ev) =>
    cb(ev.payload.id, ev.payload.open),
  );
}
/// Rename an agent (its displayed title).
export const setAgentTitle = (id: string, title: string) =>
  invoke("set_agent_title", { id, title });

export interface ExitInfo {
  hasError: boolean;
  context: string;
}

export async function onAgentExit(
  id: string,
  cb: (info: ExitInfo) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string; has_error: boolean; context: string }>(
    "pty-exit",
    (ev) => {
      if (ev.payload.id === id)
        cb({ hasError: ev.payload.has_error, context: ev.payload.context });
    },
  );
}

/// Global pty-exit listener — fires for ANY agent (incl. discarded/background).
export async function onAnyAgentExit(
  cb: (id: string, info: ExitInfo) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string; has_error: boolean; context: string }>(
    "pty-exit",
    (ev) =>
      cb(ev.payload.id, {
        hasError: ev.payload.has_error,
        context: ev.payload.context,
      }),
  );
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
