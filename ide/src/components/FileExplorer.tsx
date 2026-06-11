import { useEffect, useState, type FormEvent } from "react";
import { createFile, readDir, type FileEntry } from "../lib/tauri";

// A lazily-expanding directory node (VS Code-style explorer).
function TreeNode({
  entry,
  depth,
  onOpen,
  activePath,
}: {
  entry: FileEntry;
  depth: number;
  onOpen: (e: FileEntry, opts?: { preview?: boolean }) => void;
  activePath: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);

  const expand = () => {
    const next = !open;
    setOpen(next);
    if (next && children === null) {
      readDir(entry.path).then(setChildren).catch(() => setChildren([]));
    }
  };

  // VSCode behavior: single-click a file opens it as a temporary "preview" tab;
  // double-click opens it permanently. Directories just expand/collapse.
  const onRowClick = () => (entry.is_dir ? expand() : onOpen(entry, { preview: true }));
  const onRowDouble = () => {
    if (!entry.is_dir) onOpen(entry, { preview: false });
  };

  return (
    <>
      <button
        className={`tree-row ${entry.is_dir ? "is-dir" : "is-file"} ${
          activePath === entry.path ? "active" : ""
        }`}
        style={{ paddingLeft: 8 + depth * 13 }}
        onClick={onRowClick}
        onDoubleClick={onRowDouble}
        title={entry.name}
      >
        <span className="tree-chevron">
          {entry.is_dir ? (
            <i className={`codicon codicon-chevron-${open ? "down" : "right"}`} />
          ) : null}
        </span>
        <span className="tree-glyph">
          <i
            className={`codicon codicon-${
              entry.is_dir ? (open ? "folder-opened" : "folder") : "file"
            }`}
          />
        </span>
        <span className="tree-name">{entry.name}</span>
      </button>
      {open &&
        children?.map((c) => (
          <TreeNode
            key={c.path}
            entry={c}
            depth={depth + 1}
            onOpen={onOpen}
            activePath={activePath}
          />
        ))}
    </>
  );
}

// Left explorer panel: the project's file tree.
export default function FileExplorer({
  root,
  onOpenFile,
  activePath,
}: {
  root: string;
  onOpenFile: (e: FileEntry, opts?: { preview?: boolean }) => void;
  activePath: string | null;
}) {
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => readDir(root).then(setTree).catch(() => setTree([]));
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const submitNew = async (e: FormEvent) => {
    e.preventDefault();
    const rel = name.trim().replace(/^\/+/, "");
    if (!rel) return;
    setError(null);
    try {
      const path = `${root.replace(/\/$/, "")}/${rel}`;
      await createFile(path);
      setName("");
      setAdding(false);
      refresh();
      onOpenFile({ name: rel.split("/").pop() ?? rel, path, is_dir: false });
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="explorer">
      <div className="explorer-head">
        <span>Explorer</span>
        <button
          className="explorer-new"
          title="New file"
          onClick={() => setAdding((a) => !a)}
        >
          ＋
        </button>
      </div>
      {adding && (
        <form className="explorer-add" onSubmit={submitNew}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="path/to/new-file.ts"
            onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
          />
          {error && <div className="explorer-err">{error}</div>}
        </form>
      )}
      <div className="explorer-tree">
        {tree.map((e) => (
          <TreeNode
            key={e.path}
            entry={e}
            depth={0}
            onOpen={onOpenFile}
            activePath={activePath}
          />
        ))}
      </div>
    </div>
  );
}
