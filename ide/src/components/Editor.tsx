import { useEffect, useState, type KeyboardEvent } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import { loadLanguage, type LanguageName } from "@uiw/codemirror-extensions-langs";
import { readFile, writeFile, type FileContent, type FileEntry } from "../lib/tauri";
import Markdown from "./Markdown";

const isMd = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

// The langs registry is keyed largely by file extension (rs, py, tsx, cpp, …),
// so the extension itself is usually the language key. A few need an alias.
const LANG_ALIAS: Record<string, string> = {
  mjs: "js", cjs: "js", jsonc: "json", htm: "html", zsh: "sh",
  cxx: "cpp", hpp: "cpp", hh: "cpp", mdx: "md", markdown: "md", yml: "yaml",
};

function languageExtensions(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const key = (LANG_ALIAS[ext] ?? ext) as LanguageName;
  const lang = loadLanguage(key); // null for unknown extensions → no highlighting
  return lang ? [lang] : [];
}

// Right-center tabbed editor: edit + save files with syntax highlighting
// (CodeMirror) + a Markdown preview toggle. Files open as a single "preview"
// (temporary) tab — shown in italics — that the next single-click reuses;
// double-clicking the tab/file or editing it makes the tab permanent.
export default function Editor({
  files,
  activePath,
  previewPath,
  onActivate,
  onClose,
  onMakePermanent,
  mode = "dark",
}: {
  files: FileEntry[];
  activePath: string | null;
  /** Path of the temporary/preview tab (italic), if any. */
  previewPath?: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  /** Pin a tab (e.g. double-clicked or edited) so it's no longer temporary. */
  onMakePermanent?: (path: string) => void;
  /** IDE color mode so the editor theme matches. */
  mode?: "light" | "dark";
}) {
  const [meta, setMeta] = useState<Record<string, FileContent>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [rawMd, setRawMd] = useState(false);
  const [busy, setBusy] = useState(false);

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

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
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
          const isPreview = f.path === previewPath;
          return (
            <div
              key={f.path}
              className={`etab ${f.path === activePath ? "active" : ""} ${isPreview ? "preview" : ""}`}
              onClick={() => onActivate(f.path)}
              onDoubleClick={() => onMakePermanent?.(f.path)}
              title={isPreview ? `${f.path} — preview (double-click to keep open)` : f.path}
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
          <div className="editor-cm" onKeyDown={onKey}>
            <CodeMirror
              value={draft[activePath] ?? m?.content ?? ""}
              theme={mode === "light" ? vscodeLight : vscodeDark}
              extensions={languageExtensions(activePath)}
              editable={editable}
              readOnly={!editable}
              height="100%"
              style={{ height: "100%" }}
              basicSetup={{ highlightActiveLine: editable, foldGutter: true }}
              onChange={(val) => {
                if (!editable) return;
                setDraft((p) => ({ ...p, [activePath]: val }));
                if (previewPath === activePath) onMakePermanent?.(activePath);
              }}
            />
          </div>
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
