import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "./Markdown";
import TaskCard from "./TaskCard";
import AgentPreviewGrid from "./AgentPreviewGrid";
import JiraIssuesDialog from "./JiraIssuesDialog";
import * as api from "../lib/tauri";
import * as demo from "../lib/demo";
import type { AgentRecord, Project, Step, Task } from "../lib/tauri";
import type { CliDef } from "../lib/clis";

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

const ORDER: Record<Task["status"], number> = { doing: 0, todo: 1, done: 2, verified: 3 };
// Auto-refresh the AI recap on this cadence (background).
const SUMMARY_EVERY_MS = 5 * 60 * 1000;

// Top-level landing page: who needs you, the agents running, your tasks (handed
// off the same way as the project page), and a periodic AI recap of the day.
export default function HomeView({
  projects,
  runningList,
  waitingAgents,
  tasks,
  clis,
  canPlan = false,
  termMode = "dark",
  onOpenProject,
  onOpenAgent,
  onAccept,
  onAddTask,
  onCycleTask,
  onDeleteTask,
  onAssignTask,
  onSetDescription,
  onBreakdown,
  onToggleStep,
  onWorkTask,
  onBrainstormTask,
  onPlan,
  onOpenJira,
  onTasksRefresh,
  onPushJira,
}: {
  projects: Project[];
  runningList: AgentRecord[];
  waitingAgents: Set<string>;
  waitingOptions: Record<string, string[]>;
  waitingQuestion: Record<string, string>;
  textModes: Record<string, boolean>;
  /** Every task across all projects. */
  tasks: Task[];
  /** Enabled launchable CLIs (incl. shell). */
  clis: CliDef[];
  /** Whether an AI helper (claude/codex) is available (planner + breakdown). */
  canPlan?: boolean;
  /** Resolved IDE color mode for the terminal previews. */
  termMode?: "light" | "dark";
  onOpenProject: (p: Project) => void;
  onOpenAgent: (agent: AgentRecord) => void;
  onAccept: (id: string) => void;
  onYes: (id: string) => void;
  onNo: (id: string) => void;
  onPick: (id: string, n: number, label: string) => void;
  onAddTask: (title: string, projectId: string, plannedFor: string) => void;
  onCycleTask: (t: Task) => void;
  onDeleteTask: (id: string) => void;
  onAssignTask: (id: string, projectId: string) => void;
  onSetDescription: (id: string, description: string) => void;
  onBreakdown: (id: string) => Promise<void>;
  onToggleStep: (taskId: string, stepId: string, status: Step["status"]) => void;
  onWorkTask: (t: Task, command: string) => void;
  onBrainstormTask: (t: Task, command: string) => void;
  onPlan: (note: string) => Promise<Task[]>;
  /** Open the Jira connection settings. */
  onOpenJira?: () => void;
  /** Refresh the task board (e.g. after importing a Jira ticket). */
  onTasksRefresh?: () => void;
  /** Push a local task up to Jira (create an issue). */
  onPushJira?: (t: Task) => void;
}) {
  const [aiSummary, setAiSummary] = useState<string>("");
  const [aiBusy, setAiBusy] = useState(false);
  const lastGenRef = useRef<number>(0);

  const projectName = useCallback(
    (id: string) => projects.find((p) => p.id === id)?.name ?? "Unknown project",
    [projects],
  );

  // Load any cached recap once, then keep it fresh in the background.
  const generateAi = useCallback((force: boolean) => {
    if (demo.isDemo()) {
      setAiSummary(demo.demoRecap);
      return;
    }
    setAiBusy(true);
    lastGenRef.current = Date.now();
    api
      .dailySummaryAi(undefined, force)
      .then(setAiSummary)
      .catch(() => {})
      .finally(() => setAiBusy(false));
  }, []);

  useEffect(() => {
    if (demo.isDemo()) {
      setAiSummary(demo.demoRecap);
      return;
    }
    let alive = true;
    api
      .dailySummaryAiCached(undefined)
      .then((c) => {
        if (!alive) return;
        if (c) setAiSummary(c);
        else generateAi(false); // none yet → generate the first one
      })
      .catch(() => {});
    // Background refresh every few minutes (rust-side claude -p; non-blocking).
    const iv = setInterval(() => {
      if (document.hidden) return;
      if (Date.now() - lastGenRef.current >= SUMMARY_EVERY_MS) generateAi(true);
    }, 60_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [generateAi]);

  const waitingList = runningList.filter((a) => waitingAgents.has(a.id));
  const activeList = runningList.filter((a) => !waitingAgents.has(a.id));

  // Today's + all open tasks across projects, doing → todo → done.
  const visibleTasks = useMemo(() => {
    const closed = (s: Task["status"]) => s === "done" || s === "verified";
    const open = tasks.filter((t) => !closed(t.status));
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const doneToday = tasks.filter((t) => closed(t.status) && t.planned_for === todayStr);
    return [...open, ...doneToday].sort(
      (a, b) => ORDER[a.status] - ORDER[b.status] || a.created_at - b.created_at,
    );
  }, [tasks]);

  // Quick-add + AI planner state.
  const [draft, setDraft] = useState("");
  const [draftProject, setDraftProject] = useState("");
  const [note, setNote] = useState("");
  const [planning, setPlanning] = useState(false);
  const [planMsg, setPlanMsg] = useState("");
  const [planErr, setPlanErr] = useState("");

  const today = useMemo(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, []);

  const add = () => {
    const title = draft.trim();
    if (!title) return;
    onAddTask(title, draftProject, today);
    setDraft("");
  };
  const plan = async () => {
    const text = note.trim();
    if (!text || planning) return;
    setPlanning(true);
    setPlanErr("");
    setPlanMsg("");
    try {
      const created = await onPlan(text);
      setNote("");
      const named = created.filter((t) => t.project_id).length;
      setPlanMsg(`Added ${created.length} task${created.length === 1 ? "" : "s"}` + (named ? ` · ${named} matched` : ""));
    } catch (e) {
      setPlanErr(typeof e === "string" ? e : (e as Error)?.message || "Couldn't plan that.");
    } finally {
      setPlanning(false);
    }
  };

  const agentCommand = clis.find((c) => c.command.trim())?.command;
  const agentLabel = clis.find((c) => c.command.trim())?.label;

  // My Jira tickets that aren't on the board yet — pull them in one at a time.
  const [jiraIssues, setJiraIssues] = useState<api.JiraIssue[]>([]);
  const loadJira = useCallback(() => {
    api
      .jiraMyIssues()
      .then((issues) => setJiraIssues(issues.filter((i) => !i.imported)))
      .catch(() => setJiraIssues([])); // not connected → just show nothing
  }, []);
  useEffect(() => {
    loadJira();
  }, [loadJira, tasks]);
  const importIssue = async (issue: api.JiraIssue) => {
    await api.jiraImport(issue, today).catch(() => {}); // import into Today
    setJiraIssues((prev) => prev.filter((i) => i.key !== issue.key));
    onTasksRefresh?.();
  };
  // "See all" dialog — full list + import-to-today.
  const [jiraAllOpen, setJiraAllOpen] = useState(false);

  // ⟳ Jira: pull issues → tasks (statuses/descriptions upsert) and reload the
  // inbox + board. Falls back to Settings → Jira when it isn't connected yet.
  const [jiraBusy, setJiraBusy] = useState(false);
  const refreshJira = async () => {
    if (jiraBusy) return;
    setJiraBusy(true);
    try {
      await api.jiraSync();
      loadJira();
      onTasksRefresh?.();
    } catch {
      onOpenJira?.();
    } finally {
      setJiraBusy(false);
    }
  };

  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-head">
          <h1>{timeGreeting()}</h1>
          <p className="home-sub">
            {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
            {" · "}
            {projects.length} project{projects.length === 1 ? "" : "s"} · {runningList.length} agent
            {runningList.length === 1 ? "" : "s"} running
          </p>
        </header>

        {/* Quick project switch — compact, not big boxes. */}
        {projects.length > 0 && (
          <div className="home-projchips">
            {projects.map((p) => (
              <button key={p.id} className="home-projchip" onClick={() => onOpenProject(p)} title={p.path}>
                {p.name}
              </button>
            ))}
          </div>
        )}

        {runningList.length > 0 && (
          <section className="home-section">
            <h2 className="home-h2">Running agents</h2>
            {/* Every running agent across all projects, as live terminal
                thumbnails in one place — waiting first. Click opens the agent's
                full page; a waiting one gets a Continue button. */}
            <AgentPreviewGrid
              agents={[...waitingList, ...activeList].map((a) => ({
                id: a.id,
                title: a.title,
                waiting: waitingAgents.has(a.id),
                projectName: projectName(a.project_id),
              }))}
              termMode={termMode}
              onOpen={(id) => {
                const a = runningList.find((x) => x.id === id);
                if (a) onOpenAgent(a);
              }}
              onContinue={onAccept}
            />
          </section>
        )}

        {/* Tasks — same handoff (Work / Brainstorm / breakdown) as the project page. */}
        <section className="home-section">
          <div className="home-h2-row">
            <h2 className="home-h2">Tasks</h2>
            {onOpenJira && (
              <button
                className="btn-ghost home-jira"
                onClick={() => void refreshJira()}
                disabled={jiraBusy}
                title="Refresh Jira tasks"
              >
                {jiraBusy ? "⟳ Syncing…" : "⟳ Jira"}
              </button>
            )}
          </div>

          {jiraIssues.length > 0 && (
            <div className="jira-inbox">
              <div className="jira-inbox-head">
                <span>From Jira — assigned to you</span>
                <span className="jira-inbox-count">{jiraIssues.length}</span>
              </div>
              <ul className="jira-inbox-list">
                {jiraIssues.slice(0, 5).map((it) => (
                  <li key={it.key} className="jira-inbox-row">
                    <a className="jira-inbox-key" href={it.url} target="_blank" rel="noreferrer" title={it.url}>
                      {it.key}
                    </a>
                    {it.status_name && <span className={`jira-stat s-${it.status}`}>{it.status_name}</span>}
                    <span className="jira-inbox-title" title={it.description ?? undefined}>
                      {it.summary}
                    </span>
                    <button className="btn" onClick={() => void importIssue(it)} title="Import into Today">
                      Import
                    </button>
                  </li>
                ))}
              </ul>
              <button className="jira-seeall" onClick={() => setJiraAllOpen(true)}>
                See all {jiraIssues.length} →
              </button>
            </div>
          )}

          <JiraIssuesDialog
            open={jiraAllOpen}
            onClose={() => setJiraAllOpen(false)}
            onImported={() => {
              loadJira();
              onTasksRefresh?.();
            }}
          />

          {canPlan && (
            <div className="tk-plan">
              <textarea
                className="tk-plan-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") plan();
                }}
                placeholder="Brain-dump what's on your mind — AI splits it into tasks and matches each to a project. (⌘↵)"
                rows={2}
                disabled={planning}
              />
              <div className="tk-plan-foot">
                <span className={`tk-plan-status ${planErr ? "err" : ""}`}>
                  {planning ? "Thinking…" : planErr || planMsg}
                </span>
                <button className="btn primary" onClick={plan} disabled={!note.trim() || planning}>
                  {planning ? "Planning…" : "✦ Plan with AI"}
                </button>
              </div>
            </div>
          )}

          <div className="tk-add">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="Add a task…"
            />
            <select value={draftProject} onChange={(e) => setDraftProject(e.target.value)} title="Project">
              <option value="">Unassigned</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button className="btn primary" onClick={add} disabled={!draft.trim()}>
              Add
            </button>
          </div>

          {visibleTasks.length === 0 ? (
            <p className="home-empty">No open tasks. Add one above or brain-dump with AI.</p>
          ) : (
            <ul className="tc-list">
              {visibleTasks.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  projects={projects}
                  agentCommand={t.project_id ? agentCommand : undefined}
                  agentLabel={agentLabel}
                  showProject
                  projectName={t.project_id ? projectName(t.project_id) : "Unassigned"}
                  onCycle={onCycleTask}
                  onDelete={(x) => onDeleteTask(x.id)}
                  onSetDescription={onSetDescription}
                  onBreakdown={onBreakdown}
                  onToggleStep={onToggleStep}
                  onWork={onWorkTask}
                  onBrainstorm={onBrainstormTask}
                  onAssign={!t.project_id ? onAssignTask : undefined}
                  onPushJira={t.project_id ? onPushJira : undefined}
                />
              ))}
            </ul>
          )}
        </section>

        {/* Periodic AI recap of the day (auto-refreshed). */}
        <section className="home-section">
          <div className="home-today-head">
            <h2 className="home-h2">Daily recap</h2>
            <button
              className="btn-ghost"
              onClick={() => generateAi(true)}
              disabled={aiBusy}
              title="Regenerate now"
            >
              {aiBusy ? "Summarizing…" : "↻ Refresh"}
            </button>
          </div>
          {aiSummary ? (
            <div className="home-ai">
              <div className="home-ai-tag">✦ Claude’s recap · auto-updates every 5 min</div>
              <Markdown text={aiSummary} />
            </div>
          ) : (
            <p className="home-empty">{aiBusy ? "Generating your recap…" : "No recap yet."}</p>
          )}
        </section>
      </div>
    </div>
  );
}
