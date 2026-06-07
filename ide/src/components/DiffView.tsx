import { useEffect, useState } from "react";
import { gitDiff } from "../lib/tauri";

// Shown in the center area (replacing the terminal) when the user wants to
// inspect changes. Loads `git diff HEAD` for the whole tree or one file.
export default function DiffView({
  cwd,
  file,
  onClose,
}: {
  cwd: string;
  file: string | null;
  onClose: () => void;
}) {
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    gitDiff(cwd, file ?? undefined)
      .then(setText)
      .catch(() => setText(""))
      .finally(() => setLoading(false));
  }, [cwd, file]);

  return (
    <div className="diffview">
      <div className="diffview-head">
        <span className="diffview-title">{file ?? "All changes"}</span>
        <button className="diffview-x" onClick={onClose} title="Back to terminal">
          ✕ Close diff
        </button>
      </div>
      <div className="diffview-body">
        {loading ? (
          <div className="diff-empty">loading…</div>
        ) : !text ? (
          <div className="diff-empty">No tracked changes.</div>
        ) : (
          <pre className="diff">
            {text.split("\n").map((line, i) => {
              let cls = "";
              if (line.startsWith("+") && !line.startsWith("+++")) cls = "d-add";
              else if (line.startsWith("-") && !line.startsWith("---")) cls = "d-del";
              else if (line.startsWith("@@")) cls = "d-hunk";
              else if (line.startsWith("diff ") || line.startsWith("index ")) cls = "d-meta";
              return (
                <div key={i} className={cls}>
                  {line || " "}
                </div>
              );
            })}
          </pre>
        )}
      </div>
    </div>
  );
}
