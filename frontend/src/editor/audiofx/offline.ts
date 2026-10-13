/**
 * Renders a signal through the preview's own effect chain in an OfflineAudioContext: the measurements of the preview
 * against the export (FFmpeg) use it, exposed as `window.__tatvamAudio` when the editor's debug flag is on
 * (localStorage "tatvam-editor:debug" = "1").
 */
import { fxEnv, FxChain, type Values } from "./graph";
import { resolveParams } from "./registry";

const IR_PARAMS: Record<string, (v: Values) => string[]> = {
  reverb: (v) => [String(v.preset ?? "room")], next_room: () => ["room"], guitar_amp: (v) => [String(v.cabinet ?? "cab_4x12")],
};

/** `input` channels (stereo) through `effects` in order; returns the output channels (same length + `tail` seconds). */
export async function renderOffline(input: Float32Array[], sampleRate: number, effects: { id: string; values?: Values }[], tail = 0): Promise<Float32Array[]> {
  const n = input[0].length + Math.round(tail * sampleRate);
  const ctx = new OfflineAudioContext(2, n, sampleRate);
  const env = fxEnv(ctx);
  await env.ready;
  const items = effects.map((e, i) => ({ key: `fx${i}`, id: e.id, values: resolveParams(e.id, e.values ?? {}) as Values }));
  for (const it of items) for (const name of IR_PARAMS[it.id]?.(it.values) ?? []) if (name !== "none") await env.ir(name);
  const chain = new FxChain(env);
  chain.set(items, { now: 0, local: 0, duration: n / sampleRate, immediate: true });
  await new Promise((r) => setTimeout(r, 0));          // impulse responses land on their convolvers
  const buf = ctx.createBuffer(2, input[0].length, sampleRate);
  buf.copyToChannel(input[0] as Float32Array<ArrayBuffer>, 0);
  buf.copyToChannel((input[1] ?? input[0]) as Float32Array<ArrayBuffer>, 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(chain.input);
  chain.output.connect(ctx.destination);
  src.start(0);
  const out = await ctx.startRendering();
  return [out.getChannelData(0).slice(), out.getChannelData(1).slice()];
}
