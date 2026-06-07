import { CLIS } from "../lib/clis";

// Shown in the main area when no agent is active: quick launchers for each CLI.
// (Continuing past sessions lives in the agents column.)
export default function SessionLauncher({
  onNew,
}: {
  onNew: (title: string, command: string) => void;
}) {
  return (
    <div className="launcher">
      <div className="launcher-actions">
        {CLIS.map((c, i) => (
          <button
            key={c.id}
            className={`launch-card ${i === 1 ? "primary" : ""}`}
            onClick={() => onNew(c.label, c.command)}
          >
            <span className="launch-emph">＋ New {c.label}</span>
            <span className="launch-sub">{c.command || "$SHELL"}</span>
          </button>
        ))}
      </div>
      <p className="launcher-hint">
        Continue a previous session from the Agents panel on the left.
      </p>
    </div>
  );
}
