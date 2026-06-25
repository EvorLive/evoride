import { useEffect, useState } from "react";

/** True when the viewport is phone-sized. Drives the dedicated mobile layout
 *  used by the daemon-served web IDE (the desktop Tauri app is always wide).
 *  Matches the `@media (max-width: 820px)` breakpoint in App.css. */
export function useIsMobile(breakpoint = 820): boolean {
  const query = `(max-width: ${breakpoint}px)`;
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const on = () => setIsMobile(mql.matches);
    on();
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, [query]);
  return isMobile;
}
