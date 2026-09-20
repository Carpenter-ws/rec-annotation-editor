import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

/** Distinct home/canvas URLs without reloading the application bundle. */
export function usePageHistory(
  restore: MutableRefObject<(url: URL) => void>,
  dirty: MutableRefObject<boolean>,
) {
  const position = useRef(0);
  const restoring = useRef(false);
  const record = useCallback((url: string, replace = false) => {
    const current = window.location.pathname + window.location.search;
    if (url === current) return;
    if (!replace) position.current += 1;
    window.history[replace ? "replaceState" : "pushState"](
      { ...window.history.state, recPosition: position.current }, "", url,
    );
  }, []);
  useEffect(() => {
    position.current = window.history.state?.recPosition ?? 0;
    window.history.replaceState({ ...window.history.state, recPosition: position.current }, "");
    const pop = () => {
      if (restoring.current) { restoring.current = false; return; }
      const next = window.history.state?.recPosition ?? 0;
      if (dirty.current && !window.confirm("Discard unsaved changes and leave this page?")) {
        restoring.current = true;
        window.history.go(position.current - next);
        return;
      }
      position.current = next;
      restore.current(new URL(window.location.href));
    };
    window.addEventListener("popstate", pop);
    restore.current(new URL(window.location.href));
    return () => window.removeEventListener("popstate", pop);
  }, [dirty, restore]);
  return record;
}
