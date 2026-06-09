// Typed bridge to the Rust backend (commands + pty events + folder picker).
// Tauri converts camelCase JS arg keys to the snake_case Rust params.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, confirm } from "@tauri-apps/plugin-dialog";
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

export interface Step {
  id: string;
  title: string;
  status: "todo" | "doing" | "done";
}

export interface Task {
  id: string;
  /** Owning project id, or "" when unassigned. */
  project_id: string;
  title: string;
  /** Lifecycle: todo → doing → done → verified (mapped to the board on sync). */
  status: "todo" | "doing" | "done" | "verified";
  agent_id: string | null;
  created_at: number;
  /** Longer free-text detail (maps to Jira/Notion/evor.live description). */
  description?: string | null;
  /** Architect breakdown — ordered, individually-tracked steps. */
  steps?: Step[];
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
  description?: string,
) => invoke<Task>("add_task", { projectId, title, agentId, plannedFor, description });
export const updateTask = (id: string, status: Task["status"]) =>
  invoke("update_task", { id, status });
/// Turn a freeform note into structured tasks via the AI helper (claude/codex),
/// auto-matching each to a project. Returns the created tasks (planned for today).
export const planTasks = (input: string) =>
  invoke<Task[]>("plan_tasks", { input });
/// Set a task's long-form description.
export const setTaskDescription = (id: string, description: string) =>
  invoke("set_task_description", { id, description });
/// Replace a task's breakdown steps.
export const setTaskSteps = (id: string, steps: Step[]) =>
  invoke("set_task_steps", { id, steps });
/// Toggle/update a single step's status; returns the updated task.
export const updateStep = (taskId: string, stepId: string, status: Step["status"]) =>
  invoke<Task | null>("update_step", { taskId, stepId, status });
/// Architect breakdown of a task into steps via the AI helper. Returns the task.
export const breakdownTask = (id: string) => invoke<Task>("breakdown_task", { id });
/// Apply an agent's reported task updates: auto-creates a task when the agent
/// declares new work (`{"new_task":…}`), then reconciles status/steps/notes.
/// Returns every task touched this round (created or updated) to upsert.
export const ingestAgentTasks = (project: string, agentId: string) =>
  invoke<Task[]>("ingest_agent_tasks", { project, agentId });
/// Link a task to the agent now working it.
export const linkTaskAgent = (id: string, agentId: string) =>
  invoke("link_task_agent", { id, agentId });
/// Let the AI helper assign currently-unassigned tasks to a project by matching
/// their wording to project names/repos. Returns how many it placed.
export const autoAssignTasks = () => invoke<number>("auto_assign_tasks");
/// Assign a task to a project ("" = unassigned).
export const assignTask = (id: string, projectId: string) =>
  invoke("assign_task", { id, projectId });
export const deleteTask = (id: string) => invoke("delete_task", { id });
/** Append a line to a task's description (e.g. merge a duplicate's wording in). */
export const appendTaskNote = (id: string, note: string) =>
  invoke("append_task_note", { id, note });
export interface DuplicateHit {
  task_id: string;
  task_title: string;
  task_status: Task["status"];
  reason: string;
}
/** AI check: does `title` duplicate an existing task? null = no clear duplicate
 *  (also null when no AI helper is configured, so creation never blocks). */
export const checkDuplicateTask = (title: string, projectId: string) =>
  invoke<DuplicateHit | null>("check_duplicate_task", { title, projectId });

// --- Jira (two-way task sync) ---
export interface JiraConfigPublic {
  base_url: string;
  email: string;
  jql: string;
  project_map: Record<string, string>;
  has_token: boolean;
}
export interface JiraSyncResult {
  pulled: number;
  created: number;
  updated: number;
  unmapped: number;
}
/** Current Jira config (never includes the token — only `has_token`). */
export const jiraConfigGet = () =>
  invoke<JiraConfigPublic | null>("jira_config_get");
/** Save the Jira connection. Leave `token` blank to keep the stored one. */
export const jiraConfigSet = (cfg: {
  baseUrl: string;
  email: string;
  token: string;
  jql: string;
  projectMap: Record<string, string>;
}) =>
  invoke("jira_config_set", {
    baseUrl: cfg.baseUrl,
    email: cfg.email,
    token: cfg.token,
    jql: cfg.jql,
    projectMap: cfg.projectMap,
  });
export const jiraDisconnect = () => invoke("jira_disconnect");
/** Verify the connection; resolves to the issue count the JQL matches. */
export const jiraTest = () => invoke<number>("jira_test");
/** Pull issues → tasks (upsert by key). Resolves with a summary of changes. */
export const jiraSync = () => invoke<JiraSyncResult>("jira_sync");

/** A Jira issue assigned to me (live), and whether it's already imported. */
export interface JiraIssue {
  key: string;
  summary: string;
  status: Task["status"];
  /** Real Jira status name (e.g. "In Review"). */
  status_name: string;
  description: string | null;
  project_key: string;
  url: string;
  imported: boolean;
}
/** The issues currently assigned to me on Jira (live fetch). */
export const jiraMyIssues = () => invoke<JiraIssue[]>("jira_my_issues");
/** Import one Jira issue into the board as an (Unassigned) task. Pass
 *  `plannedFor` (YYYY-MM-DD) to schedule it (e.g. "import to today"). */
export const jiraImport = (issue: JiraIssue, plannedFor?: string) =>
  invoke<Task | null>("jira_import", {
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    description: issue.description,
    url: issue.url,
    plannedFor,
  });
export interface JiraProject {
  key: string;
  name: string;
}
/** Jira projects the account can file into (for the push-to-Jira picker). */
export const jiraProjects = () => invoke<JiraProject[]>("jira_projects");
/** Push a local task up to Jira: creates an issue (in `projectKey`, or the
 *  mapped project) and links the task. Rejects if already linked. */
export const jiraCreateFromTask = (id: string, projectKey?: string) =>
  invoke<Task>("jira_create_from_task", { id, projectKey });

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
  /// Computed by the backend: true only when `command` is a recognized dev tool
  /// launched by bare name. Untrusted services (from a repo or AI-generated
  /// config) are NOT auto-run and require an explicit confirmation to spawn.
  trusted?: boolean;
}
/// Native confirm dialog used before spawning an untrusted run command.
export const confirmRun = (message: string) =>
  confirm(message, { title: "Run this command?", kind: "warning" });
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
  skills_disabled?: string[];
}
export const getSettings = () => invoke<Settings>("get_settings");
export const setDailySummary = (enabled: boolean) =>
  invoke<Settings>("set_daily_summary", { enabled });

// --- skills ---
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  builtin: boolean;
}
/// Bundled skills with their current enabled state (Settings → Skills).
export const listSkills = () => invoke<SkillInfo[]>("list_skills");
/// Toggle a bundled skill: persists and installs/removes it for every agent CLI.
export const setSkillEnabled = (id: string, enabled: boolean) =>
  invoke("set_skill_enabled", { id, enabled });
/// Install a skill from a git repo via Claude Code (clones, validates it's a safe
/// SKILL.md skill, installs it). Resolves with a status line; rejects with the
/// reason it was refused.
export const installSkillFromGit = (repo: string) =>
  invoke<string>("install_skill_from_git", { repo });
/// Remove a git-installed (external) skill.
export const removeSkill = (id: string) => invoke("remove_skill", { id });
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
