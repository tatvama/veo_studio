/**
 * The AI tools' shared state: the runs in progress (started from the panel or a clip's context menu) and the one
 * question on screen (a price to confirm, a list to review, a line of text). dialogs.tsx draws the questions.
 */
import { create } from "zustand";
import type { Budget, CostLine } from "./types";

export type RunStatus = "preparing" | "uploading" | "pricing" | "queued" | "running" | "awaiting_approval" | "applying" | "done" | "failed" | "cancelled";

export interface AiRun {
  id: string; title: string; status: RunStatus; progress: number; message: string; usd: number;
  pid?: number; jobIds: number[]; error?: string; at: number;
}

export interface PriceAsk { kind: "price"; title: string; amount: number; lines: CostLine[]; budgets: Budget[]; note?: string; resolve(ok: boolean): void }
export interface ChoiceAsk {
  kind: "choice"; title: string; note?: string; items: { id: string; label: string; detail?: string; checked: boolean }[];
  multiple: boolean; confirmLabel: string; resolve(ids: string[] | null): void;
}
export interface TextAsk { kind: "text"; title: string; label: string; placeholder?: string; initial?: string; confirmLabel: string; resolve(text: string | null): void }
export type Ask = PriceAsk | ChoiceAsk | TextAsk;

interface AiState {
  runs: AiRun[];
  ask: Ask | null;
  upsert(r: Partial<AiRun> & { id: string }): void;
  dismiss(id: string): void;
  clearDone(): void;
}

export const useAi = create<AiState>((set) => ({
  runs: [],
  ask: null,
  upsert: (r) => set((s) => {
    const i = s.runs.findIndex((x) => x.id === r.id);
    if (i < 0) {
      const run: AiRun = { title: "", status: "preparing", progress: 0, message: "", usd: 0, jobIds: [], at: Date.now(), ...r };
      return { runs: [run, ...s.runs].slice(0, 40) };
    }
    const runs = [...s.runs];
    runs[i] = { ...runs[i], ...r };
    return { runs };
  }),
  dismiss: (id) => set((s) => ({ runs: s.runs.filter((x) => x.id !== id) })),
  clearDone: () => set((s) => ({ runs: s.runs.filter((x) => !["done", "failed", "cancelled"].includes(x.status)) })),
}));

const queue: (() => void)[] = [];

/** One question at a time: the next waits for the one on screen. */
function show(make: (done: () => void) => Ask) {
  const open = () => useAi.setState({ ask: make(() => { useAi.setState({ ask: null }); queue.shift()?.(); }) });
  if (useAi.getState().ask) queue.push(open); else open();
}

/** The price first (CostConfirm). Free runs within every budget start without asking. */
export function askPrice(title: string, amount: number, lines: CostLine[], budgets: Budget[], note?: string): Promise<boolean> {
  if (amount <= 0 && budgets.every((b) => b.ok)) return Promise.resolve(true);
  return new Promise((resolve) => show((done) => ({ kind: "price", title, amount, lines, budgets, note, resolve: (ok) => { done(); resolve(ok); } })));
}

export function askChoice(opts: Omit<ChoiceAsk, "kind" | "resolve">): Promise<string[] | null> {
  return new Promise((resolve) => show((done) => ({ kind: "choice", ...opts, resolve: (ids) => { done(); resolve(ids); } })));
}

export function askText(opts: Omit<TextAsk, "kind" | "resolve">): Promise<string | null> {
  return new Promise((resolve) => show((done) => ({ kind: "text", ...opts, resolve: (t) => { done(); resolve(t); } })));
}
