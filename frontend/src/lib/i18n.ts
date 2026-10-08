/**
 * UI translations. Usage: `const t = useT();  t("Generate videos")`.
 * Keys are the English text itself, so untranslated strings simply show in English.
 * Dictionaries live in ./i18n/{hi,kn,te,ta}.ts (English → language).
 */
import { useSyncExternalStore } from "react";
import hi from "./i18n/hi";
import kn from "./i18n/kn";
import ta from "./i18n/ta";
import te from "./i18n/te";

export const UI_LANGUAGES: Record<string, string> = { en: "English", hi: "हिन्दी", kn: "ಕನ್ನಡ", te: "తెలుగు", ta: "தமிழ்" };
const DICTS: Record<string, Record<string, string>> = { hi, kn, te, ta };

let current = (() => {
  try { return localStorage.getItem("veo-ui-lang") || "en"; } catch { return "en"; }
})();
const listeners = new Set<() => void>();

export function setUiLanguage(lang: string) {
  current = UI_LANGUAGES[lang] ? lang : "en";
  try { localStorage.setItem("veo-ui-lang", current); } catch { /* private mode */ }
  document.documentElement.lang = current;
  listeners.forEach((l) => l());
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

export function useUiLanguage(): string {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => current, () => "en");
}

export function useT() {
  useUiLanguage(); // re-render on change
  return tr;
}
