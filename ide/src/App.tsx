import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ProjectRail from "./components/ProjectRail";
import AgentsColumn from "./components/AgentsColumn";
import SessionLauncher from "./components/SessionLauncher";
import RunControl from "./components/RunControl";
import StatusBar from "./components/StatusBar";
import HomeView from "./components/HomeView";
import HomeBar from "./components/HomeBar";
import SettingsDialog from "./components/SettingsDialog";
import CommandPalette, { type Command } from "./components/CommandPalette";
import { loadAgents, saveAgents, enabledClis, type AgentConfig } from "./lib/agents";
import * as demo from "./lib/demo";
// Heavy / on-demand components are code-split (xterm, editor, diff, panels).
const GridWorkspace = lazy(() => import("./components/GridWorkspace"));
const AgentTerminal = lazy(() => import("./components/AgentTerminal"));
const Editor = lazy(() => import("./components/Editor"));
const DiffView = lazy(() => import("./components/DiffView"));
const FileExplorer = lazy(() => import("./components/FileExplorer"));
const GitPanel = lazy(() => import("./components/GitPanel"));
const IntentPanel = lazy(() => import("./components/IntentPanel"));
const TasksPanel = lazy(() => import("./components/TasksPanel"));
const EditsPanel = lazy(() => import("./components/EditsPanel"));
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { midTruncate } from "./lib/util";
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

/** Max terminals per workspace — keeps each layout (full/split/3-way/quad) clean. */
const MAX_TILES = 4;
/** A named Workspace grid holding up to MAX_TILES pinned agent tiles. */
interface Workspace {
  id: string;
  name: string;
  tiles: string[];
}

export default function App() {
  // Top-level view: the cross-project Home dashboard, or the single-project
  // workspace. Defaults to Home on launch when projects exist.
  const [view, setView] = useState<"home" | "workspace" | "grid">("home");
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
  // Parsed numbered-menu choices per waiting agent (id → option labels).
  const [waitingOptions, setWaitingOptions] = useState<Record<string, string[]>>({});
  // What each waiting agent is asking (the question/prompt text).
  const [waitingQuestion, setWaitingQuestion] = useState<Record<string, string>>({});
  // true → the agent's choices are free-text (send the label), not a numbered menu.
  const [waitingTextMode, setWaitingTextMode] = useState<Record<string, boolean>>({});
  // Hidden helper-judge: per-agent classified state + plumbing to run it on idle.
  const [agentState, setAgentState] = useState<Record<string, "working" | "passive" | "active">>({});
  const [hasJudge, setHasJudge] = useState(false);
  // Real app version (from the release tag → tauri.conf.json), shown in the bars.
  const [appVer, setAppVer] = useState("");
  useEffect(() => {
    api.appVersion().then(setAppVer).catch(() => {});
  }, []);
  const lastOutputRef = useRef<Record<string, number>>({});
  const judgedRef = useRef<Record<string, number>>({});
  // Multi-terminal "Workspace" grid. Several named workspaces, each holding up
  // to MAX_TILES pinned agent tiles, persisted and reconciled on load.
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => {
    try {
      const raw = localStorage.getItem("evoride-workspaces");
      if (raw) {
        const ws = JSON.parse(raw) as Workspace[];
        if (Array.isArray(ws) && ws.length) return ws;
      }
      // Migrate the old single flat grid, if any.
      const old = localStorage.getItem("evoride-grid");
      const tiles = old ? (JSON.parse(old) as string[]).slice(0, MAX_TILES) : [];
      return [{ id: "ws-1", name: "Workspace 1", tiles }];
    } catch {
      return [{ id: "ws-1", name: "Workspace 1", tiles: [] }];
    }
  });
  const [activeWs, setActiveWs] = useState<string>(
    () => localStorage.getItem("evoride-active-ws") || "ws-1",
  );
  const activeWorkspace = workspaces.find((w) => w.id === activeWs) ?? workspaces[0];
  const gridAgents = activeWorkspace?.tiles ?? [];
  // Mutate the active workspace's tiles.
  const setActiveTiles = (fn: (tiles: string[]) => string[]) =>
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === activeWs ? { ...w, tiles: fn(w.tiles) } : w)),
    );
  // Theme: follow system, or manual light/dark.
  const [theme, setTheme] = useState<"system" | "light" | "dark">(
    () => (localStorage.getItem("evoride-theme") as never) || "system",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("evoride-theme", theme);
  }, [theme]);
  const cycleTheme = () =>
    setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"));
  // One-time: clear the old, fumble-prone auto-pin key so nobody is stuck on top.
  useEffect(() => {
    localStorage.removeItem("evoride-pinned");
  }, []);
  // Always-on-top is now an opt-in Setting (default OFF), applied on change.
  const [alwaysOnTop, setAlwaysOnTop] = useState(
    () => localStorage.getItem("evoride-alwaysontop") === "1",
  );
  useEffect(() => {
    api.setAlwaysOnTop(alwaysOnTop).catch(() => {});
    localStorage.setItem("evoride-alwaysontop", alwaysOnTop ? "1" : "0");
  }, [alwaysOnTop]);
  // AI idle analyzer (helper-judge) — user toggle, default ON.
  const [judgeEnabled, setJudgeEnabled] = useState(
    () => localStorage.getItem("evoride-judge") !== "0",
  );
  useEffect(() => {
    localStorage.setItem("evoride-judge", judgeEnabled ? "1" : "0");
  }, [judgeEnabled]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // User-configurable agent registry (enable + path), persisted.
  const [agentConfigs, setAgentConfigs] = useState<AgentConfig[]>(loadAgents);
  useEffect(() => saveAgents(agentConfigs), [agentConfigs]);
  const enabledAgentClis = useMemo(() => enabledClis(agentConfigs), [agentConfigs]);
  const openPalette = (mode: "files" | "commands" = "commands") => {
    setPaletteMode(mode);
    setPaletteOpen(true);
  };
  // Command palette (⌘P files / ⌘⇧P commands).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<"files" | "commands">("files");
  const [paletteFiles, setPaletteFiles] = useState<string[]>([]);
  // Which overlay the Workspace grid shows ("pull" / "new"), controlled here so
  // the command palette can open them too.
  const [gridMenu, setGridMenu] = useState<"pull" | "new" | null>(null);
  // All agents across projects (for the grid's "resume inactive" section).
  const [allAgentList, setAllAgentList] = useState<AgentRecord[]>([]);

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

  const demoOn = demo.isDemo();

  // Open the most-recently-used project on launch — OR, in demo/screenshot mode,
  // seed the dashboard with realistic fake data and stay on Home.
  useEffect(() => {
    if (demoOn) {
      setKnownProjects(demo.demoProjects);
      setRunningList(demo.demoRunning);
      setWaitingAgents(new Set(demo.demoWaitingIds));
      setWaitingOptions(demo.demoOptions);
      setWaitingQuestion(demo.demoQuestion);
      setWaitingTextMode(demo.demoTextMode);
      setAgentState(demo.demoState);
      setView("home");
      return;
    }
    api
      .listProjects()
      .then((ps) => {
        setKnownProjects(ps);
        if (ps.length) setProject(ps[ps.length - 1]);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    api.runConfig(project.id, project.path).then(setServices).catch(() => setServices([]));
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

  // Global command-palette shortcuts. ⌘⇧P always opens commands. Plain ⌘P is
  // page-aware: file search only makes sense inside a project's workspace, so
  // elsewhere (Home / grid) it opens the (context-appropriate) command list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== "p") return;
      e.preventDefault();
      const fileable = view === "workspace" && !!project;
      setPaletteMode(e.shiftKey || !fileable ? "commands" : "files");
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, project]);

  // Re-fetch the project's file list whenever the palette opens in file mode.
  useEffect(() => {
    if (paletteOpen && paletteMode === "files" && project) {
      api.listFiles(project.path).then(setPaletteFiles).catch(() => setPaletteFiles([]));
    }
  }, [paletteOpen, paletteMode, project]);

  // Poll all agents (running + stopped) for the grid's "resume inactive" list.
  useEffect(() => {
    let alive = true;
    const poll = () =>
      api.allAgents().then((a) => alive && setAllAgentList(a)).catch(() => {});
    poll();
    const t = setInterval(() => !document.hidden && poll(), 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agents]);

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
    const t = setInterval(() => !document.hidden && poll(), 4000);
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

  // On mount, RESTORE the saved workspaces. We keep every tile whose agent still
  // exists (so the workspace comes back exactly as you left it) and mark the ones
  // already running as live. Stopped tiles stay as "resume" placeholders and are
  // re-attached lazily when you view them — no startup stampede of `claude
  // --continue`. Only tiles whose agent was deleted entirely are dropped.
  useEffect(() => {
    Promise.all([api.runningAgents(), api.allAgents()])
      .then(([running, all]) => {
        const alive = new Set(running.map((a) => a.id));
        const known = new Set(all.map((a) => a.id));
        setWorkspaces((prev) =>
          prev.map((w) => ({ ...w, tiles: w.tiles.filter((id) => known.has(id)) })),
        );
        setLive((p) => {
          const n = new Set(p);
          for (const w of workspaces) for (const id of w.tiles) if (alive.has(id)) n.add(id);
          return n;
        });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist workspaces + which one is active.
  useEffect(() => {
    localStorage.setItem("evoride-workspaces", JSON.stringify(workspaces));
  }, [workspaces]);
  useEffect(() => {
    localStorage.setItem("evoride-active-ws", activeWs);
  }, [activeWs]);

  // Is the active workspace full? (cap reached) — used to gate adds.
  const gridFull = gridAgents.length >= MAX_TILES;

  // Pull an already-running agent into the active workspace (no spawn).
  const addRunningToGrid = (id: string) => {
    addLive(id);
    setActiveTiles((prev) =>
      prev.includes(id) || prev.length >= MAX_TILES ? prev : [...prev, id],
    );
  };
  // Spawn a fresh agent straight into the active workspace.
  const spawnToGrid = async (projectId: string, command: string, title: string) => {
    if (gridFull) return;
    const rec = await api.spawnAgent({
      projectId,
      title: title || "agent",
      command: command || undefined,
    });
    addLive(rec.id);
    setActiveTiles((prev) => (prev.length >= MAX_TILES ? prev : [...prev, rec.id]));
  };
  // Resume a stopped agent. If it's already a tile (a restored placeholder),
  // just bring its session back in place; otherwise pin it (respecting the cap).
  const onResumeToGrid = async (id: string) => {
    const alreadyTiled = gridAgents.includes(id);
    if (!alreadyTiled && gridFull) return;
    await api.resumeAgent(id).catch(() => {});
    addLive(id);
    if (!alreadyTiled) {
      setActiveTiles((prev) => (prev.length >= MAX_TILES ? prev : [...prev, id]));
    }
  };
  // Workspace management: add, switch, close, rename.
  const addWorkspace = () => {
    const n = workspaces.length + 1;
    const id = `ws-${Date.now()}`;
    setWorkspaces((prev) => [...prev, { id, name: `Workspace ${n}`, tiles: [] }]);
    setActiveWs(id);
  };
  const closeWorkspace = (id: string) => {
    setWorkspaces((prev) => {
      if (prev.length <= 1) return prev; // keep at least one
      const next = prev.filter((w) => w.id !== id);
      if (id === activeWs) setActiveWs(next[0].id);
      return next;
    });
  };
  const renameWorkspace = (id: string, name: string) =>
    setWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, name } : w)));
  // Un-pin a tile (the agent keeps running).
  const removeTile = (id: string) =>
    setActiveTiles((prev) => prev.filter((x) => x !== id));

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
  // Optimistically clear the "needs you" flag the instant the user replies;
  // the backend re-flags only if a new prompt appears after the agent responds.
  const clearWaiting = (id: string) => {
    setWaitingAgents((prev) => {
      if (!prev.has(id)) return prev;
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    setWaitingOptions((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    setWaitingQuestion((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    setWaitingTextMode((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    // The user is responding — reset the idle clock so the judge re-evaluates.
    lastOutputRef.current[id] = Date.now();
  };
  // Respond to a waiting agent without entering its project.
  const reply = (id: string, data: string) => {
    void api.writeInput(id, data);
    clearWaiting(id);
  };
  const acceptAgent = (id: string) => reply(id, "\r");
  const yesAgent = (id: string) => reply(id, "y\r");
  const noAgent = (id: string) => reply(id, "n\r");
  // Pick a choice: a real numbered menu takes the digit; judge-inferred choices
  // on a free-text question take the choice's TEXT (typing "1" wouldn't work).
  const pickOption = (id: string, n: number, label: string) =>
    reply(id, waitingTextMode[id] ? `${label}\r` : `${n}\r`);

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
        case "settings":
          setSettingsOpen(true);
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
    const t = setInterval(() => !document.hidden && poll(), 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [project, agents, live, activeAgentId]);

  // OS window title like "EvorIDE - ~/sajilobima/".
  useEffect(() => {
    let loc = project?.path ?? "";
    if (home && loc.startsWith(home)) loc = `~${loc.slice(home.length)}`;
    if (loc && !loc.endsWith("/")) loc += "/";
    const title = project ? `EvorIDE - ${loc}` : "EvorIDE";
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
  // "Set up run with AI": spawn a Claude agent, hand it the instruction to write
  // ~/.evoride/{id}/runinfo.json, then poll for the result, load it, and run it.
  const setupRunWithAI = async () => {
    if (!project) return;
    const pid = project.id;
    const prompt = await api.runSetupPrompt(pid).catch(() => null);
    if (!prompt) return;
    const before = JSON.stringify(services); // so we only react to the NEW config
    const rec = await launch({ title: "Set up run", command: "claude" });
    if (!rec) return;
    // Give the agent a moment to come up, then send the (single-line) instruction.
    window.setTimeout(() => void api.writeInput(rec.id, `${prompt}\r`), 1800);
    // Watch for the generated config; once it lands (differs from before), load +
    // auto-run it — "run after you complete it".
    let tries = 0;
    const iv = window.setInterval(async () => {
      tries += 1;
      const svcs = await api.runConfig(pid, project.path).catch(() => [] as typeof services);
      const ready = svcs.filter((s) => s.command.trim());
      if (ready.length && JSON.stringify(svcs) !== before) {
        window.clearInterval(iv);
        setServices(svcs);
        ready.forEach((s) => void startService(s)); // run after it completes
      } else if (tries > 90) {
        window.clearInterval(iv); // ~3 min cap
      }
    }, 2000);
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
    const t = setInterval(() => !document.hidden && poll(), 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [project]);

  // Poll running agents across all projects (for the rail). Frozen in demo mode.
  useEffect(() => {
    if (demoOn) return;
    let alive = true;
    const poll = () =>
      api.runningAgents().then((r) => alive && setRunningList(r)).catch(() => {});
    poll();
    const t = setInterval(() => !document.hidden && poll(), 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agents]);

  // Global "agent waiting for input" listener.
  useEffect(() => {
    let un: (() => void) | undefined;
    api
      .onAgentWaiting((id, waiting, options, question) => {
        setWaitingAgents((prev) => {
          const n = new Set(prev);
          if (waiting) n.add(id);
          else n.delete(id);
          return n;
        });
        setWaitingOptions((prev) => {
          if (!waiting) {
            if (!(id in prev)) return prev;
            const { [id]: _drop, ...rest } = prev;
            return rest;
          }
          return { ...prev, [id]: options };
        });
        setWaitingQuestion((prev) => {
          if (!waiting || !question) {
            if (!(id in prev)) return prev;
            const { [id]: _drop, ...rest } = prev;
            return rest;
          }
          return { ...prev, [id]: question };
        });
        // Regex options come from a real ❯ numbered menu → select by number.
        setWaitingTextMode((prev) => {
          if (!(id in prev)) return prev;
          const { [id]: _drop, ...rest } = prev;
          return rest;
        });
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, []);

  // --- Hidden helper-judge: classify idle agents as working / passively-idle /
  // actively-needing-you, far more reliably than the regex. Is a helper present?
  useEffect(() => {
    api.judgeHelper().then((h) => setHasJudge(!!h)).catch(() => {});
  }, []);

  // Track per-agent idleness from raw output (timestamp only, no re-render).
  useEffect(() => {
    let un: (() => void) | undefined;
    api
      .onAnyOutput((id) => {
        lastOutputRef.current[id] = Date.now();
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, []);

  // Once agents have been idle a few seconds, classify them — but in ONE batched
  // helper call per tick (not one process per agent), reconciling the "needs you"
  // flag: adding misses, clearing false positives, marking passively-idle ones.
  useEffect(() => {
    if (demoOn || !hasJudge || !judgeEnabled) return;
    const IDLE_MS = 3000;
    let busy = false; // one batch in flight at a time
    const applyVerdict = (id: string, j: api.Judgement | null) => {
      if (!j) return;
      const state = j.state === "waiting_active" ? "active" : j.state === "waiting_passive" ? "passive" : "working";
      setAgentState((p) => ({ ...p, [id]: state }));
      const active = j.needs_input || j.state === "waiting_active";
      setWaitingAgents((p) => {
        const has = p.has(id);
        if (active === has) return p;
        const n = new Set(p);
        if (active) n.add(id);
        else n.delete(id);
        return n;
      });
      setWaitingOptions((p) => {
        if (active && j.options.length) return { ...p, [id]: j.options };
        if (!active && id in p) {
          const { [id]: _drop, ...rest } = p;
          return rest;
        }
        return p;
      });
      // Judge-inferred choices on a free-text question → reply with the text.
      setWaitingTextMode((p) => {
        if (active && j.options.length) return { ...p, [id]: true };
        if (!active && id in p) {
          const { [id]: _drop, ...rest } = p;
          return rest;
        }
        return p;
      });
      // Use the judge's summary as the question when the regex didn't supply one
      // (e.g. the agent is "asking for direction" with no formal prompt).
      setWaitingQuestion((p) => {
        if (active && j.summary && !p[id]) return { ...p, [id]: j.summary };
        if (!active && id in p) {
          const { [id]: _drop, ...rest } = p;
          return rest;
        }
        return p;
      });
    };
    const tick = () => {
      if (document.hidden || busy) return;
      const now = Date.now();
      const due: string[] = [];
      for (const a of runningList) {
        const base = a.command.split(/\s+/)[0]?.split("/").pop() ?? "";
        if (base !== "claude" && base !== "codex") continue;
        const last = lastOutputRef.current[a.id];
        if (last === undefined) {
          lastOutputRef.current[a.id] = now; // start its idle clock
          continue;
        }
        if (now - last < IDLE_MS) continue; // still actively producing output
        if ((judgedRef.current[a.id] ?? 0) >= last) continue; // judged this idle already
        due.push(a.id);
      }
      if (!due.length) return;
      const batch = due.slice(0, 6); // bound the prompt size
      for (const id of batch) judgedRef.current[id] = lastOutputRef.current[id] ?? now;
      busy = true;
      api
        .judgeAgents(batch)
        .then((results) => {
          for (const r of results) applyVerdict(r.id, r.judgement);
        })
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    };
    const iv = setInterval(tick, 2000);
    return () => clearInterval(iv);
  }, [hasJudge, judgeEnabled, runningList]);

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

  // id → record / id → project maps for resolving grid tile headers.
  const agentsById = useMemo(() => {
    const m: Record<string, AgentRecord> = {};
    for (const a of runningList) m[a.id] = a;
    for (const a of agents) m[a.id] = a;
    return m;
  }, [runningList, agents]);
  const projectsById = useMemo(() => {
    const m: Record<string, Project> = {};
    for (const p of knownProjects) m[p.id] = p;
    return m;
  }, [knownProjects]);

  // Stopped/archived agents not already pinned as grid tiles (for "resume").
  const inactiveAgents = useMemo(() => {
    const pinned = new Set(gridAgents);
    return allAgentList.filter((a) => a.status !== "running" && !pinned.has(a.id));
  }, [allAgentList, gridAgents]);

  // Open a palette file: resolve relative → absolute, open in the center editor.
  const openPaletteFile = useCallback(
    (relPath: string) => {
      if (!project) return;
      const abs = `${project.path.replace(/\/$/, "")}/${relPath}`;
      const base = relPath.split("/").pop() ?? relPath;
      openFile({ name: base, path: abs, is_dir: false });
      setView("workspace");
      setPaletteOpen(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project],
  );

  // Palette commands — assembled per current page so only relevant actions show.
  const paletteCommands = useMemo<Command[]>(() => {
    const cmds: Command[] = [];

    // Navigation (always available, minus the page you're on).
    if (view !== "home")
      cmds.push({ id: "home", label: "Go to Home", hint: "View", run: () => setView("home") });
    if (view !== "grid")
      cmds.push({ id: "grid", label: "Open Workspace (grid)", hint: "View", run: () => setView("grid") });
    if (project && view !== "workspace")
      cmds.push({ id: "back", label: `Back to ${project.name}`, hint: "View", run: () => setView("workspace") });

    // Workspace-grid actions — only meaningful on the grid page.
    if (view === "grid") {
      cmds.push({ id: "pull", label: "Pull agent into workspace", hint: "Workspace", run: () => setGridMenu("pull") });
      cmds.push({ id: "new-grid", label: "New agent in workspace…", hint: "Workspace", run: () => setGridMenu("new") });
    }

    // File search — gated on having a project; otherwise route you to one first.
    if (view === "workspace" && project) {
      cmds.push({ id: "open-file", label: "Open file…", hint: "⌘P", run: () => setPaletteMode("files") });
    } else if (project) {
      cmds.push({
        id: "open-file",
        label: `Open file in ${project.name}…`,
        hint: "File",
        run: () => {
          setView("workspace");
          setPaletteMode("files");
        },
      });
    } else {
      cmds.push({ id: "open-file", label: "Open a project to browse files…", hint: "File", run: () => setView("home") });
    }

    // Agent launchers — spawn into the active project (workspace only).
    if (view === "workspace" && project) {
      cmds.push({ id: "new-claude", label: "New Claude session", hint: "Agent", run: () => newAgent("Claude", "claude") });
      cmds.push({ id: "new-shell", label: "New shell", hint: "Agent", run: () => newAgent("shell", "") });
      cmds.push({ id: "new-codex", label: "New Codex", hint: "Agent", run: () => newAgent("Codex", "codex") });
    }

    // Project + window (always).
    cmds.push({ id: "open-project", label: "Open project…", hint: "Project", run: () => void openFolder() });
    cmds.push({ id: "new-window", label: "New window", hint: "Window", run: () => api.openWindow() });

    // Right-side panels — only exist on the project workspace page.
    if (view === "workspace" && project) {
      cmds.push({ id: "panel-git", label: "Toggle Git panel", hint: "Panel", run: () => setRightPanel((p) => (p === "git" ? null : "git")) });
      cmds.push({ id: "panel-files", label: "Toggle Files panel", hint: "Panel", run: () => setRightPanel((p) => (p === "files" ? null : "files")) });
      cmds.push({ id: "panel-plan", label: "Toggle Plan panel", hint: "Panel", run: () => setRightPanel((p) => (p === "plan" ? null : "plan")) });
      cmds.push({ id: "panel-intent", label: "Toggle Intent panel", hint: "Panel", run: () => setRightPanel((p) => (p === "intent" ? null : "intent")) });
      cmds.push({ id: "panel-edits", label: "Toggle Edits panel", hint: "Panel", run: () => setRightPanel((p) => (p === "edits" ? null : "edits")) });
    }

    // Appearance + settings (always).
    cmds.push({ id: "toggle-theme", label: "Toggle theme", hint: "Appearance", run: cycleTheme });
    cmds.push({ id: "settings", label: "Settings…", hint: "⌘,", run: () => setSettingsOpen(true) });

    return cmds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, project]);

  // Rendered once, overlaying whichever view is active.
  const palette = (
    <>
      <CommandPalette
        open={paletteOpen}
        mode={paletteMode}
        files={paletteFiles}
        commands={paletteCommands}
        projectPath={project?.path ?? null}
        onOpenFile={openPaletteFile}
        onClose={() => setPaletteOpen(false)}
      />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        version={appVer}
        theme={theme}
        setTheme={setTheme}
        alwaysOnTop={alwaysOnTop}
        setAlwaysOnTop={setAlwaysOnTop}
        judgeEnabled={judgeEnabled}
        setJudgeEnabled={setJudgeEnabled}
        agents={agentConfigs}
        setAgents={setAgentConfigs}
      />
    </>
  );

  // No projects at all → the original welcome screen.
  if (knownProjects.length === 0) {
    return (
      <div className="ide">
        <div className="welcome">
          <div className="welcome-card">
            <h1 className="welcome-title">Welcome to EvorIDE</h1>
            <p className="welcome-lead">
              Run many coding agents at once — and always know which one needs you.
            </p>
            <ol className="welcome-steps">
              <li>
                <b>Open a project</b>, then launch <b>Claude</b>, <b>Codex</b>, or any CLI agent
                right inside it.
              </li>
              <li>
                <b>Run several at once</b> across projects — the left rail shows which agents are
                working and which are <b>waiting on you</b>.
              </li>
              <li>
                When an agent needs a decision, see the <b>actual question</b> and <b>reply in one
                click</b> — no hunting through terminals.
              </li>
              <li>
                <b>Git, run/stop, a file editor, and a command palette (⌘P)</b> are all built in.
              </li>
            </ol>
            <div className="welcome-actions">
              <button className="btn primary" onClick={openFolder}>
                Open a project
              </button>
              <span className="welcome-tip">Tip: press ⌘P anytime to jump around.</span>
            </div>
          </div>
        </div>
        {palette}
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
            activeId={null}
            homeActive
            runningByProject={runningByProject}
            waitingProjects={waitingProjects}
            onSelect={openProjectFromHome}
            onOpen={openFolder}
            onHome={() => setView("home")}
            onWorkspace={() => setView("grid")}
          />
          <HomeView
            projects={knownProjects}
            runningList={runningList}
            waitingAgents={waitingAgents}
            waitingOptions={waitingOptions}
            waitingQuestion={waitingQuestion}
            textModes={waitingTextMode}
            runningByProject={runningByProject}
            waitingProjects={waitingProjects}
            onOpenProject={openProjectFromHome}
            onOpenAgent={openAgentFromHome}
            onAccept={acceptAgent}
            onYes={yesAgent}
            onNo={noAgent}
            onPick={pickOption}
          />
        </div>
        <HomeBar
          version={appVer}
          projectCount={knownProjects.length}
          runningCount={runningList.length}
          waitingCount={waitingAgents.size}
          onOpenPalette={() => openPalette("commands")}
          onOpenSettings={() => setSettingsOpen(true)}
          theme={theme}
          onCycleTheme={cycleTheme}
        />
        {palette}
      </div>
    );
  }

  // Multi-terminal Workspace grid (cross-project; not tied to `project`).
  if (view === "grid") {
    return (
      <div className="ide">
        <div className="ide-main">
          <ProjectRail
            projects={knownProjects}
            activeId={null}
            workspaceActive
            runningByProject={runningByProject}
            waitingProjects={waitingProjects}
            onSelect={(p) => {
              setProject(p);
              setView("workspace");
            }}
            onOpen={openFolder}
            onHome={() => setView("home")}
            onWorkspace={() => setView("grid")}
          />
          <Suspense fallback={<div className="grid-view" />}>
            <GridWorkspace
              tileIds={gridAgents}
              maxTiles={MAX_TILES}
              live={live}
              agentsById={agentsById}
              projectsById={projectsById}
              runningList={runningList}
              inactiveAgents={inactiveAgents}
              projects={knownProjects}
              clis={enabledAgentClis}
              workspaces={workspaces}
              activeWs={activeWs}
              onSwitchWs={setActiveWs}
              onNewWs={addWorkspace}
              onCloseWs={closeWorkspace}
              onRenameWs={renameWorkspace}
              menu={gridMenu}
              onMenu={setGridMenu}
              onAddRunning={addRunningToGrid}
              onResumeToGrid={(id) => void onResumeToGrid(id)}
              onSpawn={(pid, command, title) => void spawnToGrid(pid, command, title)}
              onRemoveTile={removeTile}
              onAgentInput={clearWaiting}
            />
          </Suspense>
        </div>
        <HomeBar
          version={appVer}
          projectCount={knownProjects.length}
          runningCount={runningList.length}
          waitingCount={waitingAgents.size}
          onOpenPalette={() => openPalette("commands")}
          onOpenSettings={() => setSettingsOpen(true)}
          theme={theme}
          onCycleTheme={cycleTheme}
        />
        {palette}
      </div>
    );
  }

  // Workspace requires an active project; if somehow absent, go Home.
  if (!project) {
    return (
      <div className="ide">
        <div className="welcome">
          <h1>EvorIDE</h1>
          <p>Select a project to continue.</p>
          <button className="btn" onClick={() => setView("home")}>
            Go to Home
          </button>
        </div>
        {palette}
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
          onWorkspace={() => setView("grid")}
        />
        <AgentsColumn
          agents={activeAgents}
          archived={archivedAgents}
          live={live}
          waiting={waitingAgents}
          states={agentState}
          clis={enabledAgentClis}
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
              {midTruncate(project.path, 52)}
            </span>

            <div className="tb-actions">
              <RunControl
                services={services}
                running={runningServiceMap}
                onStart={startService}
                onStop={stopService}
                onCreateConfig={refreshRunConfig}
                onSetupAi={setupRunWithAI}
              />
              <button
                className="btn-sm icon"
                onClick={() => newAgent("Claude", "claude")}
                title="New Claude session"
                aria-label="New Claude session"
              >
                ✦
              </button>
              {openFiles.length > 0 && (
                <>
                  <span className="tb-sep" />
                  <div className="center-switch">
                    <button
                      className={centerMode === "terminal" ? "on" : ""}
                      onClick={() => setCenterMode("terminal")}
                      title="Show terminal"
                      aria-label="Show terminal"
                    >
                      &gt;_
                    </button>
                    <button
                      className={centerMode === "editor" ? "on" : ""}
                      onClick={() => setCenterMode("editor")}
                      title={`Show files (${openFiles.length} open)`}
                      aria-label="Show files"
                    >
                      📄 {openFiles.length}
                    </button>
                  </div>
                </>
              )}
              <span className="tb-sep" />
              {(
                [
                  { id: "files", icon: "📁", label: "Files" },
                  { id: "git", icon: "⎇", label: "Git changes" },
                  { id: "plan", icon: "☑", label: "Plan / tasks" },
                  { id: "intent", icon: "🎯", label: "Intent" },
                  { id: "edits", icon: "✎", label: "Agent edits" },
                ] as const
              ).map((p) => (
                <button
                  key={p.id}
                  className={`toggle icon ${rightPanel === p.id ? "on" : ""}`}
                  onClick={() => setRightPanel((cur) => (cur === p.id ? null : p.id))}
                  title={p.label}
                  aria-label={p.label}
                >
                  {p.icon}
                </button>
              ))}
              <button
                className="toggle icon"
                onClick={() => api.openWindow()}
                title="New window"
                aria-label="New window"
              >
                ⧉
              </button>
            </div>
          </div>

          <Suspense fallback={<div className="main-body" />}>
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
                    onInput={() => clearWaiting(activeAgentId)}
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
                  <SessionLauncher onNew={newAgent} clis={enabledAgentClis} />
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
          </Suspense>
        </main>
      </div>

      <StatusBar
        git={git}
        version={appVer}
        projectName={project?.name ?? null}
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
        onOpenSettings={() => setSettingsOpen(true)}
        cwd={project?.path ?? null}
        onGitRefresh={refreshGitStatus}
      />
      {palette}
    </div>
  );
}
