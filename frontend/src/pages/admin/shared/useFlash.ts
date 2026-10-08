import { useCallback, useEffect, useRef, useState } from "react";

/** `[on, trigger]` — `on` is true for `ms` milliseconds after `trigger()` (used for "Saved ✓" confirmations). */
export function useFlash(ms = 2200): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const trigger = useCallback(() => {
    window.clearTimeout(timer.current);
    setOn(true);
    timer.current = window.setTimeout(() => setOn(false), ms);
  }, [ms]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [on, trigger];
}
