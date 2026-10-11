/**
 * The Director's live progress while a chat turn runs. The backend emits `agent.progress` events (one per tool call,
 * before and after it runs, plus the plan when it changes); lib/live.ts hands them here and the chat panel shows them
 * under its "working" indicator. Kept per project and person, so a teammate's turn never mixes into yours.
 */
import { create } from "zustand";
import type { AgentPlanStep, AgentStep } from "./types";

export interface AgentLive { turn: number; steps: AgentStep[]; plan: AgentPlanStep[] }

const key = (projectId: number, userId: number | null | undefined) => `${projectId}:${userId ?? 0}`;
/** Tool calls one turn can show (a turn makes at most 30 model calls); a step number past this is ignored. */
const MAX_LIVE_STEPS = 200;

export const useAgentLive = create<{ byKey: Record<string, AgentLive> }>(() => ({ byKey: {} }));

export function receiveAgentProgress(projectId: number, userId: number | null | undefined, p: Record<string, any>) {
  const k = key(projectId, userId);
  const turn = Number(p.turn) || 0;
  useAgentLive.setState((s) => {
    const prev = s.byKey[k];
    if (prev && prev.turn > turn) return s; // a late event from an earlier turn
    const cur: AgentLive = prev && prev.turn === turn ? prev : { turn, steps: [], plan: [] };
    const i = typeof p.step === "number" ? p.step : -1;
    const item: AgentStep = { tool: String(p.tool ?? ""), label: String(p.label ?? ""), ok: p.ok ?? null };
    // rebuilt by position rather than written at the event's index, so a bad step number can't add odd keys or a huge list
    const steps = Number.isInteger(i) && i >= 0 && i < MAX_LIVE_STEPS && p.label
      ? Array.from({ length: Math.max(cur.steps.length, i + 1) }, (_, j) => (j === i ? item : cur.steps[j]))
      : cur.steps;
    const plan = Array.isArray(p.plan) ? (p.plan as AgentPlanStep[]) : cur.plan;
    return { byKey: { ...s.byKey, [k]: { turn, steps, plan } } };
  });
}

export function clearAgentProgress(projectId: number, userId: number | null | undefined) {
  useAgentLive.setState((s) => {
    const { [key(projectId, userId)]: _gone, ...rest } = s.byKey;
    return { byKey: rest };
  });
}

/** This person's live progress in the project, for the turn after message `afterId` (null before it starts). */
export function useMyAgentLive(projectId: number, userId: number | null | undefined, afterId: number | null): AgentLive | null {
  const live = useAgentLive((s) => s.byKey[key(projectId, userId)]);
  if (!live || afterId === null || live.turn <= afterId) return null;
  return { ...live, steps: live.steps.filter(Boolean) };
}
