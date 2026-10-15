/**
 * UI translations. Usage: `const t = useT();  t("Generate videos")`.
 * Keys are the English text itself, so untranslated strings simply show in English.
 * Dictionaries live in ./i18n/{hi,kn,te,ta}.ts (English → language) and are loaded on demand: they are ~880 KB of
 * source, so they stay out of the start-up bundle. Until a dictionary has arrived the UI renders English, then every
 * subscriber re-renders.
 */
import { useSyncExternalStore } from "react";

type Dict = Record<string, string>;

export const UI_LANGUAGES: Record<string, string> = { en: "English", hi: "हिन्दी", kn: "ಕನ್ನಡ", te: "తెలుగు", ta: "தமிழ்" };
const LOADERS: Record<string, () => Promise<{ default: Dict }>> = {
  hi: () => import("./i18n/hi"),
  kn: () => import("./i18n/kn"),
  ta: () => import("./i18n/ta"),
  te: () => import("./i18n/te"),
};
const DICTS: Record<string, Dict> = {};
const loading: Record<string, Promise<void> | undefined> = {};

let current = (() => {
  try { return localStorage.getItem("veo-ui-lang") || "en"; } catch { return "en"; }
})();
if (!UI_LANGUAGES[current]) current = "en";
/** Bumped whenever translations may read differently (language change, dictionary arrived): what useT subscribes to. */
let revision = 0;
const listeners = new Set<() => void>();
const notify = () => {
  revision++;
  listeners.forEach((l) => l());
};

/** Fetches a dictionary once; resolves when it is in DICTS (or failed, in which case English stays). */
export function loadUiLanguage(lang: string): Promise<void> {
  const load = LOADERS[lang];
  if (!load || DICTS[lang]) return Promise.resolve();
  return (loading[lang] ??= load()
    .then((m) => {
      DICTS[lang] = m.default;
      if (current === lang) notify();
    })
    .catch(() => { loading[lang] = undefined; }));
}

export function setUiLanguage(lang: string) {
  current = UI_LANGUAGES[lang] ? lang : "en";
  try { localStorage.setItem("veo-ui-lang", current); } catch { /* private mode */ }
  document.documentElement.lang = current;
  notify();
  void loadUiLanguage(current);
}

export function getUiLanguage() {
  return current;
}

/** Translate outside React (toasts etc.). Supports {name} placeholders. */
export function tr(text: string, vars?: Record<string, string | number>): string {
  let out = (current !== "en" && DICTS[current]?.[text]) || text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

export function useUiLanguage(): string {
  return useSyncExternalStore(subscribe, () => current, () => "en");
}

export function useT() {
  useSyncExternalStore(subscribe, () => revision, () => 0); // re-render on a language change or when its dictionary arrives
  return tr;
}

// A stored non-English language: fetch its dictionary at start-up (the UI shows English until it arrives).
if (current !== "en") void loadUiLanguage(current);
