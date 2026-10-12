/**
 * The paid AI tools for assistants (docs/EDITOR.md §13.2, §8): the editor's own flows (editor/ai/tools.ts) run here,
 * so they are priced first and the price shows in the app as a proposal. Without the "spend" scope (or approve: true)
 * the user decides there; with it, the assistant's approval goes through only when every budget allows it. The job's
 * progress goes back to the main process (assistants.jobUpdate) for job_status.
 */
import { toolsInfo } from "../../editor/ai/api";
import { useAi } from "../../editor/ai/store";
import { captions, cleanVoice, dub, getLastCaptions, music, soundEffect, translateCaptions, voiceOver } from "../../editor/ai/tools";
import { makeHost } from "../../editor/host";
import { secondsToFrames } from "../../editor/model/time";
import { program } from "../../editor/playback/transport";
import { seq } from "../../editor/store";
import type { AssistantCall } from "../../lib/desktop";
import { assistantsBridge, errText } from "../api";

type Args = Record<string, unknown>;
interface PageReply { text: string; data?: Record<string, unknown> }

const TOOLS: { id: string; flow: string; what: string }[] = [
  { id: "captions", flow: "Captions", what: "speech to text onto a caption track (Gemini listening, Google first)" },
  { id: "translate_captions", flow: "Translate captions", what: "the last captions into other languages (Claude)" },
  { id: "voice_over", flow: "AI voice-over", what: "text to a voice clip at the playhead" },
  { id: "music", flow: "Music", what: "music to a length, on a new track under the dialogue" },
  { id: "sound_effect", flow: "Sound effect", what: "a sound effect at the playhead" },
  { id: "clean_voice", flow: "Clean up voice", what: "the voice isolated from noise and music" },
  { id: "dub", flow: "Dub into", what: "a clip dubbed into another language on a new track" },
];

export async function aiToolsInfo(): Promise<PageReply> {
  const host = makeHost();
  const pid = host.studioProjectId();
  const list = TOOLS.map((t) => `${t.id}: ${t.what}`).join("\n");
  if (!pid) return { text: `${list}\nThis edit has no studio project yet: the first AI run makes one (it carries the costs, budgets and approvals). Every run is priced first.`,
    data: { tools: TOOLS.map((t) => ({ id: t.id, what: t.what })), studio_project: null } };
  const info = await toolsInfo(pid).catch(() => null);
  const modes = new Map((info?.tools ?? []).map((t) => [t.id, t.mode]));
  return { text: `${list}\nStudio project ${pid}${info ? `; modes: ${[...modes].map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}. Every run is priced first.`,
    data: { tools: TOOLS.map((t) => ({ id: t.id, what: t.what })), studio_project: pid, modes: Object.fromEntries(modes), google_first: info?.google_first ?? null } };
}

/** Starts one flow; returns at once. The job ends when the flow does (approved and applied, declined, or failed). */
export function runAiTool(a: Args, call: AssistantCall): PageReply {
  const tool = String(a.tool ?? "");
  const def = TOOLS.find((t) => t.id === tool);
  if (!def) throw new Error(`Unknown AI tool ${tool}`);
  const args = (a.args && typeof a.args === "object" ? a.args : {}) as Args;
  const jobId = String(a.job_id ?? "");
  const approve = Boolean(a.approve) && call.scopes.includes("spend");
  const bridge = assistantsBridge();
  const update = (p: { status?: string; progress?: number; message?: string; result?: unknown; error?: string }) => { if (jobId) void bridge?.jobUpdate(jobId, p).catch(() => undefined); };
  const host = makeHost();
  const s = seq();
  const clipIds = Array.isArray(args.clip_ids) ? args.clip_ids.filter((x): x is string => typeof x === "string") : [];
  if (typeof args.at === "number") program.seek(secondsToFrames(Math.max(0, args.at), s.fps));
  const title = tool === "dub" ? `Dub into ${String(args.target ?? "")}` : def.flow;
  const before = new Set(useAi.getState().runs.map((r) => r.id));
  let runId: string | null = null;
  let last = { status: "", message: "", progress: 0, error: "" };
  const unsub = useAi.subscribe((st) => {
    const ask = st.ask;
    if (ask && ask.kind === "price" && ask.title.startsWith(def.flow)) {
      const ok = ask.budgets.every((b) => b.ok);
      if (approve && ok) { ask.resolve(true); update({ status: "running", message: `Approved by ${call.client} within budgets ($${ask.amount.toFixed(2)})` }); }
      else update({ status: "awaiting_approval", message: `Waiting in Tatvam for the user to approve $${ask.amount.toFixed(2)}${approve && !ok ? " (a budget needs a producer)" : ""}` });
    }
    const run = runId ? st.runs.find((r) => r.id === runId) : st.runs.find((r) => !before.has(r.id) && r.title.startsWith(def.flow));
    if (run) {
      runId = run.id;
      if (run.status !== last.status || run.message !== last.message) {
        last = { status: run.status, message: run.message, progress: run.progress, error: run.error ?? "" };
        update({ status: run.status === "awaiting_approval" ? "awaiting_approval" : ["done", "failed", "cancelled"].includes(run.status) ? undefined : "running",
          progress: run.progress, message: run.message });
      }
    }
  });
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const go = async (): Promise<unknown> => {
    switch (tool) {
      case "captions": return captions(host, { clipIds: clipIds.length ? clipIds : undefined, language: typeof args.language === "string" ? args.language : "auto" });
      case "translate_captions": {
        const src = getLastCaptions();
        if (!src) throw new Error("Make captions first (run_ai_tool captions): translation starts from them");
        return translateCaptions(host, src, (Array.isArray(args.languages) ? args.languages : []).map(String));
      }
      case "voice_over": return voiceOver(host, { text: String(args.text ?? ""), language: typeof args.language === "string" ? args.language : "en", voice: {} });
      case "music": return music(host, { prompt: String(args.prompt ?? ""), seconds: n(args.seconds, 30), at: secondsToFrames(n(args.at, 0), s.fps), volumeDb: n(args.volume_db, -18) });
      case "sound_effect": return soundEffect(host, { prompt: String(args.prompt ?? ""), seconds: n(args.seconds, 3) });
      case "clean_voice": return cleanVoice(host, clipIds);
      case "dub": if (!clipIds[0]) throw new Error("Give the clip to dub (clip_ids)"); return dub(host, clipIds[0], { target: String(args.target ?? "hi") });
    }
    return undefined;
  };
  update({ status: "running", message: "Pricing" });
  void go().then(() => {
    const run = runId ? useAi.getState().runs.find((r) => r.id === runId) : undefined;
    const st = run?.status ?? (last.status || "cancelled");
    if (st === "done") update({ status: "done", progress: 1, message: "Done: the result is in the edit", result: { text: `${title}: done, the result is in the edit` } });
    else if (st === "failed") update({ status: "failed", error: run?.error || last.error || "failed" });
    else update({ status: "cancelled", message: "The user declined it (or closed the price)" });
  }).catch((e) => update({ status: "failed", error: errText(e) })).finally(() => unsub());
  return { text: `${title}: priced and shown to the user in Tatvam as a proposal${approve ? "; approving it for you if every budget allows" : "; they approve it there"}.`,
    data: { tool, approve, title } };
}
