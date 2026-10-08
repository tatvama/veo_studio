import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { tr } from "../../lib/i18n";
import { useCharacters, useJobs } from "../../lib/queries";
import type { Character, ConsentRow, ContinuityReport, Job, Script, VoiceProfile } from "../../lib/types";

// ── character colours ────────────────────────────────────────────────────────
// Hues are rotated from the theme's accent-ink token (CSS relative colour syntax), so they follow light/dark themes
// and stay readable on both (accent-ink is the deeper orange in the light theme).
// Browsers without relative-colour support fall back to the `text-accent-ink` class.
const HUES = [0, 150, 215, 55, 285, 335, 105, 250, 185, 25];

export interface Tone { className: string; style?: CSSProperties; soft?: CSSProperties }

export function toneForIndex(i: number): Tone {
  const hue = HUES[((i % HUES.length) + HUES.length) % HUES.length];
  return {
    className: "text-accent-ink",
    style: { color: `oklch(from var(--color-accent-ink) l c calc(h + ${hue}))` },
    soft: { backgroundColor: `oklch(from var(--color-accent) l c calc(h + ${hue}) / 0.16)` },
  };
}

export const NARRATOR_TONE: Tone = { className: "text-mute" };

/** Stable colour per name, in order of first appearance (so the first few speakers never collide). */
export function makeToneMap(keys: (string | number | null | undefined)[]): (key: string | number | null | undefined) => Tone {
  const order = new Map<string, number>();
  for (const k of keys) {
    const n = norm(k);
    if (n && n !== "narrator" && !order.has(n)) order.set(n, order.size);
  }
  return (key) => {
    const n = norm(key);
    if (!n || n === "narrator") return NARRATOR_TONE;
    if (!order.has(n)) order.set(n, order.size);
    return toneForIndex(order.get(n)!);
  };
}

/**
 * Same idea as makeToneMap, but the project's cast comes first (in cast order), so a character has the same colour in the
 * script editor, the table read and the scene cards. Names that aren't in the cast follow in order of first appearance.
 */
export function useCastTones(pid: number, appearing: (string | null | undefined)[] = []): (key: string | number | null | undefined) => Tone {
  const { data: cast } = useCharacters(pid);
  const seen = appearing.join("\u0001");
  const castKey = (cast ?? []).map((c) => c.name).join("\u0001");
  return useMemo(() => {
    const order = new Map<string, number>();
    (cast ?? []).forEach((c) => { const n = norm(c.name); if (n && !order.has(n)) order.set(n, order.size); });
    for (const k of appearing) {
      const n = norm(k);
      if (n && n !== "narrator" && !order.has(n)) order.set(n, order.size);
    }
    return (key: string | number | null | undefined) => {
      const n = norm(key);
      if (!n || n === "narrator") return NARRATOR_TONE;
      if (!order.has(n)) order.set(n, order.size);
      return toneForIndex(order.get(n)!);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [castKey, seen]);
}

function norm(k: string | number | null | undefined) {
  return String(k ?? "").trim().toLowerCase();
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || "?").slice(0, 2)).toUpperCase();
}

// ── jobs ─────────────────────────────────────────────────────────────────────

const ACTIVE = new Set(["proposed", "queued", "running", "awaiting_approval"]);

/** Active jobs for this project that match — used to show progress for jobs started from these pages. */
export function useActiveJobs(pid: number | undefined, match: (j: Job) => boolean): Job[] {
  const { data } = useJobs(pid);
  return (data ?? []).filter((j) => ACTIVE.has(j.status) && match(j));
}

// ── consents (producer-only endpoint, fetched silently) ─────────────────────

export const useConsentRows = (enabled: boolean) =>
  useQuery({ queryKey: ["consents"], queryFn: () => api.get<ConsentRow[]>("/api/consents", { silent: true }), enabled });

// ── script → plain lines (for version diffs) ─────────────────────────────────

export function scriptToLines(s: Script | undefined | null): string[] {
  const out: string[] = [];
  if (!s) return out;
  if (s.logline) out.push(`LOGLINE: ${s.logline}`);
  (s.beats || []).forEach((b, i) => out.push(`BEAT ${i + 1}: ${b}`));
  (s.scenes || []).forEach((sc, i) => {
    out.push("");
    out.push(`SCENE ${i + 1}: ${sc.title || ""}${sc.location ? ` — ${sc.location}` : ""}${sc.time_of_day ? ` (${sc.time_of_day})` : ""}`);
    if (sc.summary) out.push(sc.summary);
    if (sc.action) out.push(`[${sc.action}]`);
    for (const l of sc.lines || []) out.push(`${l.character || "?"}${l.emotion ? ` (${l.emotion})` : ""}: ${l.line}`);
  });
  return out;
}

export function scoreTone(v: number | undefined | null, bar = 7.5): "ok" | "warn" | "bad" {
  if (v === undefined || v === null) return "warn";
  if (v >= bar) return "ok";
  if (v >= bar - 2.5) return "warn";
  return "bad";
}

/** Status colours for big numbers, icons and bars. */
export const TONE_TEXT = { ok: "text-ok", warn: "text-warn", bad: "text-bad" } as const;
/** Status colours for small text: these shades are remapped in the light theme so they keep their contrast there. */
export const TONE_TEXT_SM = { ok: "text-green-300", warn: "text-amber-300", bad: "text-red-300" } as const;
export const TONE_STROKE = { ok: "stroke-ok", warn: "stroke-warn", bad: "stroke-bad" } as const;
export const TONE_BG = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" } as const;
export const TONE_VAR = { ok: "var(--color-ok)", warn: "var(--color-warn)", bad: "var(--color-bad)" } as const;

/** A rough speaking time for a script: ~2.5 words per second. */
export function spokenSeconds(s: Script | undefined | null): number {
  let words = 0;
  for (const sc of s?.scenes ?? []) for (const l of sc.lines ?? []) words += (l.line || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.round(words / 2.5);
}


// ── identity + consent ───────────────────────────────────────────────────────

type IdStatus = NonNullable<Character["identity"]["status"]>;
export const IDENTITY_STATUS: Record<IdStatus | "none", { label: string; tone: "neutral" | "info" | "ok" | "bad" }> = {
  none: { label: "Not trained", tone: "neutral" },
  preparing: { label: "Preparing", tone: "info" },
  training: { label: "Training", tone: "info" },
  ready: { label: "Ready", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Stopped", tone: "neutral" },
};

/** Whether this character needs a consent record (uploaded real-person photos or an external ElevenLabs voice). */
export function consentNeeds(c: Character) {
  const photos = (c.assets ?? []).filter((a) => a.kind === "source" && !a.archived);
  const external = ((c.voices ?? []) as VoiceProfile[]).filter((v) => typeof v === "object" && v.provider === "elevenlabs" && !v.description);
  return { photos, external, any: photos.length > 0 || external.length > 0 };
}

// ── keyboard + focus helpers ─────────────────────────────────────────────────

/**
 * Arrow-key movement for a `role="radiogroup"` made of buttons: put `onKeyDown={radioKeys}` (or `radioKeys(false)` to only move focus
 * and leave choosing to Space/Enter) on the group.
 */
export function radioKeys(arg: ReactKeyboardEvent<HTMLElement> | boolean): ((e: ReactKeyboardEvent<HTMLElement>) => void) | void {
  const handle = (e: ReactKeyboardEvent<HTMLElement>, choose: boolean) => {
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key)) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0 || items.length < 2) return;
    e.preventDefault();
    const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
    const next = items[(i + (fwd ? 1 : -1) + items.length) % items.length];
    next.focus();
    if (choose) next.click();
  };
  if (typeof arg === "boolean") return (e) => handle(e, arg);
  handle(arg, true);
}

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Focus handling for custom dialogs (drawers, lightboxes): moves focus inside on open, keeps Tab in the dialog while focus is
 * in it, and hands focus back to whatever opened it. Mark the element to focus first with `data-autofocus`.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const id = window.setTimeout(() => {
      const root = ref.current;
      if (!root || root.contains(document.activeElement)) return;
      (root.querySelector<HTMLElement>("[data-autofocus]") ?? root.querySelector<HTMLElement>(FOCUSABLE) ?? root).focus({ preventScroll: true });
    }, 30);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const root = ref.current;
      if (!root || !root.contains(document.activeElement)) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("keydown", key);
      previous?.focus?.({ preventScroll: true });
    };
  }, [active, ref]);
}

/** Ctrl/⌘+S runs `save` while `enabled` (always calls the latest closure and suppresses the browser's own save dialog). */
export function useSaveShortcut(enabled: boolean, save: () => void) {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        latest.current();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [enabled]);
}

// ── continuity ───────────────────────────────────────────────────────────────

/** Runs the (synchronous) continuity check; the report persists on Episode.continuity. */
export function useContinuityCheck(eid: number) {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    try {
      const r = await api.post<ContinuityReport>(`/api/episodes/${eid}/continuity`);
      await qc.invalidateQueries({ queryKey: ["episode", eid] });
      const n = r.issues?.length ?? 0;
      if (!n) toast.success(tr("Continuity check passed — no issues found"));
      else toast.warning(tr("Continuity check found {n} issue(s)", { n }));
    } catch { /* api toasts */ } finally { setRunning(false); }
  };
  return { run, running };
}
