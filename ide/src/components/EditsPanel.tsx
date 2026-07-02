import { useEffect, useState } from "react";
import { agentEdits, type EditRecord } from "../lib/tauri";

// Right panel: the files the active agent reported editing this session. The
// agent logs them (per the managed CLAUDE.md/AGENTS.md skill) to
// `.evoride/agents/<id>/edits.jsonl`; we poll and dedupe to the latest per file.
export default function EditsPanel({
  projectPath,
  agentId,
  agentTitle,
}: {
  projectPath: string;
  agentId: string | null;
  agentTitle: string | null;
}) {
  const [edits, setEdits] = useState<EditRecord[]>([]);

  useEffect(() => {
    if (!agentId) {
      setEdits([]);
      return;
    }
    let alive = true;
    const poll = () =>
      agentEdits(projectPath, agentId)
        .then((e) => alive && setEdits(e))
        .catch(() => {});
    poll();
    const t = setInterval(() => !document.hidden && poll(), 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [projectPath, agentId]);

  return (
    <aside className="edits">
      <div className="edits-head">
        <span>Edits</span>
        {agentId && <span className="edits-count">{edits.length}</span>}
      </div>

      {!agentId ? (
        <div className="edits-empty">
          <p>Select a running agent to see the files it changes.</p>
        </div>
      ) : (
        <>
          <div className="edits-sub" title={agentTitle ?? undefined}>
            for {agentTitle || "agent"}
          </div>
          {edits.length === 0 ? (
            <div className="edits-empty">
              <p>No tracked edits yet — the agent logs files it changes here.</p>
            </div>
          ) : (
            <ul className="edits-list">
              {edits.map((e) => (
                <li key={e.file} className="edits-item">
                  <span className="edits-file" title={e.file}>
                    {e.file}
                  </span>
                  {e.info && <span className="edits-info">{e.info}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}
