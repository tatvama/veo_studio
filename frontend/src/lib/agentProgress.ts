/**
 * The Director's live progress while a chat turn runs. The backend emits `agent.progress` events (one per tool call,
 * before and after it runs, plus the plan when it changes); lib/live.ts hands them here and the chat panel shows them
 * under its "working" indicator. Kept per project and person, so a teammate's turn never mixes into yours.
 */
import { create } from "zustand";
import type { AgentPlanStep, AgentStep } from "./types";

export interface AgentLive { turn: number; steps: AgentStep[]; plan: AgentPlanStep[] }

const key = (projectId: number, userId: number | null | undefined) => `${projectId}:${userId ?? 0}`;

export const useAgentLive = create<{ byKey: Record<string, AgentLive> }>(() => ({ byKey: {} }));

export function receiveAgentProgress(projectId: number, userId: number | null | undefined, p: Record<string, any>) {
  const k = key(projectId, userId);
  const turn = Number(p.turn) || 0;
  useAgentLive.setState((s) => {
    const prev = s.byKey[k];
    if (prev && prev.turn > turn) return s; // a late event from an earlier turn
    const cur: AgentLive = prev && prev.turn === turn ? prev : { turn, steps: [], plan: [] };
    const steps = [...cur.steps];
    if (typeof p.step === "number" && p.label) steps[p.step] = { tool: String(p.tool ?? ""), label: String(p.label), ok: p.ok ?? null };
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
