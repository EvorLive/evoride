import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ProjectRail from "./components/ProjectRail";
import AgentsColumn from "./components/AgentsColumn";
import MobileWorkspace, { type MobileTab } from "./components/MobileWorkspace";
import MobileHome from "./components/MobileHome";
import MobileHomeShell, { type HomeTab } from "./components/MobileHomeShell";
import MobileAgents from "./components/MobileAgents";
import { useIsMobile } from "./lib/useIsMobile";
import ProjectHome from "./components/ProjectHome";
import JiraProjectPicker from "./components/JiraProjectPicker";
import RunControl from "./components/RunControl";
import PauseControl from "./components/PauseControl";
import NewAgentMenu from "./components/NewAgentMenu";
import StatusBar from "./components/StatusBar";
import HomeView from "./components/HomeView";
import HomeBar from "./components/HomeBar";
import SettingsDialog from "./components/SettingsDialog";
import RunSetupDialog from "./components/RunSetupDialog";
import CommandPalette, { type Command } from "./components/CommandPalette";
import AgentSwitcher, { type SwitcherItem } from "./components/AgentSwitcher";
import SuperProjectBar from "./components/SuperProjectBar";
import NotificationCenter from "./components/NotificationCenter";
import { loadAgents, saveAgents, enabledClis, type AgentConfig } from "./lib/agents";
import { autopilotCommand } from "./lib/clis";
import * as demo from "./lib/demo";
// Heavy / on-demand components are code-split (xterm, editor, diff, panels).
const GridWorkspace = lazy(() => import("./components/GridWorkspace"));
const AgentTerminal = lazy(() => import("./components/AgentTerminal"));
const Editor = lazy(() => import("./components/Editor"));
const DiffView = lazy(() => import("./components/DiffView"));
const FileExplorer = lazy(() => import("./components/FileExplorer"));
const GitPanel = lazy(() => import("./components/GitPanel"));
const TasksPanel = lazy(() => import("./components/TasksPanel"));
const EditsPanel = lazy(() => import("./components/EditsPanel"));
import { getCurrentWindow, isTauri, listen, openUrl } from "./lib/bridge";
import { midTruncate } from "./lib/util";
import { toastError } from "./lib/toast";
import * as api from "./lib/tauri";
import type {
  AgentRecord,
  ClaudeSession,
  ClaudeUsage,
  DetectedStack,
  FileEntry,
  GitStatus,
  PausedItem,
  Project,
  Service,
  Task,
} from "./lib/tauri";

function FolderIcon() {
  // VSCode codicon folder glyph (same icon font as the explorer).
  return <i className="codicon codicon-folder" aria-hidden="true" />;
}
import "./App.css";

const NEXT_STATUS = { todo: "doing", doing: "done", done: "verified", verified: "todo" } as const;

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
  // Agent ids whose terminal is currently popped out into its own window.
  const [poppedOut, setPoppedOut] = useState<Set<string>>(new Set());
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  // A second pane shown beside/below the active agent terminal (VS Code-style
  // split). `kind` "shell" = a throwaway terminal to run commands; "editor" =
  // the open files, so you can read a file next to the agent. `dir` picks side
  // by side (row) vs stacked (column). null = no split.
  const [split, setSplit] = useState<{
    dir: "row" | "column";
    kind: "shell" | "editor";
  } | null>(null);
  // The split shell's pty id (reused across shell/editor toggles), if spawned.
  const [splitAgentId, setSplitAgentId] = useState<string | null>(null);
  // Which pane is focused — drives the highlight and where new files land.
  const [activePane, setActivePane] = useState<"main" | "split">("main");
  // One right-side panel at a time (git/plan/files/edits), or none.
  type RightPanel = "git" | "plan" | "files" | "edits";
  const [rightPanel, setRightPanel] = useState<RightPanel | null>("git");
  // On a phone (daemon-served web IDE) the project/agent rails collapse into
  // off-canvas drawers; this tracks which one, if any, is open. No effect on
  // desktop, where the rails are always visible.
  const [mobileNav, setMobileNav] = useState<"none" | "projects" | "agents">("none");
  // Phone layout: which bottom-nav tab is showing. Defaults to the terminal so
  // you land on the active worker.
  const isMobile = useIsMobile();
  const [mobileTab, setMobileTab] = useState<MobileTab>("home");
  const [homeTab, setHomeTab] = useState<HomeTab>("home");
  // Center shows the agent terminal or the file editor (never side by side).
  const [centerMode, setCenterMode] = useState<"terminal" | "editor">("terminal");
  const [services, setServices] = useState<Service[]>([]);
  // service name → live agent id while that service is running.
  const [runningServices, setRunningServices] = useState<Record<string, string>>({});
  // Project ids that are currently PAUSED (everything suspended + retained).
  const [pausedProjects, setPausedProjects] = useState<Set<string>>(new Set());
  // While a pause is counting down: which project + seconds left (null = idle).
  const [pausing, setPausing] = useState<{ projectId: string; secondsLeft: number } | null>(null);
  const [home, setHome] = useState<string | null>(null);
  // Diff shown in the center (replacing the terminal); null = show terminal.
  const [diffView, setDiffView] = useState<{ file: string | null } | null>(null);
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [knownProjects, setKnownProjects] = useState<Project[]>([]);
  // Super-projects (named groups of repos) + which one scopes the Home overview.
  const [superProjects, setSuperProjects] = useState<api.SuperProject[]>([]);
  const [activeSuperId, setActiveSuperId] = useState<string | null>(null);
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
  // Remote control (evor.dev): true once Settings → Remote is fully configured.
  const [remoteOn, setRemoteOn] = useState(false);
  // Real app version (from the release tag → tauri.conf.json), shown in the bars.
  const [appVer, setAppVer] = useState("");
  useEffect(() => {
    api.appVersion().then(setAppVer).catch(() => {});
  }, []);
  const lastOutputRef = useRef<Record<string, number>>({});
  const judgedRef = useRef<Record<string, number>>({});
  // Signature of what we last published per waiting agent, so we only re-POST
  // to the dashboard when the question/options actually change.
  const pubSigRef = useRef<Record<string, string>>({});
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
  // Resolve "system" to an actual light/dark mode so the terminal can match it.
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const termMode: "light" | "dark" =
    theme === "system" ? (prefersDark ? "dark" : "light") : theme;
  // Match the NATIVE window chrome (macOS titlebar / traffic-light bar) to the
  // resolved mode, so it isn't a white bar in dark mode.
  useEffect(() => {
    getCurrentWindow().setTheme(termMode).catch(() => {});
  }, [termMode]);
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
  // Auto-continue agents after a usage/session limit resets. Mirrored into a ref
  // so the (register-once) listener reads the latest value without re-binding.
  const [autoContinueRL, setAutoContinueRL] = useState(true);
  const autoContinueRLRef = useRef(true);
  useEffect(() => {
    autoContinueRLRef.current = autoContinueRL;
  }, [autoContinueRL]);
  useEffect(() => {
    api.getSettings().then((s) => setAutoContinueRL(s.auto_continue_rate_limit)).catch(() => {});
  }, []);
  // Agents currently blocked on a limit: id → { message, resetAt(ms|null) } for
  // the tile badge. Pending auto-continue timers live in a ref (no re-render).
  const [rateLimited, setRateLimited] = useState<Record<string, { message: string; resetAt: number | null }>>({});
  const rlTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "agents" | "jira">("general");
  // AI dedupe gate: when creating a task that looks like a duplicate, hold the
  // pending creation here and ask the user (merge / create anyway / cancel).
  const [dup, setDup] = useState<
    { hit: api.DuplicateHit; title: string; projectId: string; create: () => void } | null
  >(null);
  const openSettings = (tab: "general" | "agents" | "jira" = "general") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };
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
  // Quick agent / window switcher (⌘E) — jump to any running agent.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // Which overlay the Workspace grid shows ("pull" / "new"), controlled here so
  // the command palette can open them too.
  const [gridMenu, setGridMenu] = useState<"pull" | "new" | null>(null);
  // All agents across projects (for the grid's "resume inactive" section).
  const [allAgentList, setAllAgentList] = useState<AgentRecord[]>([]);

  // Open file tabs for the right-side editor.
  const [openFiles, setOpenFiles] = useState<FileEntry[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  // VSCode-style preview: at most one "temporary" tab (shown italic). A single
  // click opens here and reuses this slot; double-click or editing pins it.
  const [previewFile, setPreviewFile] = useState<string | null>(null);

  const openFile = (e: FileEntry, opts?: { preview?: boolean }) => {
    const preview = opts?.preview ?? false;
    const alreadyOpen = openFiles.some((f) => f.path === e.path);
    // Already a permanent tab → just focus it (a preview click never demotes it).
    if (alreadyOpen && previewFile !== e.path) {
      setActiveFile(e.path);
      setCenterMode("editor");
      setDiffView(null);
      if (!preview) setPreviewFile((cur) => (cur === e.path ? null : cur));
      return;
    }
    setOpenFiles((prev) => {
      let next = prev;
      // Reuse the preview slot: drop the old temporary tab when opening a new one.
      if (preview && previewFile && previewFile !== e.path) {
        next = next.filter((f) => f.path !== previewFile);
      }
      if (!next.some((f) => f.path === e.path)) next = [...next, e];
      return next;
    });
    setPreviewFile((cur) => (preview ? e.path : cur === e.path ? null : cur));
    setActiveFile(e.path);
    setCenterMode("editor"); // file opens in the center (replaces terminal)
    setDiffView(null);
  };
  // Pin a tab so it's no longer temporary (double-click or first edit).
  const makeFilePermanent = (path: string) =>
    setPreviewFile((cur) => (cur === path ? null : cur));
  const closeFile = (path: string) => {
    setPreviewFile((cur) => (cur === path ? null : cur));
    setOpenFiles((prev) => {
      const next = prev.filter((f) => f.path !== path);
      setActiveFile((cur) =>
        cur === path ? (next[next.length - 1]?.path ?? null) : cur,
      );
      if (next.length === 0) {
        setCenterMode("terminal");
        // No files left → an editor split has nothing to show; collapse it.
        setSplit((s) => (s?.kind === "editor" ? null : s));
      }
      return next;
    });
  };

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

  const refreshSuperProjects = useCallback(() => {
    api.listSuperProjects().then(setSuperProjects).catch(() => {});
  }, []);
  useEffect(() => {
    if (!demoOn) refreshSuperProjects();
  }, [demoOn, refreshSuperProjects]);

  // Drop the group filter if its group disappears (e.g. deleted elsewhere).
  useEffect(() => {
    if (activeSuperId && !superProjects.some((s) => s.id === activeSuperId)) {
      setActiveSuperId(null);
    }
  }, [superProjects, activeSuperId]);

  // Create a group from the rail, seeded with the current project so it appears
  // under ACTIVE immediately. Optimistic insert avoids the stale-filter guard.
  const createGroupSeeded = useCallback((name: string) => {
    if (!name || !name.trim()) return;
    const seed = project?.id;
    api
      .createSuperProject(name.trim())
      .then(async (sp) => {
        if (seed) {
          await api.setSuperProjectMembers(sp.id, [seed]).catch(() => {});
          sp = { ...sp, project_ids: [seed] };
        }
        setSuperProjects((prev) => [...prev, sp]);
        setActiveSuperId(sp.id);
        refreshSuperProjects();
      })
      .catch(() => {});
  }, [project, refreshSuperProjects]);

  const setGroupMembers = useCallback(
    (id: string, ids: string[]) => {
      // Optimistic so the rail updates instantly, then reconcile.
      setSuperProjects((prev) =>
        prev.map((s) => (s.id === id ? { ...s, project_ids: ids } : s)),
      );
      api.setSuperProjectMembers(id, ids).then(refreshSuperProjects).catch(() => {});
    },
    [refreshSuperProjects],
  );

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
    setOpenFiles([]);
    setActiveFile(null);
    setSplit(null); // the split is project-scoped; drop it on switch
    setSplitAgentId(null);
    setActivePane("main");
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
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "p") {
        e.preventDefault();
        const fileable = view === "workspace" && !!project;
        setPaletteMode(e.shiftKey || !fileable ? "commands" : "files");
        setPaletteOpen(true);
      } else if (key === "e" && e.shiftKey) {
        // ⌘⇧E / Ctrl⇧E: quick switcher over every running agent (toggle).
        // Shift avoids the bare Ctrl+E readline binding (end-of-line) on Linux.
        e.preventDefault();
        setSwitcherOpen((o) => !o);
      }
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

  // ONE agent-list poll: all agents (grid's "resume inactive" list) and running
  // agents (multi-project rail) together, instead of two staggered timers
  // hitting the backend independently every 3-4s.
  useEffect(() => {
    let alive = true;
    const poll = () => {
      api.allAgents().then((a) => alive && setAllAgentList(a)).catch(() => {});
      if (!demoOn) {
        api.runningAgents().then((r) => alive && setRunningList(r)).catch(() => {});
      }
    };
    poll();
    const t = setInterval(() => !document.hidden && poll(), 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agents, demoOn]);

  // Git state: instant refresh when the FS watcher reports working-tree changes
  // (agent edits, external tools), plus a slow fallback poll for what the
  // watcher can't see (.git-only changes like a CLI commit — .git is filtered
  // out of the watch). `fsTick` also re-runs GitPanel's changes fetch.
  const [fsTick, setFsTick] = useState(0);
  useEffect(() => {
    if (!project) return;
    let un: (() => void) | undefined;
    api
      .onFsChanged((root) => {
        if (root === project.path) setFsTick((n) => n + 1);
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, [project]);

  useEffect(() => {
    if (!project) {
      setGit(null);
      return;
    }
    let alive = true;
    const poll = () =>
      api.gitStatus(project.path).then((g) => alive && setGit(g)).catch(() => {});
    poll();
    const t = setInterval(() => !document.hidden && poll(), 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [project, fsTick]);

  // Keep a sensible active agent: hold the current one while it still exists,
  // otherwise fall back to the project overview/home (null) rather than auto-
  // jumping into a running agent — the overview is the project's landing page.
  useEffect(() => {
    setActiveAgentId((prev) => (prev && agents.some((a) => a.id === prev) ? prev : null));
  }, [agents]);

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

  // Restore which projects are paused (so the header shows Resume after restart).
  useEffect(() => {
    api.pausedProjects().then((ids) => setPausedProjects(new Set(ids))).catch(() => {});
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
    await api.resumeAgent(id).catch((e) => toastError("Couldn't resume agent", e));
    addLive(id);
    if (!alreadyTiled) {
      setActiveTiles((prev) => (prev.length >= MAX_TILES ? prev : [...prev, id]));
    }
  };
  // Workspace management: add, switch, close, rename.
  const addWorkspace = () => {
    const n = workspaces.length + 1;
    const name = window.prompt("Name this workspace", `Workspace ${n}`)?.trim();
    if (name === undefined) return; // cancelled
    const id = `ws-${Date.now()}`;
    setWorkspaces((prev) => [...prev, { id, name: name || `Workspace ${n}`, tiles: [] }]);
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

  // Opening a NEW project (registering an arbitrary host path) is desktop-only:
  // on the daemon-served client it would widen the path-confinement boundary, and
  // the server rejects `add_project` outright (see evor-daemon REMOTE_DENIED). So
  // refuse it here too rather than show a prompt that will fail.
  const openFolder = async () => {
    setMenuOpen(false);
    if (!isTauri()) return;
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
  // Spawn a fresh agent in a specific project (from the cross-project Agents view)
  // and jump straight into its terminal.
  const newAgentInProject = async (p: Project, label: string, command: string) => {
    setProject(p);
    setView("workspace");
    setMobileTab("terminal");
    try {
      const rec = await api.spawnAgent({ projectId: p.id, title: label, command: command || undefined });
      addLive(rec.id);
      setActiveAgentId(rec.id);
    } catch {
      /* spawn failed (e.g. bad CLI) — stay in the project so the user can retry */
    }
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
          openSettings();
          break;
      }
    }).then((u) => {
      un = u;
    });
    return () => un?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track popped-out terminals (so the IDE shows a placeholder + can re-attach).
  useEffect(() => {
    api.poppedOut().then((ids) => setPoppedOut(new Set(ids))).catch(() => {});
    let un: (() => void) | undefined;
    api
      .onPopoutChanged((id, open) =>
        setPoppedOut((prev) => {
          const n = new Set(prev);
          if (open) n.add(id);
          else n.delete(id);
          return n;
        }),
      )
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, []);
  const popOut = (id: string) => void api.popOutTerminal(id, agentsById[id]?.title);
  // Cross-project tasks (the Tasks / planning page).
  const [allTasksList, setAllTasksList] = useState<Task[]>([]);
  const refreshAllTasks = useCallback(() => {
    api.allTasks().then(setAllTasksList).catch(() => {});
  }, []);
  useEffect(() => {
    if (view === "home") refreshAllTasks();
  }, [view, refreshAllTasks]);
  // AI dedupe gate: before creating, ask the helper if this duplicates an
  // existing task; if so, prompt (merge / create anyway / cancel). `create` is
  // the real creation closure, run only when the user proceeds.
  const guardedAdd = (title: string, projectId: string, create: () => void) => {
    api
      .checkDuplicateTask(title, projectId)
      .then((hit) => {
        if (hit) setDup({ hit, title, projectId, create });
        else create();
      })
      .catch(() => create()); // never block creation on a helper hiccup
  };
  const addTaskGlobal = (title: string, projectId: string, plannedFor: string) =>
    guardedAdd(title, projectId, () =>
      void api
        .addTask(projectId, title, undefined, plannedFor)
        .then(refreshAllTasks)
        .catch((e) => toastError("Couldn't create the task", e)),
    );
  // A Jira-linked task syncs its status back to the issue, so confirm first —
  // "this is a Jira task, should I update Jira too?". Non-Jira tasks pass through.
  const jiraCycleOk = (t: Task) =>
    t.source !== "jira" ||
    window.confirm(
      `“${t.title}” is linked to Jira${t.external_id ? ` (${t.external_id})` : ""}. ` +
        `Updating it to “${NEXT_STATUS[t.status]}” will also update the Jira issue. Continue?`,
    );
  const cycleTaskGlobal = (t: Task) => {
    if (!jiraCycleOk(t)) return;
    api
      .updateTask(t.id, NEXT_STATUS[t.status])
      .then(refreshAllTasks)
      .catch((e) => toastError("Couldn't update the task", e));
  };
  const assignTaskGlobal = (id: string, projectId: string) =>
    api
      .assignTask(id, projectId)
      .then(refreshAllTasks)
      .catch((e) => toastError("Couldn't move the task", e));
  const delTaskGlobal = (id: string) =>
    api
      .deleteTask(id)
      .then(refreshAllTasks)
      .catch((e) => toastError("Couldn't delete the task", e));
  /// Freeform note → AI helper extracts tasks + matches projects. Resolves to the
  /// created tasks (or throws with a message TasksView surfaces inline).
  const planTasksGlobal = async (note: string) => {
    const created = await api.planTasks(note);
    refreshAllTasks();
    return created;
  };
  const renameAgent = (id: string, title: string) => {
    api.setAgentTitle(id, title).catch(() => {});
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, title } : a)));
    setRunningList((prev) => prev.map((a) => (a.id === id ? { ...a, title } : a)));
  };
  // Live terminal title (OSC) → reflect immediately everywhere the title shows
  // (toolbar, agents list). Normalized + capped; skips no-op updates.
  const autoTitleAgent = (id: string, raw: string) => {
    const title = raw.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!title) return;
    const cur = agents.find((a) => a.id === id)?.title;
    if (cur === title) return;
    renameAgent(id, title);
  };

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

  // OS window title like "Evor - ~/sajilobima/".
  useEffect(() => {
    let loc = project?.path ?? "";
    if (home && loc.startsWith(home)) loc = `~${loc.slice(home.length)}`;
    if (loc && !loc.endsWith("/")) loc += "/";
    const title = project ? `Evor - ${loc}` : "Evor";
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
    let rec: AgentRecord;
    try {
      rec = await api.spawnAgent({ projectId: project.id, ...args });
    } catch (e) {
      // A click that silently does nothing reads as "the app is broken".
      toastError(`Couldn't start "${args.title}"`, e);
      return null;
    }
    addLive(rec.id);
    setAgents((prev) => [rec, ...prev.filter((a) => a.id !== rec.id)]);
    setActiveAgentId(rec.id);
    return rec;
  };

  const newAgent = (title: string, command: string) =>
    void launch({ title, command: command || undefined });

  // Spawn an agent and, once it's up, hand it an initial prompt (bracketed paste
  // preserves newlines). Shared by "Work on this task" / "Brainstorm".
  const startAgentWithPrompt = async (title: string, command: string, prompt: string) => {
    const rec = await launch({ title, command });
    if (!rec) return null;
    window.setTimeout(() => {
      api
        .writeInput(rec.id, `\x1b[200~${prompt}\x1b[201~`)
        .then(() => api.writeInput(rec.id, "\r"))
        .catch(() => {});
    }, 1500);
    return rec;
  };
  // Hand a task to an agent to implement; link it so the agent's reported status
  // flows back, and mark it in-progress.
  const workOnTask = async (t: Task, command: string) => {
    const prompt = `Please work on this task:\n\n${t.title}${t.description ? `\n\n${t.description}` : ""}${
      t.steps && t.steps.length ? `\n\nSteps:\n${t.steps.map((s, i) => `${i + 1}. ${s.title}`).join("\n")}` : ""
    }\n\nStart by finding the relevant code, sketch a brief plan, then implement it. Update your task status via $EVORIDE_TASKS as you go. Ask me if anything is ambiguous.`;
    const rec = await startAgentWithPrompt(`▶ ${t.title}`, command, prompt);
    if (rec) api.linkTaskAgent(t.id, rec.id).catch(() => {});
    if (t.status === "todo") cycleTask(t);
  };
  // Hand a task to an agent to think through — no code changes yet.
  const brainstormTask = async (t: Task, command: string) => {
    const prompt = `Let's brainstorm this task before changing any code:\n\n${t.title}${t.description ? `\n\n${t.description}` : ""}\n\nPropose 2–3 approaches with trade-offs, ask any clarifying questions, and recommend one. Don't edit files yet.`;
    const rec = await startAgentWithPrompt(`💡 ${t.title}`, command, prompt);
    if (rec) api.linkTaskAgent(t.id, rec.id).catch(() => {});
  };
  // Return to the project's overview/home page (deselect the focused agent — it
  // keeps running in the Agents column).
  const goProjectHome = () => {
    setActiveAgentId(null);
    setDiffView(null);
    setCenterMode("terminal");
  };
  // Work/brainstorm a task from anywhere (e.g. the Home page): open the task's
  // project, then once its tasks load, hand it to the agent. Unassigned → no-op.
  const pendingWorkRef = useRef<{ taskId: string; command: string; brainstorm: boolean } | null>(null);
  const workTaskAnywhere = (t: Task, command: string, brainstorm: boolean) => {
    const p = knownProjects.find((kp) => kp.id === t.project_id);
    if (!p) return;
    pendingWorkRef.current = { taskId: t.id, command, brainstorm };
    setProject(p);
    setView("workspace");
  };
  useEffect(() => {
    const pend = pendingWorkRef.current;
    if (!pend || !project) return;
    const t = tasks.find((x) => x.id === pend.taskId);
    if (!t || t.project_id !== project.id) return; // wait for this project's tasks
    pendingWorkRef.current = null;
    if (pend.brainstorm) void brainstormTask(t, pend.command);
    else void workOnTask(t, pend.command);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, tasks]);
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
    } catch (e) {
      removeLive(id);
      toastError("Couldn't resume agent", e);
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
  // Each service maps to a single, persistent terminal (the agent whose title is
  // the service name). Derived from the agent list so it survives stop/restart and
  // app reloads — restarting a service REUSES its terminal (keeps the logs), and
  // its console stays viewable even after it stops.
  const serviceAgentId = useCallback(
    (name: string) => agents.find((a) => a.title === name)?.id,
    [agents],
  );
  const startService = async (s: Service) => {
    const existing = serviceAgentId(s.name);
    if (existing) {
      // Reuse the same terminal (same cwd + command, scrollback preserved).
      await resumeExisting(existing);
      setRunningServices((prev) => ({ ...prev, [s.name]: existing }));
      return;
    }
    // Untrusted command (not a recognized dev tool — may be repo- or AI-supplied):
    // show exactly what would run and require explicit confirmation first.
    if (!s.trusted) {
      const ok = await api.confirmRun(
        `Evor wants to run “${s.name}”:\n\n${s.command}\n\nin ${
          s.cwd || "the project root"
        }\n\nThis isn't a recognized dev-tool command, so it could come from the repository or an AI-generated config. Run it?`,
      );
      if (!ok) return;
    }
    const rec = await launch({
      title: s.name,
      command: s.command || undefined,
      subdir: s.cwd || undefined,
    });
    if (rec) setRunningServices((prev) => ({ ...prev, [s.name]: rec.id }));
  };
  const stopService = (s: Service) => {
    const id = runningServices[s.name] ?? serviceAgentId(s.name);
    if (id) void closeAgent(id); // kills the pty but KEEPS the tile + logs
    setRunningServices((prev) => {
      const n = { ...prev };
      delete n[s.name];
      return n;
    });
  };
  // Bring a service's terminal forward to read its console/logs (running or not).
  const viewService = (s: Service) => {
    const id = serviceAgentId(s.name);
    if (id) {
      setDiffView(null);
      setActiveAgentId(id);
    }
  };
  const refreshRunConfig = async () => {
    if (!project) return;
    const svcs = await api.createRunConfig(project.path).catch(() => null);
    if (svcs) setServices(svcs);
  };

  // --- pause / resume the whole project ---
  // Graceful shutdown → startup for everything running in a project. Pause tells
  // each live AI agent to save its progress, counts down 10s, then interrupts it
  // (Ctrl+C) and suspends it; services are torn down (their `down` command, e.g.
  // `docker compose down`) and stopped. A manifest records what was suspended so
  // Resume restores it — agents continue in place (Claude `--continue`) with a
  // "continue now" signal, and services re-run their `up` command.
  const PAUSE_GRACE = 10;
  const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
  // A live agent is a "service" iff its title matches a configured service name.
  const serviceByTitle = useCallback(
    (title: string) => services.find((s) => s.name === title),
    [services],
  );
  const pauseProject = async () => {
    if (!project || pausing) return;
    const pid = project.id;
    const liveAgents = agents.filter((a) => live.has(a.id));
    if (liveAgents.length === 0) return;
    const aiAgents = liveAgents.filter((a) => !serviceByTitle(a.title));

    // 1. Ask the AI agents to wrap up safely (bracketed paste preserves newlines).
    const graceMsg =
      "⏸ Pausing this project in 10 seconds. Please wrap up safely now: stop any risky action, " +
      "save your progress, and jot a quick note of where you are and what's left. I'll send you a " +
      "signal to continue shortly — you'll be interrupted (Ctrl+C) in 10s, so don't start anything new.";
    for (const a of aiAgents) {
      api
        .writeInput(a.id, `\x1b[200~${graceMsg}\x1b[201~`)
        .then(() => api.writeInput(a.id, "\r"))
        .catch(() => {});
    }

    // 2. Visible 10s countdown.
    for (let s = PAUSE_GRACE; s > 0; s--) {
      setPausing({ projectId: pid, secondsLeft: s });
      await wait(1000);
    }

    // Map an agent's absolute cwd to a project-relative subdir (or undefined for
    // the project root / anything outside it) for confined teardown commands.
    const relCwd = (abs: string): string | undefined => {
      if (!abs || abs === project.path) return undefined;
      return abs.startsWith(`${project.path}/`) ? abs.slice(project.path.length + 1) : undefined;
    };

    // 3. Suspend everything, recording it in the manifest.
    const items: PausedItem[] = [];
    for (const a of liveAgents) {
      const svc = serviceByTitle(a.title);
      // Collect teardown commands: the configured service `down`, plus any stack
      // actually running UNDER this terminal (compose/tilt a user or agent
      // started by typing into the shell). Deduped by command.
      const downs = new Map<string, string | undefined>(); // down command → subdir
      if (svc?.down) downs.set(svc.down, svc.cwd || undefined);
      const detected = await api.detectRunningStacks(a.id).catch(() => [] as DetectedStack[]);
      for (const st of detected) if (!downs.has(st.down)) downs.set(st.down, relCwd(a.cwd));
      for (const [cmd, sub] of downs) await api.runCommandOnce(pid, cmd, sub).catch(() => {});

      const isService = !!svc;
      if (!isService) {
        // AI / shell: interrupt the current turn before suspending. The record
        // is kept so Resume can `--continue`.
        await api.writeInput(a.id, "\x03").catch(() => {});
        await wait(300);
      }
      await api.pauseAgent(a.id).catch(() => {});
      items.push({
        id: a.id,
        title: a.title,
        command: a.command,
        cwd: a.cwd,
        kind: isService ? "service" : "ai",
        down: downs.size ? [...downs.keys()].join(" && ") : undefined,
      });
      removeLive(a.id);
    }

    await api
      .savePauseManifest(pid, { paused_at: Date.now(), items })
      .catch(() => {});
    setRunningServices({});
    setPausedProjects((prev) => new Set(prev).add(pid));
    setPausing(null);
    setActiveAgentId(null);
    refreshAgents(pid);
  };
  const resumeProject = async () => {
    if (!project) return;
    const pid = project.id;
    const manifest = await api.readPauseManifest(pid).catch(() => null);
    // Clear the paused state first so the button flips even if a restore step
    // fails (the user can re-run individual agents/services from their rows).
    setPausedProjects((prev) => {
      const n = new Set(prev);
      n.delete(pid);
      return n;
    });
    await api.clearPauseManifest(pid).catch(() => {});
    if (!manifest || !manifest.items.length) return;
    for (const it of manifest.items) {
      // Resume in place: Claude gets `--continue`, a service re-runs its command.
      await api.resumeAgent(it.id).catch(() => {});
      addLive(it.id);
      setAgents((prev) => prev.map((a) => (a.id === it.id ? { ...a, status: "running" } : a)));
      if (it.kind === "service") {
        setRunningServices((p) => ({ ...p, [it.title]: it.id }));
      } else {
        // Give the resumed session a moment to come up, then tell it to continue.
        window.setTimeout(() => {
          api
            .writeInput(it.id, "\x1b[200~Continue now — the project is resumed. Pick up exactly where you left off.\x1b[201~")
            .then(() => api.writeInput(it.id, "\r"))
            .catch(() => {});
        }, 1800);
      }
    }
    refreshAgents(pid);
  };

  // --- split pane ---
  // Spawn (or reuse) the throwaway shell that backs a "shell" split.
  const ensureSplitShell = async (): Promise<string | null> => {
    if (splitAgentId && live.has(splitAgentId)) return splitAgentId;
    if (!project) return null;
    const primary = activeAgentId;
    const rec = await api.spawnAgent({ projectId: project.id, title: "Terminal" });
    addLive(rec.id);
    setAgents((prev) => [rec, ...prev.filter((a) => a.id !== rec.id)]);
    setSplitAgentId(rec.id);
    // Keep the agent as the primary pane — the shell is the secondary one.
    if (primary) setActiveAgentId(primary);
    return rec.id;
  };
  // Open a plain shell beside the active agent (run commands while watching it).
  const openSplitTerminal = async () => {
    await ensureSplitShell();
    setSplit((s) => ({ dir: s?.dir ?? "row", kind: "shell" }));
    setActivePane("split");
  };
  // Show the open files in the split pane (a file next to the agent terminal).
  const openSplitEditor = () => {
    setSplit((s) => ({ dir: s?.dir ?? "row", kind: "editor" }));
    setActivePane("split");
  };
  // Switch what the split pane shows without tearing it down.
  const setSplitKind = async (kind: "shell" | "editor") => {
    if (kind === "shell") await ensureSplitShell();
    setSplit((s) => (s ? { ...s, kind } : { dir: "row", kind }));
  };
  // Flip side-by-side ⇄ stacked.
  const toggleSplitDir = () =>
    setSplit((s) => (s ? { ...s, dir: s.dir === "row" ? "column" : "row" } : s));
  // Close the split and kill its throwaway shell (if one was spawned).
  const closeSplit = () => {
    const id = splitAgentId;
    setSplit(null);
    setActivePane("main");
    if (id) {
      setSplitAgentId(null);
      void closeAgent(id);
    }
  };
  const [runSetupOpen, setRunSetupOpen] = useState(false);
  // "Set up / regenerate run with AI": spawn the CHOSEN agent, hand it the
  // instruction (+ any extra prompt) to write ~/.evoride/{id}/runinfo.json —
  // multi-service for a monorepo — then poll, load, and run it. The agent stays
  // a live chat session you can keep directing.
  const runGenerate = async (command: string, extra: string) => {
    if (!project) return;
    const pid = project.id;
    const base = await api.runSetupPrompt(pid).catch(() => null);
    if (!base) return;
    // Keep it one prompt: flatten the user's extra to a single appended line.
    const prompt = extra ? `${base} Also: ${extra.replace(/\s+/g, " ").trim()}` : base;
    const label = enabledAgentClis.find((c) => c.command === command)?.label ?? "agent";
    const before = JSON.stringify(services); // so we only react to the NEW config
    // Autopilot: run the agent fully autonomously so it configures (and can run)
    // everything without the user accepting each step — they just watch.
    const rec = await launch({ title: `Set up run · ${label}`, command: autopilotCommand(command) });
    if (!rec) return;
    // Give the agent a moment to come up, then send the (single-line) instruction.
    window.setTimeout(() => void api.writeInput(rec.id, `${prompt}\r`), 1800);
    // Watch for the generated config; once it lands (differs from before), load +
    // auto-run it — "run after you complete it".
    let tries = 0;
    const iv = window.setInterval(async () => {
      tries += 1;
      const svcs = await api.runConfig(pid, project.path).catch(() => [] as typeof services);
      const landed = svcs.some((s) => s.command.trim()) && JSON.stringify(svcs) !== before;
      if (landed) {
        window.clearInterval(iv);
        setServices(svcs);
        // Auto-run ONLY recognized dev-tool commands. A repo- or AI-generated
        // config could name an arbitrary program, so anything untrusted is left
        // for the user to start via the Run button (which confirms first) — the
        // guard against prompt-injection → silent command execution.
        svcs
          .filter((s) => s.command.trim() && s.trusted)
          .forEach((s) => void startService(s));
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
    // Drop it from the running poll right away so project/agent dots agree.
    setRunningList((prev) => prev.filter((a) => a.id !== id));
    // Don't strand the user on a stopped window saying "isn't running" — move
    // focus to another live agent (or clear it if none are left).
    if (activeAgentId === id) {
      const next = agents.find((a) => a.id !== id && live.has(a.id));
      setActiveAgentId(next ? next.id : null);
    }
    if (project) refreshAgents(project.id);
  };

  const archiveAgentH = async (id: string) => {
    await api.archiveAgent(id).catch(() => {});
    removeLive(id);
    clearWaiting(id); // archived agents must not keep a "waiting for you" flag
    if (activeAgentId === id) setActiveAgentId(null);
    if (project) refreshAgents(project.id);
  };
  const deleteAgentH = async (id: string) => {
    await api.deleteAgent(id).catch(() => {});
    removeLive(id);
    clearWaiting(id);
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
      // A split shell that exits (e.g. the user typed `exit`) collapses a shell
      // split; an editor split is unaffected (it has no pty).
      setSplitAgentId((cur) => {
        if (cur !== id) return cur;
        setSplit((s) => (s?.kind === "shell" ? null : s));
        return null;
      });
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
      }
    },
    [project, refreshAgents],
  );

  // Hook that runs right before a commit (currently a no-op).
  const beforeCommit = useCallback(async () => {}, []);

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

  // (Running agents are polled together with the all-agents list above.)

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

  // Global "agent hit a usage/session limit" listener. When the setting is on
  // and we can pin down the reset moment, schedule a one-shot "continue" so the
  // task resumes unattended the instant the limit lifts (+ a small buffer).
  useEffect(() => {
    let un: (() => void) | undefined;
    const clearTimer = (id: string) => {
      const t = rlTimersRef.current[id];
      if (t) {
        clearTimeout(t);
        delete rlTimersRef.current[id];
      }
    };
    api
      .onAgentRateLimited((rl) => {
        if (!rl.limited) {
          clearTimer(rl.id);
          setRateLimited((p) => {
            if (!(rl.id in p)) return p;
            const { [rl.id]: _drop, ...rest } = p;
            return rest;
          });
          return;
        }
        const resetAt = api.resetAtMs(rl);
        setRateLimited((p) => ({ ...p, [rl.id]: { message: rl.message, resetAt } }));
        clearTimer(rl.id); // re-arm fresh on any new detail
        // Only auto-continue when enabled AND we resolved a concrete reset time —
        // never type into an agent on a guess.
        if (!autoContinueRLRef.current || resetAt === null) return;
        const delay = Math.max(0, resetAt - Date.now()) + 20_000; // 20s buffer past reset
        rlTimersRef.current[rl.id] = setTimeout(() => {
          delete rlTimersRef.current[rl.id];
          void api.writeInput(rl.id, "continue\r").catch(() => {});
        }, delay);
      })
      .then((u) => {
        un = u;
      });
    return () => {
      un?.();
      for (const id of Object.keys(rlTimersRef.current)) {
        clearTimeout(rlTimersRef.current[id]);
        delete rlTimersRef.current[id];
      }
    };
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
    guardedAdd(title, project.id, () =>
      void api
        .addTask(project.id, title)
        .then((t) => setTasks((p) => [...p, t]))
        .catch((e) => toastError("Couldn't create the task", e)),
    );
  };
  const cycleTask = (t: Task) => {
    if (!jiraCycleOk(t)) return;
    const next = NEXT_STATUS[t.status];
    api
      .updateTask(t.id, next)
      .then(() =>
        setTasks((p) => p.map((x) => (x.id === t.id ? { ...x, status: next } : x))),
      )
      .catch((e) => toastError("Couldn't update the task", e));
  };
  const delTask = (id: string) =>
    api
      .deleteTask(id)
      .then(() => setTasks((p) => p.filter((x) => x.id !== id)))
      .catch((e) => toastError("Couldn't delete the task", e));
  // Replace a task in local state (after a backend mutation returns the new row).
  const patchTask = (t: Task | null) => {
    if (!t) return;
    setTasks((p) => p.map((x) => (x.id === t.id ? t : x)));
    setAllTasksList((p) => p.map((x) => (x.id === t.id ? t : x)));
  };
  // Push a local task up to Jira. Pick the board: the project's mapping if there's
  // exactly one, otherwise prompt with a picker (just-do-it when unambiguous).
  const [jiraPush, setJiraPush] = useState<{ task: Task; projects: api.JiraProject[] } | null>(null);
  const createJiraIssue = (id: string, projectKey?: string) =>
    api
      .jiraCreateFromTask(id, projectKey)
      .then(patchTask)
      .catch((e) =>
        window.alert(typeof e === "string" ? e : (e as Error)?.message || "Couldn't create the Jira issue."),
      );
  const pushTaskToJira = async (t: Task) => {
    const [cfg, projects] = await Promise.all([
      api.jiraConfigGet().catch(() => null),
      api.jiraProjects().catch(() => [] as api.JiraProject[]),
    ]);
    if (!cfg) {
      window.alert("Connect Jira first (Settings → Jira).");
      return;
    }
    const mappedKeys = Object.entries(cfg.project_map)
      .filter(([, pid]) => pid === t.project_id)
      .map(([k]) => k);
    const candidates = mappedKeys.length
      ? projects.filter((p) => mappedKeys.includes(p.key))
      : projects;
    if (candidates.length === 1) {
      void createJiraIssue(t.id, candidates[0].key); // unambiguous → just do it
    } else if (candidates.length === 0) {
      window.alert("No Jira projects available to file into.");
    } else {
      setJiraPush({ task: t, projects: candidates }); // multiple → let the user pick
    }
  };
  const jiraPicker = (
    <JiraProjectPicker
      open={!!jiraPush}
      taskTitle={jiraPush?.task.title ?? ""}
      projects={jiraPush?.projects ?? []}
      onClose={() => setJiraPush(null)}
      onPick={(key) => {
        if (jiraPush) void createJiraIssue(jiraPush.task.id, key);
        setJiraPush(null);
      }}
    />
  );
  const setTaskDesc = (id: string, description: string) => {
    api
      .setTaskDescription(id, description)
      .then(() => {
        setTasks((p) => p.map((x) => (x.id === id ? { ...x, description } : x)));
        setAllTasksList((p) => p.map((x) => (x.id === id ? { ...x, description } : x)));
      })
      .catch((e) => toastError("Couldn't save the description", e));
  };
  const breakdownTaskH = (id: string) => api.breakdownTask(id).then(patchTask);
  const toggleStepH = (taskId: string, stepId: string, status: "todo" | "doing" | "done") =>
    void api.updateStep(taskId, stepId, status).then(patchTask);

  // Upsert tasks returned by an ingest poll: replace existing rows, prepend ones
  // the agent just created so they appear on the board immediately.
  const upsertTasks = useCallback((rows: Task[]) => {
    if (!rows.length) return;
    const merge = (list: Task[]) => {
      const byId = new Map(list.map((t) => [t.id, t]));
      const fresh: Task[] = [];
      for (const r of rows) {
        if (byId.has(r.id)) byId.set(r.id, r);
        else fresh.push(r);
      }
      return [...fresh, ...Array.from(byId.values())];
    };
    setTasks((p) => merge(p));
    setAllTasksList((p) => merge(p));
  }, []);

  // Pull agents' self-reported task activity (via $EVORIDE_TASKS) and fold it
  // back onto the board: status/step progress on linked tasks, AND tasks the
  // agent auto-creates when it starts new work. Poll every live agent in the
  // project (not just already-linked ones) so brand-new tasks get picked up.
  useEffect(() => {
    if (!project) return;
    const path = project.path;
    const iv = setInterval(() => {
      if (document.hidden) return;
      for (const a of agents) {
        if (live.has(a.id)) api.ingestAgentTasks(path, a.id).then(upsertTasks).catch(() => {});
      }
    }, 4000);
    return () => clearInterval(iv);
  }, [project, agents, live, upsertTasks]);

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
  // The split pane only renders alongside a live agent terminal in the main pane,
  // and only when it has something to show (a live shell, or open files).
  const splitHasContent =
    split?.kind === "editor"
      ? openFiles.length > 0
      : !!splitAgentId && splitAgentId !== activeAgentId && live.has(splitAgentId);
  const showSplit = !!split && activeIsLive && !!activeAgentId && splitHasContent;
  // When the editor lives in the split, the main pane keeps the agent terminal.
  const editorInSplit = showSplit && split?.kind === "editor";

  // Agents currently live in THIS project — surfaced on the landing page so you
  // can see/jump to what's working without opening the rail.
  const projectAgentsWorking = useMemo(
    () =>
      agents
        .filter((a) => live.has(a.id))
        .map((a) => ({
          id: a.id,
          title: a.title,
          waiting: waitingAgents.has(a.id),
          options: waitingOptions[a.id] ?? [],
          question: waitingQuestion[a.id],
          textMode: waitingTextMode[a.id] ?? false,
        })),
    [agents, live, waitingAgents, waitingOptions, waitingQuestion, waitingTextMode],
  );

  const runningServiceMap = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const [name, id] of Object.entries(runningServices)) m[name] = live.has(id);
    return m;
  }, [runningServices, live]);

  // Which services have a terminal to inspect (running OR stopped-with-logs).
  const viewableServiceMap = useMemo(() => {
    const titles = new Set(agents.map((a) => a.title));
    const m: Record<string, boolean> = {};
    for (const s of services) m[s.name] = titles.has(s.name);
    return m;
  }, [agents, services]);

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
  // Union the backend poll (`runningList`, all projects, ~3s lag) with the live
  // set (immediate, this window) so a project's dot turns green the instant an
  // agent does — matching the agent dot, not trailing it. Dedup by agent id.
  const runningByProject = useMemo(() => {
    const m: Record<string, number> = {};
    const counted = new Set<string>();
    const bump = (pid?: string, id?: string) => {
      if (!pid || !id || counted.has(id)) return;
      counted.add(id);
      m[pid] = (m[pid] ?? 0) + 1;
    };
    for (const a of runningList) bump(a.project_id, a.id);
    for (const a of agents) if (live.has(a.id)) bump(a.project_id, a.id);
    return m;
  }, [runningList, agents, live]);
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

  // Last time each project was worked on (unix seconds) — a running agent counts
  // as "now", otherwise the newest agent's start time. Drives the rail age badge
  // and its newest-first ordering.
  const lastActivityByProject = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const m: Record<string, number> = {};
    const bump = (pid: string, t: number) => {
      if (t > (m[pid] ?? 0)) m[pid] = t;
    };
    for (const a of allAgentList) {
      bump(a.project_id, a.status === "running" ? nowSec : a.created_at);
    }
    for (const a of runningList) bump(a.project_id, nowSec);
    return m;
  }, [allAgentList, runningList]);

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

  // Flat list of running agents across every project, for the ⌘E quick switcher.
  // Union the backend poll (all projects, ~3s lag) with this window's live set so
  // a just-started agent shows up immediately. needs-you first, then live, then
  // most-recently-started.
  const switchableAgents = useMemo<SwitcherItem[]>(() => {
    const byId = new Map<string, AgentRecord>();
    for (const a of runningList) byId.set(a.id, a);
    for (const a of agents) if (live.has(a.id)) byId.set(a.id, a);
    const items: SwitcherItem[] = [];
    for (const a of byId.values()) {
      items.push({
        agent: a,
        projectName: projectsById[a.project_id]?.name ?? a.project_id,
        live: live.has(a.id),
        waiting: waitingAgents.has(a.id),
      });
    }
    const rank = (it: SwitcherItem) => (it.waiting ? 0 : it.live ? 1 : 2);
    items.sort(
      (x, y) => rank(x) - rank(y) || y.agent.created_at - x.agent.created_at,
    );
    return items;
  }, [runningList, agents, live, waitingAgents, projectsById]);

  // Is remote control configured? Re-checked on mount and after Settings change.
  const refreshRemote = useCallback(() => {
    api.remoteStatus().then((s) => setRemoteOn(s.configured)).catch(() => {});
  }, []);
  useEffect(() => {
    refreshRemote();
  }, [refreshRemote]);

  // Publish waiting prompts to the hosted dashboard so they can be answered
  // remotely, and resolve them when the agent stops waiting locally. Best-effort
  // and content-gated (only re-POST when the prompt changes). No-op when off.
  useEffect(() => {
    if (!remoteOn) return;
    for (const id of waitingAgents) {
      const rec = agentsById[id];
      const project = rec ? (projectsById[rec.project_id]?.name ?? "") : "";
      const title = rec?.title ?? "Agent";
      const question = waitingQuestion[id] ?? "";
      const options = waitingOptions[id] ?? [];
      const textMode = !!waitingTextMode[id];
      const sig = JSON.stringify([project, title, question, options, textMode]);
      if (pubSigRef.current[id] === sig) continue;
      pubSigRef.current[id] = sig;
      void api
        .remoteNotify({ agentId: id, project, title, question, options, textMode, kind: "waiting" })
        .catch(() => {});
    }
    // Anything we previously published that's no longer waiting → resolve it.
    for (const id of Object.keys(pubSigRef.current)) {
      if (!waitingAgents.has(id)) {
        delete pubSigRef.current[id];
        void api.remoteResolve(id).catch(() => {});
      }
    }
  }, [remoteOn, waitingAgents, waitingQuestion, waitingOptions, waitingTextMode, agentsById, projectsById]);

  // A reply made from the dashboard was applied to a local agent's pty by the
  // backend poller → clear its "needs you" flag here too.
  useEffect(() => {
    let un: (() => void) | undefined;
    api.onRemoteReply((id) => clearWaiting(id)).then((u) => {
      un = u;
    });
    return () => un?.();
  }, []);

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
      if (activeAgentId)
        cmds.push({
          id: "popout",
          label: "Pop out current terminal",
          hint: "Window",
          run: () => void api.popOutTerminal(activeAgentId, agentsById[activeAgentId]?.title),
        });
      cmds.push({ id: "new-claude", label: "New Claude session", hint: "Agent", run: () => newAgent("Claude", "claude") });
      cmds.push({ id: "new-shell", label: "New shell", hint: "Agent", run: () => newAgent("shell", "") });
      cmds.push({ id: "new-codex", label: "New Codex", hint: "Agent", run: () => newAgent("Codex", "codex") });
    }

    // Project + window. Opening a project is desktop-only (the daemon rejects it).
    if (isTauri())
      cmds.push({ id: "open-project", label: "Open project…", hint: "Project", run: () => void openFolder() });
    cmds.push({ id: "new-window", label: "New window", hint: "Window", run: () => api.openWindow() });
    if (switchableAgents.length > 0)
      cmds.push({ id: "switch-agent", label: "Switch agent…", hint: "⌘⇧E", run: () => setSwitcherOpen(true) });

    // Right-side panels — only exist on the project workspace page.
    if (view === "workspace" && project) {
      cmds.push({ id: "panel-git", label: "Toggle Git panel", hint: "Panel", run: () => setRightPanel((p) => (p === "git" ? null : "git")) });
      cmds.push({ id: "panel-files", label: "Toggle Files panel", hint: "Panel", run: () => setRightPanel((p) => (p === "files" ? null : "files")) });
      cmds.push({ id: "panel-plan", label: "Toggle Plan panel", hint: "Panel", run: () => setRightPanel((p) => (p === "plan" ? null : "plan")) });
      cmds.push({ id: "panel-edits", label: "Toggle Edits panel", hint: "Panel", run: () => setRightPanel((p) => (p === "edits" ? null : "edits")) });
    }

    // Appearance + settings (always).
    cmds.push({ id: "toggle-theme", label: "Toggle theme", hint: "Appearance", run: cycleTheme });
    cmds.push({ id: "settings", label: "Settings…", hint: "⌘,", run: () => openSettings() });

    return cmds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, project, activeAgentId]);

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
      <AgentSwitcher
        open={switcherOpen}
        items={switchableAgents}
        onSelect={openAgentFromHome}
        onClose={() => setSwitcherOpen(false)}
      />
      <NotificationCenter onJump={openAgentFromHome} activeAgentId={activeAgentId} />
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
        autoContinueRL={autoContinueRL}
        setAutoContinueRL={setAutoContinueRL}
        agents={agentConfigs}
        setAgents={setAgentConfigs}
        initialTab={settingsTab}
        onTasksChanged={refreshAllTasks}
        onRemoteChanged={refreshRemote}
      />
      {dup && (
        <div className="set-overlay" onClick={() => setDup(null)} role="dialog" aria-modal="true">
          <div className="set-modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="set-head">
              <span className="set-title">Possible duplicate</span>
              <button className="set-x" onClick={() => setDup(null)} aria-label="Close">✕</button>
            </div>
            <div className="set-body">
              <p className="set-row-hint" style={{ marginBottom: 10 }}>
                “{dup.title}” looks like it overlaps an existing task:
              </p>
              <p style={{ fontWeight: 600, marginBottom: 4 }}>{dup.hit.task_title}</p>
              {dup.hit.reason && <p className="set-row-hint">{dup.hit.reason}</p>}
              <div className="jira-actions">
                <button
                  className="btn primary"
                  onClick={() => {
                    api.appendTaskNote(dup.hit.task_id, dup.title).then(refreshAllTasks).catch(() => {});
                    setDup(null);
                  }}
                >
                  Merge into existing
                </button>
                <button className="btn" onClick={() => { dup.create(); setDup(null); }}>
                  Create anyway
                </button>
                <button className="btn-ghost" onClick={() => setDup(null)} style={{ marginLeft: "auto" }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <RunSetupDialog
        open={runSetupOpen}
        onClose={() => setRunSetupOpen(false)}
        clis={enabledAgentClis}
        regenerate={services.some((s) => s.command.trim())}
        onGenerate={(command, extra) => {
          setRunSetupOpen(false);
          void runGenerate(command, extra);
        }}
      />
    </>
  );

  // No projects at all → the original welcome screen.
  if (knownProjects.length === 0) {
    return (
      <div className="ide">
        <div className="welcome">
          <div className="welcome-card">
            <h1 className="welcome-title">Welcome to Evor</h1>
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
              {isTauri() && (
                <button className="btn primary" onClick={openFolder}>
                  Open a project
                </button>
              )}
              <span className="welcome-tip">Tip: press ⌘P anytime to jump around.</span>
            </div>
          </div>
        </div>
        {palette}
      </div>
    );
  }

  // Scope the Home overview to the active super-project, if one is selected.
  const activeSuper = activeSuperId
    ? superProjects.find((s) => s.id === activeSuperId) ?? null
    : null;
  const homeProjects = activeSuper
    ? knownProjects.filter((p) => activeSuper.project_ids.includes(p.id))
    : knownProjects;
  const homeProjectIds = new Set(homeProjects.map((p) => p.id));
  const homeRunningList = activeSuper
    ? runningList.filter((a) => homeProjectIds.has(a.project_id))
    : runningList;
  const homeTasks = activeSuper
    ? allTasksList.filter((t) => homeProjectIds.has(t.project_id))
    : allTasksList;

  // Built once, shared by the desktop home and the mobile home shell.
  const superBarEl = (
    <SuperProjectBar
      superProjects={superProjects}
      projects={knownProjects}
      activeId={activeSuperId}
      onSelect={setActiveSuperId}
      onCreate={(name) =>
        api.createSuperProject(name).then((sp) => {
          setSuperProjects((prev) => [...prev, sp]);
          setActiveSuperId(sp.id);
          refreshSuperProjects();
        }).catch(() => {})
      }
      onRename={(id, name) =>
        void api.renameSuperProject(id, name).then(refreshSuperProjects).catch(() => {})
      }
      onDelete={(id) =>
        void api.deleteSuperProject(id).then(refreshSuperProjects).catch(() => {})
      }
      onSetMembers={(id, ids) =>
        void api.setSuperProjectMembers(id, ids).then(refreshSuperProjects).catch(() => {})
      }
    />
  );
  const homeViewEl = (
    <HomeView
      projects={homeProjects}
      runningList={homeRunningList}
      waitingAgents={waitingAgents}
      waitingOptions={waitingOptions}
      waitingQuestion={waitingQuestion}
      textModes={waitingTextMode}
      tasks={homeTasks}
      clis={enabledAgentClis}
      canPlan={hasJudge}
      termMode={termMode}
      onOpenProject={openProjectFromHome}
      onOpenAgent={openAgentFromHome}
      onAccept={acceptAgent}
      onYes={yesAgent}
      onNo={noAgent}
      onPick={pickOption}
      onAddTask={addTaskGlobal}
      onCycleTask={(t) => void cycleTaskGlobal(t)}
      onDeleteTask={(id) => void delTaskGlobal(id)}
      onAssignTask={(id, pid) => void assignTaskGlobal(id, pid)}
      onSetDescription={setTaskDesc}
      onBreakdown={breakdownTaskH}
      onToggleStep={toggleStepH}
      onWorkTask={(t, c) => workTaskAnywhere(t, c, false)}
      onBrainstormTask={(t, c) => workTaskAnywhere(t, c, true)}
      onPlan={planTasksGlobal}
      onOpenJira={() => openSettings("jira")}
      onTasksRefresh={refreshAllTasks}
      onPushJira={(t) => void pushTaskToJira(t)}
    />
  );

  // Mobile cross-project home: a bottom-nav shell (Home / Agents) mirroring the
  // project workspace, so navigation feels the same before and after you pick a
  // project. Agents are grouped per project with a one-tap launcher.
  if (view === "home" && isMobile) {
    return (
      <div className="ide">
        <MobileHomeShell
          tab={homeTab}
          setTab={setHomeTab}
          superBar={superBarEl}
          home={homeViewEl}
          agents={
            <MobileAgents
              projects={homeProjects}
              running={homeRunningList}
              waitingAgents={waitingAgents}
              clis={enabledAgentClis}
              onOpenAgent={openAgentFromHome}
              onNewAgent={(p, label, command) => void newAgentInProject(p, label, command)}
            />
          }
        />
        {jiraPicker}
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
            currentProjectId={project?.id ?? null}
            homeActive
            runningByProject={runningByProject}
            waitingProjects={waitingProjects}
            lastActivityByProject={lastActivityByProject}
            superProjects={superProjects}
            onSelect={openProjectFromHome}
            onOpen={openFolder}
            onHome={() => setView("home")}
            onWorkspace={() => setView("grid")}
            onCreateGroup={createGroupSeeded}
            onSetGroupMembers={setGroupMembers}
          />
          <div className="home-col">
          {/* Brand header — only shows on mobile, where the rail (which carries
              the “Evor” mark on desktop) is hidden. */}
          <div className="mob-brandbar">Evor</div>
          {superBarEl}
          {homeViewEl}
          </div>
        </div>
        {jiraPicker}
        <HomeBar
          version={appVer}
          projectCount={knownProjects.length}
          runningCount={runningList.length}
          waitingCount={waitingAgents.size}
          onOpenPalette={() => openPalette("commands")}
          onOpenSettings={() => openSettings()}
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
            currentProjectId={project?.id ?? null}
            workspaceActive
            runningByProject={runningByProject}
            waitingProjects={waitingProjects}
            lastActivityByProject={lastActivityByProject}
            superProjects={superProjects}
            onSelect={(p) => {
              setProject(p);
              setView("workspace");
            }}
            onOpen={openFolder}
            onHome={() => setView("home")}
            onWorkspace={() => setView("grid")}
            onCreateGroup={createGroupSeeded}
            onSetGroupMembers={setGroupMembers}
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
              termMode={termMode}
              poppedOut={poppedOut}
              onClosePopout={(id) => void api.closePopout(id)}
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
              onPopOut={(id) => void api.popOutTerminal(id, agentsById[id]?.title)}
            />
          </Suspense>
        </div>
        <HomeBar
          version={appVer}
          projectCount={knownProjects.length}
          runningCount={runningList.length}
          waitingCount={waitingAgents.size}
          onOpenPalette={() => openPalette("commands")}
          onOpenSettings={() => openSettings()}
          theme={theme}
          onCycleTheme={cycleTheme}
        />
        {palette}
      </div>
    );
  }

  // Tasks / daily planning across all projects.
  // Workspace requires an active project; if somehow absent, go Home.
  if (!project) {
    return (
      <div className="ide">
        <div className="welcome">
          <h1>Evor</h1>
          <p>Select a project to continue.</p>
          <button className="btn" onClick={() => setView("home")}>
            Go to Home
          </button>
        </div>
        {palette}
      </div>
    );
  }

  // --- Phone layout: terminal-first, bottom nav, project switcher in a drawer.
  // Reuses the same child components (rail/agents/git/tasks/terminal) as desktop,
  // just arranged for a small touch screen.
  if (isMobile) {
    return (
      <div className="ide">
        <Suspense fallback={<div className="mob" />}>
          <MobileWorkspace
            projectName={project.name}
            activeTitle={activeIsLive ? (activeRec?.title ?? null) : null}
            hasTerminal={!!(activeIsLive && activeAgentId)}
            tab={mobileTab}
            setTab={setMobileTab}
            home={
              <MobileHome
                projectName={project.name}
                agents={activeAgents}
                live={live}
                waitingAgents={waitingAgents}
                waitingOptions={waitingOptions}
                waitingQuestion={waitingQuestion}
                textModes={waitingTextMode}
                tasks={tasks}
                agentCommand={enabledAgentClis.find((c) => c.command.trim())?.command}
                agentLabel={enabledAgentClis.find((c) => c.command.trim())?.label}
                onAccept={acceptAgent}
                onYes={yesAgent}
                onNo={noAgent}
                onPick={pickOption}
                onOpenAgent={(id) => {
                  setCenterMode("terminal");
                  setLiveIssue(null);
                  setMobileTab("terminal");
                  if (!live.has(id)) {
                    void resumeExisting(id);
                  } else {
                    setDiffView(null);
                    setActiveAgentId(id);
                  }
                }}
                onWork={(t, command) => void workOnTask(t, command)}
                onCycle={cycleTask}
                onAsk={(prompt) => {
                  const cli = enabledAgentClis.find((c) => c.command.trim());
                  setMobileTab("terminal");
                  void startAgentWithPrompt(
                    prompt.length > 40 ? prompt.slice(0, 40) + "…" : prompt,
                    cli?.command ?? "",
                    prompt,
                  );
                }}
              />
            }
            onSend={(raw) => {
              if (activeAgentId) {
                void api.writeInput(activeAgentId, raw);
                clearWaiting(activeAgentId);
              }
            }}
            launchOptions={enabledAgentClis}
            onLaunch={(label, command) => {
              setMobileTab("terminal");
              void newAgent(label, command);
            }}
            projectRail={
              <ProjectRail
                projects={knownProjects}
                activeId={project.id}
                currentProjectId={project.id}
                runningByProject={runningByProject}
                waitingProjects={waitingProjects}
                lastActivityByProject={lastActivityByProject}
                superProjects={superProjects}
                onSelect={(p) => {
                  setProject(p);
                  setView("workspace");
                }}
                onOpen={openFolder}
                onHome={() => setView("home")}
                onWorkspace={() => setView("grid")}
                onCreateGroup={createGroupSeeded}
                onSetGroupMembers={setGroupMembers}
              />
            }
            agentsColumn={
              <AgentsColumn
                agents={activeAgents}
                archived={archivedAgents}
                live={live}
                waiting={waitingAgents}
                rateLimited={rateLimited}
                states={agentState}
                clis={enabledAgentClis}
                activeAgentId={activeAgentId}
                git={git}
                sessions={continuableSessions}
                editCounts={editCounts}
                onSelect={(id) => {
                  setCenterMode("terminal");
                  setLiveIssue(null);
                  setMobileTab("terminal");
                  if (!live.has(id)) {
                    void resumeExisting(id);
                  } else {
                    setDiffView(null);
                    setActiveAgentId(id);
                  }
                }}
                onNew={(...a) => {
                  setMobileTab("terminal");
                  return newAgent(...a);
                }}
                onResume={(rec) => {
                  setMobileTab("terminal");
                  resumeAgent(rec);
                }}
                onClose={closeAgent}
                onArchive={archiveAgentH}
                onDelete={deleteAgentH}
                onUnarchive={(id) => {
                  setMobileTab("terminal");
                  void unarchiveAgentH(id);
                }}
                onContinueSession={(s) => {
                  setMobileTab("terminal");
                  continueSession(s);
                }}
                onRename={renameAgent}
                onHome={goProjectHome}
                homeActive={false}
                projectName={project.name}
              />
            }
            terminal={
              activeIsLive && activeAgentId ? (
                <AgentTerminal
                  key={activeAgentId}
                  id={activeAgentId}
                  active
                  mode={termMode}
                  onInput={() => clearWaiting(activeAgentId)}
                  onUrl={(url) =>
                    setUrlByAgent((prev) =>
                      prev[activeAgentId] === url
                        ? prev
                        : { ...prev, [activeAgentId]: url },
                    )
                  }
                  onIssue={(context) => setLiveIssue({ id: activeAgentId, context })}
                  onTitle={(title) => autoTitleAgent(activeAgentId, title)}
                />
              ) : null
            }
            changes={
              <GitPanel
                cwd={project.path}
                git={git}
                canAsk={activeIsLive}
                onAskAgent={askCommitPush}
                onRefreshStatus={refreshGitStatus}
                onOpenDiff={(file) => setDiffView({ file })}
                onBeforeCommit={beforeCommit}
                refreshSignal={fsTick}
              />
            }
            tasks={
              <TasksPanel
                tasks={tasks}
                onAdd={addTask}
                onCycle={cycleTask}
                onDelete={delTask}
              />
            }
          />
        </Suspense>
        {palette}
        {jiraPicker}
      </div>
    );
  }

  return (
    <div className="ide">
      <div className="ide-main">
        {/* Mobile-only: tap-out backdrop that closes whichever rail drawer is open. */}
        {mobileNav !== "none" && (
          <div className="drawer-backdrop" onClick={() => setMobileNav("none")} />
        )}
        <div className={`drawer prail-drawer ${mobileNav === "projects" ? "open" : ""}`}>
        <ProjectRail
          projects={knownProjects}
          activeId={project.id}
          currentProjectId={project.id}
          runningByProject={runningByProject}
          waitingProjects={waitingProjects}
          lastActivityByProject={lastActivityByProject}
          superProjects={superProjects}
          onSelect={(p) => {
            setProject(p);
            setView("workspace");
            setMobileNav("none");
          }}
          onOpen={openFolder}
          onHome={() => setView("home")}
          onWorkspace={() => setView("grid")}
          onCreateGroup={createGroupSeeded}
          onSetGroupMembers={setGroupMembers}
        />
        </div>
        <div className={`drawer rail-drawer ${mobileNav === "agents" ? "open" : ""}`}>
        <AgentsColumn
          agents={activeAgents}
          archived={archivedAgents}
          live={live}
          waiting={waitingAgents}
          rateLimited={rateLimited}
          states={agentState}
          clis={enabledAgentClis}
          activeAgentId={activeAgentId}
          git={git}
          sessions={continuableSessions}
          editCounts={editCounts}
          onSelect={(id) => {
            setCenterMode("terminal");
            setLiveIssue(null);
            setMobileNav("none");
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
          onRename={renameAgent}
          onHome={goProjectHome}
          homeActive={!activeAgentId && !diffView && !(centerMode === "editor" && openFiles.length > 0)}
          projectName={project.name}
        />
        </div>

        <main className="main">
          <div className="topbar">
            {/* Mobile-only rail toggles (hidden on desktop via CSS). */}
            <button
              className="tb-name mobile-only"
              onClick={() => setMobileNav((n) => (n === "projects" ? "none" : "projects"))}
              title="Projects"
              aria-label="Projects"
            >
              ☰
            </button>
            <button
              className="tb-name mobile-only"
              onClick={() => setMobileNav((n) => (n === "agents" ? "none" : "agents"))}
              title="Agents"
              aria-label="Agents"
            >
              ⠿
            </button>
            <div className="tb-project">
              <button
                className="tb-name"
                onClick={() => setMenuOpen((o) => !o)}
                title={`${project.name} — project menu`}
                aria-label={`${project.name} — project menu`}
              >
                <FolderIcon />
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
              {/* Services live in their own group, set apart from the terminal/
                  agent controls so Run reads as "start a service", not "run the
                  focused terminal". */}
              <div className="tb-services">
                <RunControl
                  services={services}
                  running={runningServiceMap}
                  viewable={viewableServiceMap}
                  onStart={startService}
                  onStop={stopService}
                  onView={viewService}
                  onCreateConfig={refreshRunConfig}
                  onSetupAi={() => setRunSetupOpen(true)}
                />
                <PauseControl
                  paused={pausedProjects.has(project.id)}
                  pausingSeconds={pausing?.projectId === project.id ? pausing.secondsLeft : null}
                  hasLive={agents.some((a) => live.has(a.id))}
                  onPause={() => void pauseProject()}
                  onResume={() => void resumeProject()}
                />
              </div>
              <span className="tb-sep" aria-hidden="true" />
              <NewAgentMenu
                agents={agentConfigs}
                onLaunch={(a) => newAgent(a.label, a.command)}
                onToggle={(id, enabled) =>
                  setAgentConfigs((prev) =>
                    prev.map((x) => (x.id === id ? { ...x, enabled } : x)),
                  )
                }
              />
              {activeIsLive && activeAgentId && !poppedOut.has(activeAgentId) && (
                <>
                  <button
                    className="btn-sm icon"
                    onClick={() => popOut(activeAgentId)}
                    title="Pop out this terminal into its own window"
                    aria-label="Pop out terminal"
                  >
                    ⧉
                  </button>
                  <button
                    className="btn-sm icon"
                    onClick={() => {
                      addRunningToGrid(activeAgentId);
                      setView("grid");
                    }}
                    title="Add this terminal to the Workspace grid"
                    aria-label="Add to workspace"
                  >
                    ⊞
                  </button>
                  {activeAgentId !== splitAgentId && (
                    <button
                      className={`btn-sm icon ${split ? "on" : ""}`}
                      onClick={() => (split ? closeSplit() : void openSplitTerminal())}
                      title={
                        split
                          ? "Close the split pane"
                          : "Split: open a terminal beside this one to run commands"
                      }
                      aria-label="Split pane"
                    >
                      ⊟
                    </button>
                  )}
                </>
              )}
              {openFiles.length > 0 && (
                <>
                  <span className="tb-sep" />
                  <div className="center-switch">
                    <button
                      className={centerMode === "terminal" && !editorInSplit ? "on" : ""}
                      onClick={() => setCenterMode("terminal")}
                      title="Show terminal"
                      aria-label="Show terminal"
                    >
                      &gt;_
                    </button>
                    <button
                      className={centerMode === "editor" && !editorInSplit ? "on" : ""}
                      onClick={() => {
                        // Going full-screen editor collapses an editor split.
                        setSplit((s) => (s?.kind === "editor" ? null : s));
                        setCenterMode("editor");
                      }}
                      title={`Show files (${openFiles.length} open)`}
                      aria-label="Show files"
                    >
                      📄 {openFiles.length}
                    </button>
                  </div>
                  {activeIsLive && activeAgentId && !poppedOut.has(activeAgentId) && (
                    <button
                      className={`btn-sm icon ${editorInSplit ? "on" : ""}`}
                      onClick={() => (editorInSplit ? closeSplit() : openSplitEditor())}
                      title={
                        editorInSplit
                          ? "Close the side-by-side file view"
                          : "Open the files beside the agent"
                      }
                      aria-label="Open files to the side"
                    >
                      ◧
                    </button>
                  )}
                </>
              )}
              <span className="tb-sep" />
              {(
                [
                  { id: "files", icon: "📁", label: "Files" },
                  { id: "git", icon: "⎇", label: "Git changes" },
                  { id: "plan", icon: "☑", label: "Plan / tasks" },
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
              {/* Center shows a diff, a full-screen editor, or the agent terminal
                  — the last optionally split with a second pane (shell or files). */}
              {diffView ? (
                <div key="diff" className="term-slot">
                  <DiffView
                    cwd={project.path}
                    file={diffView.file}
                    onClose={() => setDiffView(null)}
                  />
                </div>
              ) : !editorInSplit && centerMode === "editor" && openFiles.length > 0 ? (
                <div key="editor" className="term-slot center-fill">
                  <Editor
                    files={openFiles}
                    activePath={activeFile}
                    previewPath={previewFile}
                    onActivate={setActiveFile}
                    onClose={closeFile}
                    onMakePermanent={makeFilePermanent}
                    mode={termMode}
                  />
                </div>
              ) : activeIsLive && activeAgentId && poppedOut.has(activeAgentId) ? (
                <div key="popped" className="term-slot term-placeholder">
                  <p>⧉ This terminal is popped out into its own window.</p>
                  <div className="ph-actions">
                    <button className="btn" onClick={() => void api.closePopout(activeAgentId)}>
                      Close pop-out & open here
                    </button>
                  </div>
                </div>
              ) : activeIsLive && activeAgentId ? (
                <div
                  key="terminal"
                  className={`term-slot term-host-wrap${
                    showSplit && split ? ` term-split term-split-${split.dir}` : ""
                  }`}
                >
                  <div
                    className={`term-pane${
                      showSplit && activePane === "main" ? " pane-active" : ""
                    }`}
                    onMouseDownCapture={showSplit ? () => setActivePane("main") : undefined}
                  >
                    <AgentTerminal
                      key={activeAgentId}
                      id={activeAgentId}
                      active
                      mode={termMode}
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
                      onTitle={(title) => autoTitleAgent(activeAgentId, title)}
                    />
                    {liveIssue?.id === activeAgentId && (
                      <button className="fix-overlay" onClick={fixLiveIssue}>
                        ⚠ Fix this issue
                      </button>
                    )}
                  </div>
                  {showSplit && split && (
                    <div
                      className={`term-pane term-pane-split${
                        activePane === "split" ? " pane-active" : ""
                      }`}
                      onMouseDownCapture={() => setActivePane("split")}
                    >
                      <div className="split-head">
                        <div className="split-tabs">
                          <button
                            className={`split-tab${split.kind === "shell" ? " on" : ""}`}
                            onClick={() => void setSplitKind("shell")}
                            title="Show a terminal in this pane"
                          >
                            &gt;_
                          </button>
                          {openFiles.length > 0 && (
                            <button
                              className={`split-tab${split.kind === "editor" ? " on" : ""}`}
                              onClick={() => void setSplitKind("editor")}
                              title="Show the open files in this pane"
                            >
                              📄 {openFiles.length}
                            </button>
                          )}
                        </div>
                        <div className="split-acts">
                          <button
                            className="split-btn"
                            onClick={toggleSplitDir}
                            title={split.dir === "row" ? "Stack below" : "Place side by side"}
                            aria-label="Toggle split orientation"
                          >
                            {split.dir === "row" ? "▤" : "▥"}
                          </button>
                          <button
                            className="split-close"
                            onClick={closeSplit}
                            title="Close split"
                            aria-label="Close split"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <div className="split-body">
                        {split.kind === "editor" ? (
                          <Editor
                            key="split-editor"
                            files={openFiles}
                            activePath={activeFile}
                            previewPath={previewFile}
                            onActivate={setActiveFile}
                            onClose={closeFile}
                            onMakePermanent={makeFilePermanent}
                            mode={termMode}
                          />
                        ) : splitAgentId ? (
                          <AgentTerminal
                            key={splitAgentId}
                            id={splitAgentId}
                            active
                            mode={termMode}
                            onInput={() => clearWaiting(splitAgentId)}
                          />
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              ) : activeRec ? (
                <div key="idle" className="term-slot term-placeholder">
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
                <div key="home" className="term-slot launcher-slot">
                  <ProjectHome
                    project={project}
                    git={git}
                    tasks={tasks}
                    clis={enabledAgentClis}
                    agentsWorking={projectAgentsWorking}
                    termMode={termMode}
                    onOpenAgent={(id) => {
                      setDiffView(null);
                      setActiveAgentId(id);
                    }}
                    onContinue={(id) => acceptAgent(id)}
                    onPick={pickOption}
                    onAdd={addTask}
                    onCycle={cycleTask}
                    onDelete={(t) => delTask(t.id)}
                    onWork={(t, c) => void workOnTask(t, c)}
                    onBrainstorm={(t, c) => void brainstormTask(t, c)}
                    onNew={newAgent}
                    onSetDescription={setTaskDesc}
                    onBreakdown={breakdownTaskH}
                    onToggleStep={toggleStepH}
                    onPushJira={(t) => void pushTaskToJira(t)}
                  />
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
                refreshSignal={fsTick}
              />
            )}
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

      {jiraPicker}
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
        onOpenSettings={() => openSettings()}
        cwd={project?.path ?? null}
        onGitRefresh={refreshGitStatus}
      />
      {palette}
    </div>
  );
}
