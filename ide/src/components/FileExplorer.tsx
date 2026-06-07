import { useEffect, useState } from "react";
import { readDir, type FileEntry } from "../lib/tauri";

// A lazily-expanding directory node (VS Code-style explorer).
function TreeNode({
  entry,
  depth,
  onOpen,
  activePath,
}: {
  entry: FileEntry;
  depth: number;
  onOpen: (e: FileEntry) => void;
  activePath: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);

  const toggle = () => {
    if (entry.is_dir) {
      const next = !open;
      setOpen(next);
      if (next && children === null) {
        readDir(entry.path).then(setChildren).catch(() => setChildren([]));
      }
    } else {
      onOpen(entry);
    }
  };

  return (
    <>
      <button
        className={`tree-row ${entry.is_dir ? "is-dir" : "is-file"} ${
          activePath === entry.path ? "active" : ""
        }`}
        style={{ paddingLeft: 8 + depth * 13 }}
        onClick={toggle}
        title={entry.name}
      >
        <span className="tree-chevron">
          {entry.is_dir ? (open ? "▾" : "▸") : ""}
        </span>
        <span className="tree-glyph">{entry.is_dir ? (open ? "📂" : "📁") : "📄"}</span>
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
  onOpenFile: (e: FileEntry) => void;
  activePath: string | null;
}) {
  const [tree, setTree] = useState<FileEntry[]>([]);

  useEffect(() => {
    readDir(root).then(setTree).catch(() => setTree([]));
  }, [root]);

  return (
    <div className="explorer">
      <div className="explorer-head">Explorer</div>
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
