import { useEffect, useState } from "react";
import { useUiLanguage } from "../../lib/i18n";

export type Tone = "neutral" | "accent" | "money" | "ai" | "ok" | "warn" | "bad" | "info";

/** A Date that refreshes on an interval (greeting, clock). */
export function useNow(every = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), every);
    return () => window.clearInterval(id);
  }, [every]);
  return now;
}

/** "Sairam" from "Sairam Kumar" or from the part of the email before the @. */
export function firstName(u: { name?: string | null; email?: string | null } | null | undefined): string {
  const n = (u?.name ?? "").trim().split(/\s+/)[0];
  return n || (u?.email ?? "").split("@")[0] || "";
}

/** Date and clock in the UI language ("Friday 9 October", "21:14"). Falls back to the browser locale when the tag is unknown. */
export function useClock(now: Date): { date: string; time: string } {
  const lang = useUiLanguage();
  const fmt = (loc: string | undefined) => ({
    date: now.toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long" }),
    time: now.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", hour12: false }),
  });
  try { return fmt(`${lang}-IN`); } catch { return fmt(undefined); }
}

/** Per-week counts for the last `weeks` weeks (oldest first), from a list of ISO dates. Feeds a sparkline. */
export function weeklyCounts(dates: string[], weeks = 8): number[] {
  const out = Array.from({ length: weeks }, () => 0);
  const now = Date.now();
  const WEEK = 7 * 86_400_000;
  for (const d of dates) {
    const age = Math.floor((now - new Date(d).getTime()) / WEEK);
    if (age >= 0 && age < weeks) out[weeks - 1 - age] += 1;
  }
  return out;
}
