/**
 * The in-memory demo edit (`/editor/edit?demo=1`): a few procedural "camera clips" the engine draws as custom sources,
 * generated WAV sound (ambience, music, a voice-like track), a still, thumbnails, filmstrips and peaks, and a sequence
 * with clips on several tracks, transitions, keyframes, a title and markers. No files and no bridge needed.
 */
import type { CustomSource } from "../engine";
import { defaultTitle, newProject } from "./model/defaults";
import { uid } from "./model/ids";
import { addGenerated, addMarker, addTransition, clipsFromMedia, ctxOf, placeClips, tracksOf, updateParam } from "./model/ops";
import { addKeyframe } from "./model/params";
import { secondsToFrames } from "./model/time";
import type { EditProject, MediaItem } from "./model/types";

const FPS = 25;
const SW = 960, SH = 540;

type Painter = (g: CanvasRenderingContext2D, w: number, h: number, t: number) => void;

const PAINTERS: Record<string, { label: string; dur: number; audio: boolean; paint: Painter }> = {
  sunrise: { label: "Sunrise over the hills", dur: 16, audio: true, paint(g, w, h, t) {
    const sky = g.createLinearGradient(0, 0, 0, h);
    const k = Math.min(1, t / 14);
    sky.addColorStop(0, `hsl(${215 - 30 * k} 60% ${18 + 30 * k}%)`); sky.addColorStop(1, `hsl(${25 + 10 * k} 85% ${45 + 15 * k}%)`);
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.beginPath(); g.arc(w * 0.62, h * (0.78 - 0.45 * k), h * 0.11, 0, Math.PI * 2); g.fillStyle = "#ffe8a8"; g.fill();
    for (let i = 0; i < 3; i++) {
      g.beginPath(); g.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) g.lineTo(x, h * (0.68 + i * 0.09) + Math.sin(x / (120 + i * 40) + i + t * 0.05) * h * 0.05);
      g.lineTo(w, h); g.closePath(); g.fillStyle = `hsl(${140 + i * 8} ${30 - i * 6}% ${16 - i * 4}%)`; g.fill();
    }
  } },
  city: { label: "City at night", dur: 14, audio: true, paint(g, w, h, t) {
    g.fillStyle = "#070b18"; g.fillRect(0, 0, w, h);
    let s = 7;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 26; i++) {
      const bw = w / 26, bh = h * (0.25 + rnd() * 0.55), x = i * bw - ((t * 22) % bw);
      g.fillStyle = `hsl(225 25% ${10 + rnd() * 10}%)`; g.fillRect(x, h - bh, bw - 3, bh);
      for (let y = h - bh + 10; y < h - 10; y += 16) for (let xx = x + 6; xx < x + bw - 8; xx += 12) {
        if (rnd() > 0.55) { g.fillStyle = rnd() > 0.5 ? "#ffd27a" : "#7ad7ff"; g.fillRect(xx, y, 5, 7); }
      }
    }
    g.fillStyle = "rgba(255,80,140,0.6)"; g.fillRect(0, h * 0.92, w, h * 0.08);
  } },
  ocean: { label: "Ocean waves", dur: 18, audio: true, paint(g, w, h, t) {
    const sky = g.createLinearGradient(0, 0, 0, h * 0.5);
    sky.addColorStop(0, "#5aa9e6"); sky.addColorStop(1, "#cfe8ff");
    g.fillStyle = sky; g.fillRect(0, 0, w, h * 0.5);
    for (let i = 0; i < 8; i++) {
      g.beginPath(); g.moveTo(0, h);
      const y0 = h * (0.5 + i * 0.065);
      for (let x = 0; x <= w; x += 6) g.lineTo(x, y0 + Math.sin(x / 60 + t * (1.2 + i * 0.25) + i) * (4 + i * 2.2));
      g.lineTo(w, h); g.closePath(); g.fillStyle = `hsl(${200 - i * 3} ${70 - i * 3}% ${45 - i * 4}%)`; g.fill();
    }
  } },
  forest: { label: "Forest walk", dur: 12, audio: false, paint(g, w, h, t) {
    g.fillStyle = "#16301e"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      const x = ((i * 97 + t * (20 + (i % 5) * 14)) % (w + 80)) - 40;
      const tw = 14 + (i % 7) * 6;
      g.fillStyle = `hsl(${100 + (i % 4) * 12} 35% ${14 + (i % 6) * 5}%)`;
      g.fillRect(x, 0, tw, h);
    }
    const sun = g.createRadialGradient(w * 0.3, h * 0.2, 4, w * 0.3, h * 0.2, w * 0.5);
    sun.addColorStop(0, "rgba(255,240,180,0.55)"); sun.addColorStop(1, "rgba(255,240,180,0)");
    g.fillStyle = sun; g.fillRect(0, 0, w, h);
  } },
};

function stamp(g: CanvasRenderingContext2D, w: number, h: number, label: string, t: number) {
  g.font = `600 ${Math.round(h * 0.035)}px ui-monospace, monospace`;
  g.fillStyle = "rgba(0,0,0,0.45)"; g.fillRect(w * 0.02, h * 0.04, w * 0.36, h * 0.07);
  g.fillStyle = "#ffffff"; g.textBaseline = "middle";
  g.fillText(`${label}  ${t.toFixed(2)}s`, w * 0.03, h * 0.075);
}

/** A procedural clip as an engine source (and for the Source monitor). */
export function demoSource(id: string): CustomSource | null {
  const p = PAINTERS[id];
  if (!p) return null;
  const c = document.createElement("canvas");
  c.width = SW; c.height = SH;
  const g = c.getContext("2d")!;
  let last = NaN;
  return { kind: "canvas", width: SW, height: SH, draw(t: number) {
    if (t !== last) { last = t; p.paint(g, SW, SH, t); stamp(g, SW, SH, p.label, t); }
    return c;
  } };
}

function stillImage(w: number, h: number, t: number, paint: Painter, type = "image/jpeg", q = 0.72): string {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  paint(g, w, h, t);
  return c.toDataURL(type, q);
}

function filmstrip(paint: Painter, dur: number, frames = 12, fw = 160, fh = 90): string {
  const c = document.createElement("canvas");
  c.width = fw * frames; c.height = fh;
  const g = c.getContext("2d")!;
  const tmp = document.createElement("canvas");
  tmp.width = fw; tmp.height = fh;
  const tg = tmp.getContext("2d")!;
  for (let i = 0; i < frames; i++) { paint(tg, fw, fh, ((i + 0.5) / frames) * dur); g.drawImage(tmp, i * fw, 0); }
  return c.toDataURL("image/jpeg", 0.7);
}

// ── sound ────────────────────────────────────────────────────────────────────

const RATE = 22050;

function wav(samples: Float32Array): string {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

function peaksOf(s: Float32Array, perSecond = 50): number[] {
  const n = Math.ceil((s.length / RATE) * perSecond), b = Math.floor(RATE / perSecond);
  const out: number[] = [];
  for (let i = 0; i < n; i++) { let m = 0; for (let j = i * b; j < Math.min(s.length, (i + 1) * b); j++) m = Math.max(m, Math.abs(s[j])); out.push(Math.round(m * 1000) / 1000); }
  return out;
}

function synth(dur: number, kind: "ambience" | "music" | "voice", seed = 1): Float32Array {
  const n = Math.floor(dur * RATE);
  const out = new Float32Array(n);
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; };
  if (kind === "ambience") {
    let lp = 0;
    for (let i = 0; i < n; i++) { lp += (rnd() - lp) * 0.04; const t = i / RATE; out[i] = lp * 0.9 * (0.6 + 0.4 * Math.sin(t * 0.7 + seed)) + Math.sin(t * 2 * Math.PI * (55 + seed * 5)) * 0.05; }
  } else if (kind === "music") {
    const chords = [[220, 277.2, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 311.1]];
    const beat = 60 / 100;
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const ch = chords[Math.floor(t / (beat * 4)) % chords.length];
      const env = Math.exp(-((t % beat) / beat) * 2.2);
      let v = 0;
      for (const f of ch) v += Math.sin(2 * Math.PI * f * t) * 0.12 + Math.sin(2 * Math.PI * f * 2 * t) * 0.03;
      const kick = (t % beat) < 0.12 ? Math.sin(2 * Math.PI * 60 * (t % beat)) * Math.exp(-(t % beat) * 30) * 0.6 : 0;
      out[i] = v * (0.45 + 0.55 * env) + kick;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const word = Math.floor(t / 0.42);
      const on = (word % 7 !== 6) && ((t % 0.42) < 0.32);
      const env = on ? Math.sin(Math.PI * ((t % 0.42) / 0.32)) : 0;
      const f0 = 140 + 30 * Math.sin(word * 1.7);
      out[i] = env * (Math.sin(2 * Math.PI * f0 * t) * 0.35 + Math.sin(2 * Math.PI * f0 * 3.1 * t) * 0.15 + rnd() * 0.06);
    }
  }
  return out;
}

export interface Demo { project: EditProject; sources: Record<string, CustomSource>; urls: Record<string, string> }

let demoP: Promise<Demo> | null = null;
/** The demo edit (made once per page). */
export function makeDemo(): Promise<Demo> { return (demoP ??= build()); }

async function build(): Promise<Demo> {
  const p = newProject("Demo edit", { width: 1920, height: 1080, fps: FPS });
  const bins = { footage: { id: uid("b"), name: "Footage", parentId: null }, audio: { id: uid("b"), name: "Audio", parentId: null }, gfx: { id: uid("b"), name: "Graphics", parentId: null } };
  p.bins = [bins.footage, bins.audio, bins.gfx];
  const sources: Record<string, CustomSource> = {};
  const urls: Record<string, string> = {};
  const media: MediaItem[] = [];
  let seed = 1;
  for (const [key, def] of Object.entries(PAINTERS)) {
    const id = `m_${key}`;
    const url = `demo:${key}`;
    sources[url] = demoSource(key)!;
    const m: MediaItem = {
      id, binId: bins.footage.id, name: `${def.label}.mp4`, kind: "video", path: `Demo\\${key}.mp4`, url, duration: def.dur * FPS, fps: FPS,
      width: 1920, height: 1080, hasAudio: def.audio, audioChannels: def.audio ? 2 : undefined, markers: [],
      thumb: stillImage(320, 180, def.dur * 0.3, def.paint), filmstrip: filmstrip(def.paint, def.dur),
    };
    if (def.audio) { const s = synth(def.dur, "ambience", seed++); urls[`audio:${id}`] = wav(s); m.peaks = peaksOf(s); }
    media.push(m);
  }
  const music = synth(30, "music"), voice = synth(10, "voice", 3);
  const musicUrl = wav(music), voiceUrl = wav(voice);
  media.push(
    { id: "m_music", binId: bins.audio.id, name: "Score — Morning theme.wav", kind: "audio", path: "Demo\\music.wav", url: musicUrl, duration: 30 * FPS, fps: FPS, width: 0, height: 0, hasAudio: true, audioChannels: 1, markers: [], peaks: peaksOf(music) },
    { id: "m_voice", binId: bins.audio.id, name: "Narration take 3.wav", kind: "audio", path: "Demo\\voice.wav", url: voiceUrl, duration: 10 * FPS, fps: FPS, width: 0, height: 0, hasAudio: true, audioChannels: 1, markers: [], peaks: peaksOf(voice) },
  );
  // a still: a round badge with transparency
  const logo = document.createElement("canvas");
  logo.width = 600; logo.height = 600;
  const lg = logo.getContext("2d")!;
  const grad = lg.createRadialGradient(240, 210, 30, 300, 300, 300);
  grad.addColorStop(0, "#9ef0ff"); grad.addColorStop(1, "#4f46e5");
  lg.beginPath(); lg.arc(300, 300, 280, 0, Math.PI * 2); lg.fillStyle = grad; lg.fill();
  lg.font = "800 260px system-ui, sans-serif"; lg.textAlign = "center"; lg.textBaseline = "middle"; lg.fillStyle = "#06121f"; lg.fillText("T", 300, 320);
  const logoUrl = await new Promise<string>((res) => logo.toBlob((b) => res(b ? URL.createObjectURL(b) : logo.toDataURL()), "image/png"));
  media.push({ id: "m_logo", binId: bins.gfx.id, name: "Logo badge.png", kind: "image", path: "Demo\\logo.png", url: logoUrl, duration: 0, fps: 0, width: 600, height: 600, hasAudio: false, markers: [], thumb: logo.toDataURL("image/png") });
  p.media = media;

  // the sequence
  let s = p.sequences[0];
  s = { ...s, name: "Demo cut" };
  const ctx = ctxOf(p);
  const V = tracksOf(s, "video"), A = tracksOf(s, "audio");
  const f = (sec: number) => secondsToFrames(sec, FPS);
  const m = (id: string) => media.find((x) => x.id === id)!;
  const put = (id: string, at: number, inS: number, outS: number, vi = 0, ai = 0, audio = true) => {
    s = placeClips(s, ctx, clipsFromMedia(s, m(id), f(at), { videoTrackId: V[vi].id, audioTrackId: audio ? A[ai].id : undefined, range: { in: f(inS), out: f(outS) - 1 } }), "overwrite");
  };
  put("m_sunrise", 0, 3, 9);
  put("m_city", 6, 2, 8);
  put("m_ocean", 12, 3, 11);
  put("m_forest", 20, 1, 7);
  s = addTransition(s, ctx, V[0].id, f(6), "fade", f(1)).seq;
  s = addTransition(s, ctx, V[0].id, f(12), "gl:cube", f(1.2)).seq;
  s = addTransition(s, ctx, A[0].id, f(6), "audio:constant_power", f(1)).seq;
  s = addTransition(s, ctx, V[0].id, 0, "fadeblack", f(0.8)).seq;
  // the logo on V2, small in the corner, fading in
  s = placeClips(s, ctx, clipsFromMedia(s, m("m_logo"), f(2), { videoTrackId: V[1].id, duration: f(5) }), "overwrite");
  const logoClip = s.clips.find((c) => c.source.type === "media" && c.source.mediaId === "m_logo")!;
  s = updateParam(s, ctx, logoClip.id, "motion.scale", () => ({ value: 22 }));
  s = updateParam(s, ctx, logoClip.id, "motion.position", () => ({ value: [1700, 210] }));
  s = updateParam(s, ctx, logoClip.id, "motion.opacity", (pp) => addKeyframe(addKeyframe(pp, 0, 0, "ease_out"), f(0.8), 100));
  s = updateParam(s, ctx, logoClip.id, "motion.rotation", (pp) => addKeyframe(addKeyframe(pp, 0, -20, "ease_out"), f(1.2), 0));
  // a title on V3
  s = addGenerated(s, ctx, V[2].id, f(0.6), f(4.4), { type: "title", text: { ...defaultTitle("Tatvam Editor"), size: 120, box: [0.08, 0.36, 0.84, 0.28] } }, "Title — Tatvam Editor").seq;
  // music with a fade out, a voice clip
  s = placeClips(s, ctx, clipsFromMedia(s, m("m_music"), 0, { audioTrackId: A[1].id, range: { in: 0, out: f(27) - 1 } }), "overwrite");
  const mus = s.clips.find((c) => c.source.type === "media" && c.source.mediaId === "m_music")!;
  s = updateParam(s, ctx, mus.id, "audio.gain", (pp) => addKeyframe(addKeyframe(addKeyframe(pp, 0, -12), f(22), -12), f(26.5), -40));
  s = placeClips(s, ctx, clipsFromMedia(s, m("m_voice"), f(7), { audioTrackId: A[2].id, range: { in: 0, out: f(9) - 1 } }), "overwrite");
  s = { ...s, markers: addMarker(addMarker(s.markers, f(2), { name: "Logo in", color: "#fbbf24" }), f(12), { name: "Cube transition", color: "#22d3ee", comment: "Check the cube on a big screen" }) };
  s = { ...s, tracks: s.tracks.map((t) => (t.kind === "video" && t.index === 2 ? { ...t, name: "Titles" } : t.kind === "audio" && t.index === 1 ? { ...t, name: "Music", volume: -2, syncLock: false } : t.kind === "audio" && t.index === 2 ? { ...t, name: "Voice" } : t)) };
  p.sequences = [s];
  return { project: p, sources, urls };
}

/** The demo's sound for a media item (the procedural clips' ambience). */
export const demoAudioKey = (mediaId: string) => `audio:${mediaId}`;
