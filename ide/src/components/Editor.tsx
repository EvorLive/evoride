import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { readFile, writeFile, type FileContent, type FileEntry } from "../lib/tauri";
import Markdown from "./Markdown";

const isMd = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

// Right-center tabbed editor: edit + save files, with a Markdown preview toggle.
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
  const [meta, setMeta] = useState<Record<string, FileContent>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [rawMd, setRawMd] = useState(false);
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (activePath && meta[activePath] === undefined) {
      readFile(activePath)
        .then((c) => {
          setMeta((p) => ({ ...p, [activePath]: c }));
          if (!c.binary) {
            setSaved((p) => ({ ...p, [activePath]: c.content }));
            setDraft((p) => ({ ...p, [activePath]: c.content }));
          }
        })
        .catch(() =>
          setMeta((p) => ({
            ...p,
            [activePath]: { content: "", truncated: false, binary: true },
          })),
        );
    }
  }, [activePath, meta]);

  const m = activePath ? meta[activePath] : null;
  const markdown = !!activePath && isMd(activePath);
  const editable = !!m && !m.binary && !m.truncated;
  const dirty = !!activePath && editable && draft[activePath] !== saved[activePath];
  const showPreview = markdown && !rawMd;

  const save = async () => {
    if (!activePath || !editable || !dirty) return;
    setBusy(true);
    try {
      await writeFile(activePath, draft[activePath] ?? "");
      setSaved((p) => ({ ...p, [activePath]: draft[activePath] ?? "" }));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
  };

  return (
    <div className="editor">
      <div className="editor-tabs">
        {files.map((f) => {
          const fDirty =
            meta[f.path] && !meta[f.path].binary && draft[f.path] !== saved[f.path];
          return (
            <div
              key={f.path}
              className={`etab ${f.path === activePath ? "active" : ""}`}
              onClick={() => onActivate(f.path)}
              title={f.path}
            >
              <span className="etab-name">{f.name}</span>
              {fDirty && <span className="etab-dot" title="unsaved">●</span>}
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
          );
        })}
        <div className="etab-spacer" />
        {markdown && (
          <button className="etab-toggle" onClick={() => setRawMd((r) => !r)}>
            {rawMd ? "Preview" : "Source"}
          </button>
        )}
        {editable && !showPreview && (
          <button
            className="etab-save"
            onClick={save}
            disabled={!dirty || busy}
            title="Save (⌘/Ctrl-S)"
          >
            {busy ? "Saving…" : dirty ? "● Save" : "Saved"}
          </button>
        )}
      </div>

      <div className="editor-body">
        {!activePath ? (
          <div className="editor-empty">No file open</div>
        ) : m?.binary ? (
          <div className="editor-empty">(binary file — can’t edit)</div>
        ) : showPreview ? (
          <div className="md-scroll">
            <Markdown text={draft[activePath] ?? m?.content ?? ""} />
          </div>
        ) : (
          <textarea
            ref={taRef}
            className="code-edit"
            spellCheck={false}
            readOnly={!editable}
            value={draft[activePath] ?? m?.content ?? ""}
            onChange={(e) =>
              setDraft((p) => ({ ...p, [activePath]: e.target.value }))
            }
            onKeyDown={onKey}
          />
        )}
        {m?.truncated && (
          <div className="editor-note">
            truncated (&gt;250KB) — read-only to avoid data loss
          </div>
        )}
      </div>
    </div>
  );
}
