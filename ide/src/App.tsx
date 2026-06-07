import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ProjectRail from "./components/ProjectRail";
import AgentsColumn from "./components/AgentsColumn";
import TasksPanel from "./components/TasksPanel";
import AgentTerminal from "./components/AgentTerminal";
import SessionLauncher from "./components/SessionLauncher";
import FileExplorer from "./components/FileExplorer";
import Editor from "./components/Editor";
import GitPanel from "./components/GitPanel";
import DiffView from "./components/DiffView";
import RunControl from "./components/RunControl";
import IntentPanel from "./components/IntentPanel";
import EditsPanel from "./components/EditsPanel";
import StatusBar from "./components/StatusBar";
import HomeView from "./components/HomeView";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "./lib/tauri";
import type {
  AgentRecord,
  ClaudeSession,
  ClaudeUsage,
  FileEntry,
  GitStatus,
  Project,
  Service,
  Task,
} from "./lib/tauri";

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
import "./App.css";

const NEXT_STATUS = { todo: "doing", doing: "done", done: "todo" } as const;

export default function App() {
  // Top-level view: the cross-project Home dashboard, or the single-project
  // workspace. Defaults to Home on launch when projects exist.
  const [view, setView] = useState<"home" | "workspace">("home");
  // The IDE is scoped to a single project.
  const [project, setProject] = useState<Project | null>(null);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [live, setLive] = useState<Set<string>>(new Set());
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  // One right-side panel at a time (git/plan/intent/files/edits), or none.
  type RightPanel = "git" | "plan" | "intent" | "files" | "edits";
  const [rightPanel, setRightPanel] = useState<RightPanel | null>("git");
  // Center shows the agent terminal or the file editor (never side by side).
  const [centerMode, setCenterMode] = useState<"terminal" | "editor">("terminal");
  const [services, setServices] = useState<Service[]>([]);
  // service name → live agent id while that service is running.
  const [runningServices, setRunningServices] = useState<Record<string, string>>({});
  const [home, setHome] = useState<string | null>(null);
  // Diff shown in the center (replacing the terminal); null = show terminal.
  const [diffView, setDiffView] = useState<{ file: string | null } | null>(null);
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [knownProjects, setKnownProjects] = useState<Project[]>([]);
  const [intentEnabled, setIntentEnabled] = useState(false);
  // Latest URL detected in each agent's output (for the "Open URL" button).
  const [urlByAgent, setUrlByAgent] = useState<Record<string, string>>({});
  // Agents that exited with a detected issue → fix context.
  const [agentIssues, setAgentIssues] = useState<Record<string, { context: string }>>({});
  // Live error detected in the active terminal (Fix button while running).
  const [liveIssue, setLiveIssue] = useState<{ id: string; context: string } | null>(null);
  // Per-agent edited-file counts (for row badges).
  const [editCounts, setEditCounts] = useState<Record<string, number>>({});
  // Multi-project rail: running agents across projects + who's waiting for input.
  const [runningList, setRunningList] = useState<AgentRecord[]>([]);
  const [waitingAgents, setWaitingAgents] = useState<Set<string>>(new Set());
  // Theme: follow system, or manual light/dark.
  const [theme, setTheme] = useState<"system" | "light" | "dark">(
    () => (localStorage.getItem("evoride-theme") as never) || "system",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("evoride-theme", theme);
  }, [theme]);
  // Open file tabs for the right-side editor.
  const [openFiles, setOpenFiles] = useState<FileEntry[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  const openFile = (e: FileEntry) => {
    setOpenFiles((prev) =>
      prev.some((f) => f.path === e.path) ? prev : [...prev, e],
    );
    setActiveFile(e.path);
    setCenterMode("editor"); // file opens in the center (replaces terminal)
    setDiffView(null);
  };
  const closeFile = (path: string) =>
    setOpenFiles((prev) => {
      const next = prev.filter((f) => f.path !== path);
      setActiveFile((cur) =>
        cur === path ? (next[next.length - 1]?.path ?? null) : cur,
      );
      if (next.length === 0) setCenterMode("terminal");
      return next;
    });

  // Open the most-recently-used project on launch.
  useEffect(() => {
    api
      .listProjects()
      .then((ps) => {
        setKnownProjects(ps);
        if (ps.length) setProject(ps[ps.length - 1]);
      })
      .catch(() => {});
  }, []);

  const refreshAgents = useCallback((pid: string) => {
    api.listAgents(pid).then(setAgents).catch(() => {});
  }, []);

  const refreshGitStatus = useCallback(() => {
    if (project) api.gitStatus(project.path).then(setGit).catch(() => {});
  }, [project]);

  // Load project-scoped data when the project changes.
  useEffect(() => {
    if (!project) {
      setAgents([]);
      setTasks([]);
      setSessions([]);
      return;
    }
    refreshAgents(project.id);
    api.listTasks(project.id).then(setTasks).catch(() => {});
    api.claudeSessions(project.path).then(setSessions).catch(() => {});
    api.runConfig(project.path).then(setServices).catch(() => setServices([]));
    api.intentConfig(project.path).then((c) => setIntentEnabled(c.enabled)).catch(() => {});
    setOpenFiles([]);
    setActiveFile(null);
  }, [project, refreshAgents]);

  // Resolve the home dir once for tilde-ified window titles.
  useEffect(() => {
    api.homeDir().then(setHome).catch(() => {});
  }, []);

  // Disable the webview's default right-click (reload/inspect) menu.
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, []);

  // Poll git for the project.
  useEffect(() => {
    if (!project) {
      setGit(null);
      return;
    }
    let alive = true;
    const poll = () =>
      api.gitStatus(project.path).then((g) => alive && setGit(g)).catch(() => {});
    poll();
    const t = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [project]);

  // Keep a sensible active agent.
  useEffect(() => {
    setActiveAgentId((prev) => {
      if (prev && agents.some((a) => a.id === prev)) return prev;
      const firstLive = agents.find((a) => live.has(a.id));
      return firstLive ? firstLive.id : null;
    });
  }, [agents, live]);

  const addLive = (id: string) => setLive((p) => new Set(p).add(id));
  const removeLive = (id: string) =>
    setLive((p) => {
      const n = new Set(p);
      n.delete(id);
      return n;
    });

  const openFolder = async () => {
    setMenuOpen(false);
    const path = await api.pickFolder();
    if (!path) return;
    const p = await api.addProject(path);
    setProject(p);
    setView("workspace");
    api.listProjects().then(setKnownProjects).catch(() => {});
  };

  // --- Home dashboard handlers ---
  // Enter a project's workspace from Home.
  const openProjectFromHome = (p: Project) => {
    setProject(p);
    setView("workspace");
  };
  // Jump straight to a specific (running) agent in its project.
  const openAgentFromHome = (agent: AgentRecord) => {
    const p = knownProjects.find((kp) => kp.id === agent.project_id);
    if (p) setProject(p);
    setActiveAgentId(agent.id);
    addLive(agent.id);
    setView("workspace");
  };
  // Respond to a waiting agent without entering its project.
  const acceptAgent = (id: string) => void api.writeInput(id, "\r");
  const yesAgent = (id: string) => void api.writeInput(id, "y\r");
  const noAgent = (id: string) => void api.writeInput(id, "n\r");

  // Native window menu → app actions.
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<string>("menu", (ev) => {
      switch (ev.payload) {
        case "open-project":
          void openFolder();
          break;
        case "new-window":
          api.openWindow();
          break;
        case "home":
          setView("home");
          break;
      }
    }).then((u) => {
      un = u;
    });
    return () => un?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset the center diff when switching project.
  useEffect(() => setDiffView(null), [project]);

  // Poll Claude usage for the bottom bar while a live Claude agent is active.
  useEffect(() => {
    if (!project) {
      setUsage(null);
      return;
    }
    const rec = agents.find((a) => a.id === activeAgentId);
    const isClaude =
      !!rec && live.has(rec.id) && /(^|\/)claude(\s|$)/.test(rec.command);
    if (!isClaude) {
      setUsage(null);
      return;
    }
    let alive = true;
    const poll = () =>
      api.claudeUsage(project.path).then((u) => alive && setUsage(u)).catch(() => {});
    poll();
    const t = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [project, agents, live, activeAgentId]);

  // OS window title like "EvorIde - ~/sajilobima/".
  useEffect(() => {
    let loc = project?.path ?? "";
    if (home && loc.startsWith(home)) loc = `~${loc.slice(home.length)}`;
    if (loc && !loc.endsWith("/")) loc += "/";
    const title = project ? `EvorIde - ${loc}` : "EvorIde";
    document.title = title;
    getCurrentWindow().setTitle(title).catch(() => {});
  }, [project, home]);

  const launch = async (args: {
    title: string;
    command?: string;
    resumeFrom?: string;
    subdir?: string;
  }): Promise<AgentRecord | null> => {
    if (!project) return null;
    const rec = await api.spawnAgent({ projectId: project.id, ...args });
    addLive(rec.id);
    setAgents((prev) => [rec, ...prev.filter((a) => a.id !== rec.id)]);
    setActiveAgentId(rec.id);
    return rec;
  };

  const newAgent = (title: string, command: string) =>
    void launch({ title, command: command || undefined });
  const continueSession = (s: ClaudeSession) =>
    void launch({ title: s.summary, command: `claude --resume ${s.id}` });

  // Re-launch an EXISTING agent in place (no new history entry).
  const resumeExisting = async (id: string) => {
    setDiffView(null);
    addLive(id);
    setActiveAgentId(id);
    setAgents((prev) =>
      prev.map((a) => (a.id === id ? { ...a, status: "running" } : a)),
    );
    setAgentIssues((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    try {
      await api.resumeAgent(id);
    } catch {
      removeLive(id);
    }
  };
  const resumeAgent = (src: AgentRecord) => void resumeExisting(src.id);

  // Spawn a Claude agent pre-loaded with the failure context to fix it.
  const spawnFix = async (label: string, context: string) => {
    const prompt = `A command in the terminal ran into an issue. Terminal output:\n\n${context}\n\nPlease diagnose the root cause and fix it in the code, then re-run to confirm it works.`;
    const rec = await launch({ title: `fix: ${label}`, command: "claude" });
    if (rec) {
      // Once Claude is ready, paste the prompt (bracketed paste keeps newlines).
      window.setTimeout(() => {
        api
          .writeInput(rec.id, `\x1b[200~${prompt}\x1b[201~`)
          .then(() => api.writeInput(rec.id, "\r"))
          .catch(() => {});
      }, 1500);
    }
  };
  const fixIssue = (rec: AgentRecord) => {
    const issue = agentIssues[rec.id];
    setAgentIssues((prev) => {
      const n = { ...prev };
      delete n[rec.id];
      return n;
    });
    void spawnFix(rec.title, issue?.context ?? "");
  };
  const fixLiveIssue = () => {
    if (!liveIssue) return;
    const ctx = liveIssue.context;
    const label = activeRec?.title ?? "run";
    setLiveIssue(null);
    void spawnFix(label, ctx);
  };

  // --- run services ---
  const startService = async (s: Service) => {
    const rec = await launch({
      title: s.name,
      command: s.command || undefined,
      subdir: s.cwd || undefined,
    });
    if (rec) setRunningServices((prev) => ({ ...prev, [s.name]: rec.id }));
  };
  const stopService = (s: Service) => {
    const id = runningServices[s.name];
    if (id) void closeAgent(id);
    setRunningServices((prev) => {
      const n = { ...prev };
      delete n[s.name];
      return n;
    });
  };
  const refreshRunConfig = async () => {
    if (!project) return;
    const svcs = await api.createRunConfig(project.path).catch(() => null);
    if (svcs) setServices(svcs);
  };

  // Ask the active (live) agent to commit & push by typing an instruction.
  const askCommitPush = (message: string) => {
    if (activeAgentId && live.has(activeAgentId)) {
      void api.writeInput(activeAgentId, `${message}\r`);
    }
  };

  const closeAgent = async (id: string) => {
    await api.closeAgent(id).catch(() => {});
    removeLive(id);
    if (project) refreshAgents(project.id);
  };

  const archiveAgentH = async (id: string) => {
    await api.archiveAgent(id).catch(() => {});
    removeLive(id);
    if (activeAgentId === id) setActiveAgentId(null);
    if (project) refreshAgents(project.id);
  };
  const deleteAgentH = async (id: string) => {
    await api.deleteAgent(id).catch(() => {});
    removeLive(id);
    if (activeAgentId === id) setActiveAgentId(null);
    setAgents((prev) => prev.filter((a) => a.id !== id));
  };
  const unarchiveAgentH = async (id: string) => {
    await api.markAgentExited(id).catch(() => {});
    if (project) refreshAgents(project.id);
  };

  const handleExit = useCallback(
    (id: string, info?: { hasError: boolean; context: string }) => {
      api.markAgentExited(id).catch(() => {});
      removeLive(id);
      if (info?.hasError) {
        setAgentIssues((prev) => ({ ...prev, [id]: { context: info.context } }));
      }
      setRunningServices((prev) => {
        const n = { ...prev };
        for (const k of Object.keys(n)) if (n[k] === id) delete n[k];
        return n;
      });
      setUrlByAgent((prev) => {
        const n = { ...prev };
        delete n[id];
        return n;
      });
      if (project) {
        refreshAgents(project.id);
        // Session ended → derive the intent doc.
        if (intentEnabled) api.updateIntent(project.path).catch(() => {});
      }
    },
    [project, refreshAgents, intentEnabled],
  );

  // Keep the intent doc in sync with the code right before a commit.
  const beforeCommit = useCallback(async () => {
    if (project && intentEnabled) await api.updateIntent(project.path).catch(() => {});
  }, [project, intentEnabled]);

  // Global exit listener so background (discarded) agents update too.
  const handleExitRef = useRef(handleExit);
  handleExitRef.current = handleExit;
  useEffect(() => {
    let un: (() => void) | undefined;
    api.onAnyAgentExit((id, info) => handleExitRef.current(id, info)).then((u) => {
      un = u;
    });
    return () => un?.();
  }, []);

  // Poll per-agent edit counts for the active project (row badges).
  useEffect(() => {
    if (!project) {
      setEditCounts({});
      return;
    }
    let alive = true;
    const poll = () =>
      api.agentEditCounts(project.path).then((c) => alive && setEditCounts(c)).catch(() => {});
    poll();
    const t = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [project]);

  // Poll running agents across all projects (for the rail).
  useEffect(() => {
    let alive = true;
    const poll = () =>
      api.runningAgents().then((r) => alive && setRunningList(r)).catch(() => {});
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agents]);

  // Global "agent waiting for input" listener.
  useEffect(() => {
    let un: (() => void) | undefined;
    api
      .onAgentWaiting((id, waiting) =>
        setWaitingAgents((prev) => {
          const n = new Set(prev);
          if (waiting) n.add(id);
          else n.delete(id);
          return n;
        }),
      )
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, []);

  const addTask = (title: string) => {
    if (!project) return;
    api.addTask(project.id, title).then((t) => setTasks((p) => [...p, t]));
  };
  const cycleTask = (t: Task) => {
    const next = NEXT_STATUS[t.status];
    api.updateTask(t.id, next).then(() =>
      setTasks((p) => p.map((x) => (x.id === t.id ? { ...x, status: next } : x))),
    );
  };
  const delTask = (id: string) =>
    api.deleteTask(id).then(() => setTasks((p) => p.filter((x) => x.id !== id)));

  const activeAgents = useMemo(
    () => agents.filter((a) => a.status !== "archived"),
    [agents],
  );
  const archivedAgents = useMemo(
    () => agents.filter((a) => a.status === "archived"),
    [agents],
  );
  const activeRec = agents.find((a) => a.id === activeAgentId) ?? null;
  const activeIsLive = activeAgentId ? live.has(activeAgentId) : false;

  const runningServiceMap = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const [name, id] of Object.entries(runningServices)) m[name] = live.has(id);
    return m;
  }, [runningServices, live]);

  // Claude sessions already running in THIS window (launched via --resume <id>).
  const runningSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const a of agents) {
      if (!live.has(a.id)) continue;
      const m = a.command.match(/--resume\s+(\S+)/);
      if (m) ids.add(m[1]);
    }
    return ids;
  }, [agents, live]);
  const continuableSessions = useMemo(
    () => sessions.filter((s) => !runningSessionIds.has(s.id)),
    [sessions, runningSessionIds],
  );

  const activeModel = useMemo(() => {
    if (!activeRec || !/(^|\/)claude(\s|$)/.test(activeRec.command)) return null;
    const matched = sessions.find((s) => activeRec.command.includes(s.id));
    return matched?.model ?? sessions[0]?.model ?? null;
  }, [activeRec, sessions]);

  // Per-project running counts + which projects are waiting for input.
  const runningByProject = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of runningList) m[a.project_id] = (m[a.project_id] ?? 0) + 1;
    return m;
  }, [runningList]);
  const agentProject = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of runningList) m[a.id] = a.project_id;
    for (const a of agents) m[a.id] = a.project_id;
    return m;
  }, [runningList, agents]);
  const waitingProjects = useMemo(() => {
    const s = new Set<string>();
    for (const id of waitingAgents) {
      const pid = agentProject[id];
      if (pid) s.add(pid);
    }
    return s;
  }, [waitingAgents, agentProject]);

  // No projects at all → the original welcome screen.
  if (knownProjects.length === 0) {
    return (
      <div className="ide">
        <div className="welcome">
          <h1>EvorIde</h1>
          <p>Open a project folder to start running agents.</p>
          <button className="btn" onClick={openFolder}>
            Open folder
          </button>
        </div>
      </div>
    );
  }

  // Cross-project Home dashboard.
  if (view === "home") {
    return (
      <div className="ide">
        <div className="ide-main">
          <ProjectRail
            projects={knownProjects}
            activeId={project?.id ?? null}
            runningByProject={runningByProject}
            waitingProjects={waitingProjects}
            onSelect={openProjectFromHome}
            onOpen={openFolder}
            onHome={() => setView("home")}
          />
          <HomeView
            projects={knownProjects}
            runningList={runningList}
            waitingAgents={waitingAgents}
            runningByProject={runningByProject}
            waitingProjects={waitingProjects}
            onOpenProject={openProjectFromHome}
            onOpenAgent={openAgentFromHome}
            onAccept={acceptAgent}
            onYes={yesAgent}
            onNo={noAgent}
          />
        </div>
      </div>
    );
  }

  // Workspace requires an active project; if somehow absent, go Home.
  if (!project) {
    return (
      <div className="ide">
        <div className="welcome">
          <h1>EvorIde</h1>
          <p>Select a project to continue.</p>
          <button className="btn" onClick={() => setView("home")}>
            Go to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ide">
      <div className="ide-main">
        <ProjectRail
          projects={knownProjects}
          activeId={project.id}
          runningByProject={runningByProject}
          waitingProjects={waitingProjects}
          onSelect={(p) => {
            setProject(p);
            setView("workspace");
          }}
          onOpen={openFolder}
          onHome={() => setView("home")}
        />
        <AgentsColumn
          agents={activeAgents}
          archived={archivedAgents}
          live={live}
          activeAgentId={activeAgentId}
          git={git}
          sessions={continuableSessions}
          editCounts={editCounts}
          onSelect={(id) => {
            setCenterMode("terminal");
            setLiveIssue(null);
            if (!live.has(id)) {
              // Clicking a stopped agent auto-resumes it in place.
              void resumeExisting(id);
            } else {
              setDiffView(null);
              setActiveAgentId(id);
            }
          }}
          onNew={newAgent}
          onResume={resumeAgent}
          onClose={closeAgent}
          onArchive={archiveAgentH}
          onDelete={deleteAgentH}
          onUnarchive={unarchiveAgentH}
          onContinueSession={continueSession}
        />

        <main className="main">
          <div className="topbar">
            <div className="tb-project">
              <button
                className="tb-name"
                onClick={() => setMenuOpen((o) => !o)}
                title="Project menu"
              >
                <FolderIcon />
                <span>{project.name}</span>
                <span className="tb-caret">▾</span>
              </button>
              {menuOpen && (
                <div className="tb-menu" onMouseLeave={() => setMenuOpen(false)}>
                  <button className="tb-menu-item" onClick={openFolder}>
                    Open project…
                  </button>
                  <button
                    className="tb-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      api.openWindow();
                    }}
                  >
                    Open in new window
                  </button>
                  {knownProjects.filter((p) => p.id !== project.id).length > 0 && (
                    <>
                      <div className="tb-menu-sep" />
                      <div className="tb-menu-label">Recent</div>
                      {knownProjects
                        .filter((p) => p.id !== project.id)
                        .slice(-6)
                        .reverse()
                        .map((p) => (
                          <button
                            key={p.id}
                            className="tb-menu-item recent"
                            title={p.path}
                            onClick={() => {
                              setProject(p);
                              setMenuOpen(false);
                            }}
                          >
                            {p.name}
                          </button>
                        ))}
                    </>
                  )}
                </div>
              )}
            </div>
            {activeRec && (
              <span className="tb-active" title={activeRec.title}>
                {activeRec.title}
              </span>
            )}
            <span className="tb-path" title={project.path}>
              {project.path}
            </span>
            {git?.is_repo && (
              <span className="tb-branch">
                ⎇ {git.branch}
                {git.dirty > 0 && <span className="tb-dirty"> ●{git.dirty}</span>}
              </span>
            )}

            <div className="tb-actions">
              <RunControl
                services={services}
                running={runningServiceMap}
                onStart={startService}
                onStop={stopService}
                onCreateConfig={refreshRunConfig}
              />
              <button
                className="btn-sm"
                onClick={() => newAgent("Claude", "claude")}
                title="New Claude session"
              >
                ＋ Claude
              </button>
              {openFiles.length > 0 && (
                <>
                  <span className="tb-sep" />
                  <div className="center-switch">
                    <button
                      className={centerMode === "terminal" ? "on" : ""}
                      onClick={() => setCenterMode("terminal")}
                    >
                      Terminal
                    </button>
                    <button
                      className={centerMode === "editor" ? "on" : ""}
                      onClick={() => setCenterMode("editor")}
                    >
                      Files ({openFiles.length})
                    </button>
                  </div>
                </>
              )}
              <span className="tb-sep" />
              {(["files", "git", "plan", "intent", "edits"] as const).map((p) => (
                <button
                  key={p}
                  className={`toggle ${rightPanel === p ? "on" : ""}`}
                  onClick={() => setRightPanel((cur) => (cur === p ? null : p))}
                >
                  {p === "files"
                    ? "Files"
                    : p === "git"
                      ? "Git"
                      : p === "plan"
                        ? "Plan"
                        : p === "intent"
                          ? "Intent"
                          : "Edits"}
                </button>
              ))}
              <button className="toggle" onClick={() => api.openWindow()} title="New window">
                ⧉
              </button>
            </div>
          </div>

          <div className="main-body">
            <div className="term-area">
              {/* Center shows ONE of: diff, file editor, or the agent terminal. */}
              {diffView ? (
                <div className="term-slot">
                  <DiffView
                    cwd={project.path}
                    file={diffView.file}
                    onClose={() => setDiffView(null)}
                  />
                </div>
              ) : centerMode === "editor" && openFiles.length > 0 ? (
                <div className="term-slot center-fill">
                  <Editor
                    files={openFiles}
                    activePath={activeFile}
                    onActivate={setActiveFile}
                    onClose={closeFile}
                  />
                </div>
              ) : activeIsLive && activeAgentId ? (
                <div className="term-slot">
                  <AgentTerminal
                    key={activeAgentId}
                    id={activeAgentId}
                    active
                    onUrl={(url) =>
                      setUrlByAgent((prev) =>
                        prev[activeAgentId] === url
                          ? prev
                          : { ...prev, [activeAgentId]: url },
                      )
                    }
                    onIssue={(context) =>
                      setLiveIssue({ id: activeAgentId, context })
                    }
                  />
                  {liveIssue?.id === activeAgentId && (
                    <button className="fix-overlay" onClick={fixLiveIssue}>
                      ⚠ Fix this issue
                    </button>
                  )}
                </div>
              ) : activeRec ? (
                <div className="term-slot term-placeholder">
                  {agentIssues[activeRec.id] && (
                    <p className="ph-issue">⚠ This run hit an issue.</p>
                  )}
                  <p>“{activeRec.title}” isn’t running.</p>
                  <span className="ph-cmd">{activeRec.command || "$SHELL"}</span>
                  <div className="ph-actions">
                    <button className="btn" onClick={() => resumeAgent(activeRec)}>
                      ↻ Resume session
                    </button>
                    {agentIssues[activeRec.id] && (
                      <button className="btn-ghost" onClick={() => fixIssue(activeRec)}>
                        ⚠ Fix this issue
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="term-slot launcher-slot">
                  <SessionLauncher onNew={newAgent} />
                </div>
              )}
            </div>

            {/* One right-side panel at a time. */}
            {rightPanel === "files" && (
              <FileExplorer
                root={project.path}
                onOpenFile={openFile}
                activePath={activeFile}
              />
            )}
            {rightPanel === "git" && (
              <GitPanel
                cwd={project.path}
                git={git}
                canAsk={activeIsLive}
                onAskAgent={askCommitPush}
                onRefreshStatus={refreshGitStatus}
                onOpenDiff={(file) => setDiffView({ file })}
                onBeforeCommit={beforeCommit}
              />
            )}
            {rightPanel === "intent" && <IntentPanel projectPath={project.path} />}
            {rightPanel === "edits" && (
              <EditsPanel
                projectPath={project.path}
                agentId={activeAgentId}
                agentTitle={activeRec?.title ?? null}
              />
            )}
            {rightPanel === "plan" && (
              <TasksPanel
                tasks={tasks}
                onAdd={addTask}
                onCycle={cycleTask}
                onDelete={delTask}
              />
            )}
          </div>
        </main>
      </div>

      <StatusBar
        git={git}
        activeAgent={activeRec}
        live={activeIsLive}
        model={activeModel}
        usage={usage}
        url={activeAgentId ? (urlByAgent[activeAgentId] ?? null) : null}
        onOpenUrl={(u) => openUrl(u).catch(() => {})}
        theme={theme}
        onCycleTheme={() =>
          setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"))
        }
      />
    </div>
  );
}
