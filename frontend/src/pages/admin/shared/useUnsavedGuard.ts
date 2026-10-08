import { useEffect, useRef } from "react";

/**
 * While a form has unsaved edits: the browser asks before the tab is closed or reloaded, and Ctrl/Cmd+S saves.
 * (The app uses a plain BrowserRouter, so in-app navigation can't be intercepted; the floating bar already shows the state.)
 */
export function useUnsavedGuard(dirty: boolean, save?: () => void) {
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!dirty || !save) return;
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current?.();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [dirty, !!save]);
}
