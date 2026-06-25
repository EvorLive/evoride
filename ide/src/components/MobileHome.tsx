import { useState } from "react";
import type { AgentRecord, Task } from "../lib/tauri";

const DOT: Record<Task["status"], string> = { todo: "○", doing: "◐", done: "●", verified: "✔" };
const NEXT: Record<Task["status"], Task["status"]> = { todo: "doing", doing: "done", done: "verified", verified: "todo" };

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Thumb-first landing for the phone. Three glances, top to bottom:
 *   1. Who needs you now — waiting agents with big Accept/Yes/No (or menu) buttons,
 *      so you can unblock work without opening the terminal.
 *   2. Just ask — one plain-English box that spins up an agent on the typed prompt.
 *   3. Your tasks — each is one tap to hand to an agent ("Tell Evor to do this").
 *
 * Deliberately leaner than the desktop HomeView: no Jira inbox / recap / planner —
 * just the actions you reach for on a phone. The terminal is one tab away when you
 * want detail. All callbacks are the same ones the desktop home already uses.
 */
export default function MobileHome({
  projectName,
  agents,
  live,
  waitingAgents,
  waitingOptions,
  waitingQuestion,
  textModes,
  tasks,
  agentCommand,
  agentLabel,
  onAccept,
  onYes,
  onNo,
  onPick,
  onOpenAgent,
  onWork,
  onCycle,
  onAsk,
}: {
  projectName: string;
  /** This project's non-archived agents. */
  agents: AgentRecord[];
  live: Set<string>;
  waitingAgents: Set<string>;
  waitingOptions: Record<string, string[]>;
  waitingQuestion: Record<string, string>;
  textModes: Record<string, boolean>;
  /** This project's tasks. */
  tasks: Task[];
  /** Default agent CLI to launch for Work / Ask (omit → those actions hidden). */
  agentCommand?: string;
  agentLabel?: string;
  onAccept: (id: string) => void;
  onYes: (id: string) => void;
  onNo: (id: string) => void;
  onPick: (id: string, n: number, label: string) => void;
  /** Focus an agent (switches to the terminal tab). */
  onOpenAgent: (id: string) => void;
  onWork: (t: Task, command: string) => void;
  onCycle: (t: Task) => void;
  /** Hand a free-form, plain-English instruction to a fresh agent. */
  onAsk: (prompt: string) => void;
}) {
  const [ask, setAsk] = useState("");

  const liveAgents = agents.filter((a) => live.has(a.id));
  const waitingList = liveAgents.filter((a) => waitingAgents.has(a.id));
  const runningList = liveAgents.filter((a) => !waitingAgents.has(a.id));

  const openTasks = tasks
    .filter((t) => t.status === "todo" || t.status === "doing")
    .sort((a, b) => (a.status === b.status ? a.created_at - b.created_at : a.status === "doing" ? -1 : 1));

  const submitAsk = (e: React.FormEvent) => {
    e.preventDefault();
    const text = ask.trim();
    if (!text) return;
    onAsk(text);
    setAsk("");
  };

  return (
    <div className="mhome">
      <header className="mhome-head">
        <h1>{greeting()}</h1>
        <p className="mhome-sub">{projectName}</p>
      </header>

      {/* 1 — Who needs you */}
      {waitingList.length > 0 ? (
        <section className="mhome-sec mhome-needs">
          <h2 className="mhome-h2">Needs you</h2>
          <ul className="mhome-rows">
            {waitingList.map((a) => {
              const opts = waitingOptions[a.id] ?? [];
              const question = waitingQuestion[a.id];
              return (
                <li key={a.id} className="mhome-need">
                  <button className="mhome-need-title" onClick={() => onOpenAgent(a.id)}>
                    {a.title}
                  </button>
                  {question && <p className="mhome-q">“{question}”</p>}
                  {opts.length > 0 ? (
                    <div className="mhome-choices">
                      {opts.map((label, i) => (
                        <button
                          key={i}
                          className={`btn ${i === 0 ? "primary" : "btn-ghost"} mhome-choice`}
                          onClick={() => onPick(a.id, i + 1, label)}
                        >
                          {!textModes[a.id] && <span className="mhome-choice-n">{i + 1}</span>}
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="mhome-yn">
                      <button className="btn primary" onClick={() => onAccept(a.id)}>Accept</button>
                      <button className="btn-ghost" onClick={() => onYes(a.id)}>Yes</button>
                      <button className="btn-ghost" onClick={() => onNo(a.id)}>No</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <div className="mhome-clear">All caught up — nothing’s waiting on you.</div>
      )}

      {/* 2 — Just ask */}
      {agentCommand && (
        <section className="mhome-sec">
          <h2 className="mhome-h2">Tell Evor what to do</h2>
          <form className="mhome-ask" onSubmit={submitAsk}>
            <textarea
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitAsk(e);
              }}
              placeholder="e.g. Fix the login redirect bug"
              rows={2}
              autoCapitalize="sentences"
            />
            <button type="submit" className="btn primary" disabled={!ask.trim()}>
              Ask {agentLabel ?? "Evor"} →
            </button>
          </form>
        </section>
      )}

      {/* Running agents (not blocked) */}
      {runningList.length > 0 && (
        <section className="mhome-sec">
          <h2 className="mhome-h2">Running</h2>
          <ul className="mhome-rows">
            {runningList.map((a) => (
              <li key={a.id} className="mhome-run">
                <span className="mhome-dot-live" />
                <button className="mhome-run-title" onClick={() => onOpenAgent(a.id)}>
                  {a.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 3 — Your tasks */}
      <section className="mhome-sec">
        <h2 className="mhome-h2">Tasks</h2>
        {openTasks.length === 0 ? (
          <p className="mhome-empty">No open tasks. Ask Evor for something above.</p>
        ) : (
          <ul className="mhome-rows">
            {openTasks.map((t) => (
              <li key={t.id} className="mhome-task">
                <button className={`mhome-task-dot ${t.status}`} onClick={() => onCycle(t)} title={`Mark ${NEXT[t.status]}`}>
                  {DOT[t.status]}
                </button>
                <span className="mhome-task-title">{t.title}</span>
                {agentCommand && (
                  <button className="btn primary mhome-task-go" onClick={() => onWork(t, agentCommand)}>
                    ▶ Do it
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
