import { useEffect, useState } from "react";
import { readFile, type FileContent, type FileEntry } from "../lib/tauri";
import Markdown from "./Markdown";

const isMd = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

// Right-side tabbed editor (read-only), VS Code-like: file tabs + line numbers.
export default function Editor({
  files,
  activePath,
  onActivate,
  onClose,
}: {
  files: FileEntry[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const [cache, setCache] = useState<Record<string, FileContent>>({});
  // Markdown files preview by default; toggle to see source.
  const [rawMd, setRawMd] = useState(false);

  useEffect(() => {
    if (activePath && !cache[activePath]) {
      readFile(activePath)
        .then((c) => setCache((p) => ({ ...p, [activePath]: c })))
        .catch(() =>
          setCache((p) => ({
            ...p,
            [activePath]: { content: "", truncated: false, binary: true },
          })),
        );
    }
  }, [activePath, cache]);

  const content = activePath ? cache[activePath] : null;
  const lineCount =
    content && !content.binary ? content.content.split("\n").length : 0;
  const markdown = !!activePath && isMd(activePath);

  return (
    <div className="editor">
      <div className="editor-tabs">
        {files.map((f) => (
          <div
            key={f.path}
            className={`etab ${f.path === activePath ? "active" : ""}`}
            onClick={() => onActivate(f.path)}
            title={f.path}
          >
            <span className="etab-name">{f.name}</span>
            <button
              className="etab-x"
              onClick={(e) => {
                e.stopPropagation();
                onClose(f.path);
              }}
            >
              ✕
            </button>
          </div>
        ))}
        {markdown && (
          <button
            className="etab-toggle"
            onClick={() => setRawMd((r) => !r)}
            title="Toggle markdown preview / source"
          >
            {rawMd ? "Preview" : "Source"}
          </button>
        )}
      </div>

      <div className="editor-body">
        {!activePath ? (
          <div className="editor-empty">No file open</div>
        ) : content?.binary ? (
          <div className="editor-empty">(binary file)</div>
        ) : markdown && !rawMd ? (
          <div className="md-scroll">
            <Markdown text={content?.content ?? ""} />
          </div>
        ) : (
          <div className="code">
            <div className="gutter" aria-hidden="true">
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <pre className="code-content">{content?.content ?? "loading…"}</pre>
          </div>
        )}
        {content?.truncated && (
          <div className="editor-note">truncated — file larger than 250KB</div>
        )}
      </div>
    </div>
  );
}
