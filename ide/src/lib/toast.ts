// Tiny global error-toast bus. Anywhere in the app can report a failed
// operation with `toastError("Couldn't spawn agent", err)`; NotificationCenter
// subscribes and surfaces it as a toast + inbox entry. This replaces the
// silent `.catch(() => {})` pattern for user-initiated actions — polling
// failures should stay quiet, but a click that did nothing must say why.

export interface AppToast {
  /** What the user tried to do, e.g. "Couldn't spawn agent". */
  title: string;
  /** The underlying error, stringified for display. */
  detail?: string;
  at: number;
}

type Listener = (t: AppToast) => void;
const listeners = new Set<Listener>();

export function onToast(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Report a failed user action. `err` accepts anything a catch clause yields. */
export function toastError(title: string, err?: unknown): void {
  const detail =
    err === undefined || err === null
      ? undefined
      : typeof err === "string"
        ? err
        : err instanceof Error
          ? err.message
          : String(err);
  const t: AppToast = { title, detail, at: Date.now() };
  for (const cb of listeners) cb(t);
}
