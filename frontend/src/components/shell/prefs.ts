/**
 * User preferences (/api/me/prefs) — theme, UI language, motion, onboarding.
 * Changes apply locally at once and are PATCHed to the server; changes made while signed out
 * (Login page) are queued in sessionStorage and pushed right after sign-in.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../../lib/api";
import { useCurrency, type CurrencyMode } from "../../lib/currency";
import { getUiLanguage, setUiLanguage, UI_LANGUAGES } from "../../lib/i18n";
import type { Prefs } from "../../lib/types";
import { applyMotionPref, applyThemePref, getMotionPref, getThemePref, type MotionPref, type ThemePref } from "./theme";

const PENDING_KEY = "veo-pending-prefs";

function readPending(): Prefs {
  try { return JSON.parse(sessionStorage.getItem(PENDING_KEY) || "{}") as Prefs; } catch { return {}; }
}
function writePending(p: Prefs) {
  try {
    if (Object.keys(p).length) sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch { /* private mode */ }
}

/** Same cache entry as usePrefs() in lib/queries, but can be disabled while signed out. */
export function usePrefsQuery(enabled = true) {
  return useQuery({ queryKey: ["prefs"], queryFn: () => api.get<Prefs>("/api/me/prefs", { silent: true }), staleTime: 60_000, enabled });
}

export function useSavePrefs(signedIn: boolean) {
  const qc = useQueryClient();
  return useCallback(async (patch: Prefs) => {
    if (!signedIn) {
      writePending({ ...readPending(), ...patch });
      return;
    }
    qc.setQueryData<Prefs>(["prefs"], (old) => ({ ...(old ?? {}), ...patch }));
    try {
      const saved = await api.patch<Prefs>("/api/me/prefs", patch);
      if (saved && typeof saved === "object") qc.setQueryData(["prefs"], saved);
    } catch { /* api helper already toasted; local choice still applies */ }
  }, [qc, signedIn]);
}

/** Setters used by the user menu, command palette and login page. */
export function usePrefActions(signedIn: boolean) {
  const save = useSavePrefs(signedIn);
  return {
    setTheme: (theme: ThemePref) => { applyThemePref(theme); void save({ theme }); },
    setLanguage: (ui_language: string) => { setUiLanguage(ui_language); void save({ ui_language }); },
    setMotion: (motion: MotionPref) => { applyMotionPref(motion); void save({ motion }); },
    setCurrency: (currency: CurrencyMode) => { useCurrency.getState().setMode(currency); void save({ currency }); },
    setOnboardingDone: (onboarding_done: boolean) => save({ onboarding_done }),
  };
}

/**
 * Mount once inside the signed-in tree. On first load of the server prefs it pushes anything chosen on the
 * login page, then applies the server's theme / language / motion for everything else.
 */
export function PrefsSync() {
  const { data } = usePrefsQuery(true);
  const save = useSavePrefs(true);
  const done = useRef(false);
  useEffect(() => {
    if (!data || done.current) return;
    done.current = true;
    const pending = readPending();
    writePending({});
    if (Object.keys(pending).length) void save(pending);
    if (!pending.theme && data.theme && data.theme !== getThemePref()) applyThemePref(data.theme);
    if (!pending.ui_language && data.ui_language && UI_LANGUAGES[data.ui_language] && data.ui_language !== getUiLanguage()) {
      setUiLanguage(data.ui_language);
    }
    if (!pending.motion && data.motion && data.motion !== getMotionPref()) applyMotionPref(data.motion);
    if (!pending.currency && data.currency && data.currency !== useCurrency.getState().mode) useCurrency.getState().setMode(data.currency);
  }, [data, save]);
  return null;
}
