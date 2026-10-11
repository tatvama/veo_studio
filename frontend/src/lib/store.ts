import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UIState {
  /** The Director panel. Starts closed: it opens when asked for (its button, Ctrl/⌘+J) and the choice is remembered. */
  agentOpen: boolean;
  /** Sidebar: true = labels, false = icons only, null = automatic (labels on wide screens). */
  railExpanded: boolean | null;
  setRailExpanded: (v: boolean | null) => void;
  trayOpen: boolean;
  language: Record<number, string>; // per project
  episode: Record<number, number>; // per project
  selectedShot: number | null;
  setAgentOpen: (v: boolean) => void;
  toggleAgent: () => void;
  setTrayOpen: (v: boolean) => void;
  setLanguage: (pid: number, lang: string) => void;
  setEpisode: (pid: number, eid: number) => void;
  setSelectedShot: (id: number | null) => void;
  // ── v2 shell (not persisted) ──
  /** Global command palette (Ctrl/⌘+K). */
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  /** Keyboard-shortcuts sheet ("?"). */
  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
  /** Bumped to (re)start the onboarding tour; 0 = not requested this session. */
  tourRun: number;
  startTour: () => void;
}

type Persisted = Pick<UIState, "agentOpen" | "railExpanded" | "language" | "episode">;

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      agentOpen: false,
      railExpanded: null,
      setRailExpanded: (v) => set({ railExpanded: v }),
      trayOpen: false,
      language: {},
      episode: {},
      selectedShot: null,
      setAgentOpen: (v) => set({ agentOpen: v }),
      toggleAgent: () => set((s) => ({ agentOpen: !s.agentOpen })),
      setTrayOpen: (v) => set({ trayOpen: v }),
      setLanguage: (pid, lang) => set((s) => ({ language: { ...s.language, [pid]: lang } })),
      setEpisode: (pid, eid) => set((s) => ({ episode: { ...s.episode, [pid]: eid } })),
      setSelectedShot: (id) => set({ selectedShot: id }),
      paletteOpen: false,
      setPaletteOpen: (v) => set({ paletteOpen: v }),
      shortcutsOpen: false,
      setShortcutsOpen: (v) => set({ shortcutsOpen: v }),
      tourRun: 0,
      startTour: () => set((s) => ({ tourRun: s.tourRun + 1, paletteOpen: false, shortcutsOpen: false })),
    }),
    {
      name: "veo-ui",
      version: 1,
      // v1: the Director used to open with every project and squeeze the page; close it once for everyone
      migrate: (s, v) => ({ ...(s as Persisted), ...(v < 1 ? { agentOpen: false } : {}) }),
      partialize: (s): Persisted => ({ agentOpen: s.agentOpen, railExpanded: s.railExpanded, language: s.language, episode: s.episode }),
    },
  ),
);
