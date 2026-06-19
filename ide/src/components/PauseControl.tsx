// Project-level pause / resume control for the top header. Pausing gracefully
// suspends every live agent and running service (telling agents to save their
// progress first, then interrupting them, and tearing down compose/tilt stacks)
// and retains everything; Resume brings it all back with a "continue" signal.
// Like a graceful shutdown → startup for the whole project.
export default function PauseControl({
  paused,
  pausingSeconds,
  hasLive,
  onPause,
  onResume,
}: {
  /** This project is currently paused (manifest on disk). */
  paused: boolean;
  /** Countdown while pausing this project (seconds left), or null when idle. */
  pausingSeconds: number | null;
  /** There is at least one live agent/service to pause. */
  hasLive: boolean;
  onPause: () => void;
  onResume: () => void;
}) {
  if (pausingSeconds !== null) {
    return (
      <button className="btn-sm pausing" disabled title="Telling agents to save progress before interrupting them">
        ⏸ Pausing… {pausingSeconds}s
      </button>
    );
  }
  if (paused) {
    return (
      <button
        className="btn-sm primary"
        onClick={onResume}
        title="Resume the project: restart services and tell agents to continue where they left off"
      >
        ▶ Resume project
      </button>
    );
  }
  return (
    <button
      className="btn-sm pause"
      onClick={onPause}
      disabled={!hasLive}
      title={
        hasLive
          ? "Pause the project: ask agents to save progress, interrupt them in 10s, stop services — resume later"
          : "Nothing is running to pause"
      }
    >
      ⏸ Pause project
    </button>
  );
}
