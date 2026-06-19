import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/tauri";
import type { AgentRecord } from "../lib/tauri";

// A global notification surface: toasts pop in the corner — and a bell/inbox
// keeps a history — whenever ANY agent across ANY project needs your input or
// finishes. It renders on every screen (it lives in App's always-on overlay),
// so you never miss an agent that went quiet while you were elsewhere. Click a
// notification to jump straight into that agent.
//
// It is intentionally self-contained: it subscribes to the same global
// `agent-waiting` / `pty-exit` events the rest of the app listens to (Tauri
// allows many listeners per event), and resolves agent/project names itself, so
// wiring it into App is a single mount line.

type NotifKind = "waiting" | "done" | "error";

interface Notif {
  key: string;
  agent: AgentRecord;
  projectName: string;
  kind: NotifKind;
  question?: string;
  at: number;
  read: boolean;
}

const TOAST_MS = 7000;
const MAX_NOTIFS = 50;

const KIND_META: Record<NotifKind, { icon: string; label: string }> = {
  waiting: { icon: "codicon-comment-discussion", label: "needs you" },
  done: { icon: "codicon-pass", label: "finished" },
  error: { icon: "codicon-error", label: "exited with errors" },
};

export default function NotificationCenter({
  onJump,
  activeAgentId,
}: {
  onJump: (agent: AgentRecord) => void;
  /** The agent currently on screen — we don't notify about the one you're watching. */
  activeAgentId?: string | null;
}) {
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [toasts, setToasts] = useState<string[]>([]); // keys currently shown as toasts
  const [open, setOpen] = useState(false);

  // Latest lookups, read inside event handlers without re-subscribing.
  const projectsRef = useRef<Map<string, string>>(new Map());
  const activeRef = useRef<string | null | undefined>(activeAgentId);
  activeRef.current = activeAgentId;

  const resolveProjectName = (projectId: string) =>
    projectsRef.current.get(projectId) ?? projectId;

  // Keep project names handy for labelling (cheap, rarely changes).
  useEffect(() => {
    const load = () =>
      api
        .listProjects()
        .then((ps) => {
          projectsRef.current = new Map(ps.map((p) => [p.id, p.name]));
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const push = useCallback((n: Notif) => {
    setNotifs((prev) => {
      // Collapse to one live "waiting" notification per agent.
      const filtered =
        n.kind === "waiting"
          ? prev.filter((p) => !(p.kind === "waiting" && p.agent.id === n.agent.id))
          : prev;
      return [n, ...filtered].slice(0, MAX_NOTIFS);
    });
    setToasts((prev) => [n.key, ...prev]);
  }, []);

  // Auto-dismiss each toast (it stays in the inbox).
  useEffect(() => {
    if (toasts.length === 0) return;
    const newest = toasts[0];
    const t = setTimeout(() => {
      setToasts((prev) => prev.filter((k) => k !== newest));
    }, TOAST_MS);
    return () => clearTimeout(t);
  }, [toasts]);

  // Resolve the full agent record for an event id (needed to jump + label).
  const lookupAgent = useCallback(async (id: string): Promise<AgentRecord | null> => {
    const all = await api.allAgents().catch(() => [] as AgentRecord[]);
    return all.find((a) => a.id === id) ?? null;
  }, []);

  // "Agent needs input" — appear on raise, clear on resolve.
  useEffect(() => {
    let un: (() => void) | undefined;
    api
      .onAgentWaiting((id, waiting, _options, question) => {
        if (!waiting) {
          // Resolved (answered elsewhere) — drop any pending waiting notif/toast.
          setNotifs((prev) =>
            prev.filter((p) => !(p.kind === "waiting" && p.agent.id === id)),
          );
          return;
        }
        if (id === activeRef.current) return; // you're already looking at it
        void lookupAgent(id).then((agent) => {
          if (!agent) return;
          push({
            key: `wait:${id}`,
            agent,
            projectName: resolveProjectName(agent.project_id),
            kind: "waiting",
            question: question || undefined,
            at: Date.now(),
            read: false,
          });
        });
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, [lookupAgent, push]);

  // "Agent finished" — fires for any agent, including background/discarded ones.
  useEffect(() => {
    let un: (() => void) | undefined;
    api
      .onAnyAgentExit((id, info) => {
        if (id === activeRef.current) return; // you saw it exit
        void lookupAgent(id).then((agent) => {
          if (!agent) return;
          push({
            key: `exit:${id}:${Date.now()}`,
            agent,
            projectName: resolveProjectName(agent.project_id),
            kind: info?.hasError ? "error" : "done",
            at: Date.now(),
            read: false,
          });
        });
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, [lookupAgent, push]);

  // ⌘⇧N / Ctrl⇧N toggles the inbox from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const unread = notifs.filter((n) => !n.read).length;

  const markAllRead = () =>
    setNotifs((prev) => prev.map((n) => (n.read ? n : { ...n, read: true })));

  const openInbox = () => {
    setOpen((o) => {
      if (!o) markAllRead();
      return !o;
    });
  };

  const jump = (n: Notif) => {
    onJump(n.agent);
    setOpen(false);
    setToasts((prev) => prev.filter((k) => k !== n.key));
    setNotifs((prev) => prev.map((x) => (x.key === n.key ? { ...x, read: true } : x)));
  };

  const dismiss = (key: string) => {
    setToasts((prev) => prev.filter((k) => k !== key));
    setNotifs((prev) => prev.filter((n) => n.key !== key));
  };

  const visibleToasts = toasts
    .map((key) => notifs.find((n) => n.key === key))
    .filter((n): n is Notif => !!n)
    .slice(0, 4);

  return (
    <div className="notif-root">
      {/* Toast stack */}
      <div className="notif-toasts">
        {visibleToasts.map((n) => (
          <button key={n.key} className={`notif-toast kind-${n.kind}`} onClick={() => jump(n)}>
            <i className={`codicon ${KIND_META[n.kind].icon} notif-icon`} />
            <span className="notif-toast-body">
              <span className="notif-toast-title">{n.agent.title}</span>
              <span className="notif-toast-sub">
                {KIND_META[n.kind].label} · {n.projectName}
              </span>
              {n.question && <span className="notif-toast-q">{n.question}</span>}
            </span>
            <span
              className="notif-x"
              title="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                dismiss(n.key);
              }}
            >
              <i className="codicon codicon-close" />
            </span>
          </button>
        ))}
      </div>

      {/* Bell + inbox */}
      <div className="notif-bell-wrap">
        {open && (
          <div className="notif-inbox" onMouseDown={(e) => e.stopPropagation()}>
            <div className="notif-inbox-head">
              <span>Notifications</span>
              {notifs.length > 0 && (
                <button className="notif-clear" onClick={() => setNotifs([])}>
                  Clear all
                </button>
              )}
            </div>
            <div className="notif-inbox-list">
              {notifs.length === 0 ? (
                <div className="notif-empty">You're all caught up</div>
              ) : (
                notifs.map((n) => (
                  <button key={n.key} className="notif-item" onClick={() => jump(n)}>
                    <i className={`codicon ${KIND_META[n.kind].icon} notif-icon kind-${n.kind}`} />
                    <span className="notif-item-body">
                      <span className="notif-item-title">{n.agent.title}</span>
                      <span className="notif-item-sub">
                        {KIND_META[n.kind].label} · {n.projectName}
                      </span>
                      {n.question && <span className="notif-item-q">{n.question}</span>}
                    </span>
                    <span
                      className="notif-x"
                      title="Dismiss"
                      onClick={(e) => {
                        e.stopPropagation();
                        dismiss(n.key);
                      }}
                    >
                      <i className="codicon codicon-close" />
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
        <button
          className={`notif-bell ${unread > 0 ? "has-unread" : ""}`}
          title="Notifications (⌘⇧N)"
          onClick={openInbox}
        >
          <i className="codicon codicon-bell" />
          {unread > 0 && <span className="notif-badge">{unread > 9 ? "9+" : unread}</span>}
        </button>
      </div>
    </div>
  );
}
