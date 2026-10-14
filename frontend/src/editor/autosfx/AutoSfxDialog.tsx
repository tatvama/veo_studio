/**
 * The Auto SFX dialog (docs/EDITOR.md §15.2): a switch per rule with its count, the intensity, the sound source
 * (generated, recorded Kenney CC0 sounds, or both), the range (the whole sequence or in to out), a preview list (time, sound, why) with a checkbox per sound, Apply (ONE undo step) and
 * "Remove auto sound effects". Opens from Sequence → Auto SFX… and the timeline's context menus (openAutoSfx()).
 * Mounted once by the editor; a default export with no required props.
 */
import { clsx } from "clsx";
import { AudioLines, Loader2, Trash2, Volume1, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge, Button, Modal, Segmented, Toggle } from "../../components/ui";
import { makeHost } from "../host";
import { framesToSeconds, toTimecode } from "../model/time";
import { program } from "../playback/transport";
import { useProject, useSequence } from "../store";
import { applyAutoSfx, removeAutoSfxCommand } from "./apply";
import { resolveSfxUrls } from "./autoedit";
import { AUTO_SFX_EVENT } from "./index";
import { describeAutoSfx, planAutoSfx, RULES, SFX_SOURCES } from "./planner";
import { speechRanges } from "./speech";
import type { FrameRange, SfxIntensity, SfxRule, SfxSource } from "./types";

const INTENSITIES: { value: SfxIntensity; label: string; title: string }[] = [
  { value: "subtle", label: "Subtle", title: "−24 dB, the softer variants" },
  { value: "normal", label: "Normal", title: "−18 dB" },
  { value: "punchy", label: "Punchy", title: "−12 dB, the heavier variants" },
];
const RULE_KEY = "tatvam-editor:auto-sfx";
type Saved = { intensity: SfxIntensity; rules: Partial<Record<SfxRule, boolean>>; source: SfxSource };
const isSource = (v: unknown): v is SfxSource => SFX_SOURCES.some((x) => x.value === v);
function loadSaved(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(RULE_KEY) ?? "null");
    if (v && typeof v === "object") return { intensity: v.intensity ?? "normal", rules: v.rules ?? {}, source: isSource(v.source) ? v.source : "both" };
  } catch { /* first time */ }
  return { intensity: "normal", rules: {}, source: "both" };
}
function save(v: Saved) { try { localStorage.setItem(RULE_KEY, JSON.stringify(v)); } catch { /* private window */ } }

export default function AutoSfxDialog() {
  const [open, setOpen] = useState(false);
  const p = useProject();
  const s = useSequence();
  const [intensity, setIntensity] = useState<SfxIntensity>(() => loadSaved().intensity);
  const [rules, setRules] = useState<Partial<Record<SfxRule, boolean>>>(() => loadSaved().rules);
  const [source, setSource] = useState<SfxSource>(() => loadSaved().source);
  const [range, setRange] = useState<"all" | "inout">("all");
  const [speech, setSpeech] = useState<FrameRange[] | undefined>(undefined);
  const [listening, setListening] = useState(false);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  useEffect(() => {
    const h = () => { setOff(new Set()); setShowSkipped(false); setOpen(true); };
    window.addEventListener(AUTO_SFX_EVENT, h);
    return () => window.removeEventListener(AUTO_SFX_EVENT, h);
  }, []);
  // where speech plays (the free silence analysis on this PC), once per opening
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setListening(true);
    setSpeech(undefined);
    speechRanges(makeHost()).then((r) => { if (alive) setSpeech(r); }).catch(() => undefined).finally(() => { if (alive) setListening(false); });
    return () => { alive = false; };
  }, [open, s.id]);
  useEffect(() => { save({ intensity, rules, source }); }, [intensity, rules, source]);

  const hasInOut = s.inPoint !== undefined || s.outPoint !== undefined;
  const plan = useMemo(() => (open ? planAutoSfx(s, p, { intensity, rules, source, range: range === "inout" && hasInOut ? "inout" : "all", speech }) : null),
    [open, s, p, intensity, rules, source, range, hasInOut, speech]);
  const chosen = plan ? plan.placements.filter((x) => !off.has(x.id)) : [];
  const autoNow = s.clips.filter((c) => c.autoSfx).length;
  const fps = s.fps;
  const sec = (f: number) => Math.round(framesToSeconds(f, fps) * 100) / 100;

  async function apply() {
    if (!plan) return;
    setBusy({ done: 0, total: 1 });
    try {
      const r = await applyAutoSfx(makeHost(), plan, { only: chosen.map((x) => x.id), onProgress: (done, total) => setBusy({ done, total }), onMedia: resolveSfxUrls });
      if (r.failed.length) toast.warning(`${r.failed.length} sound${r.failed.length === 1 ? "" : "s"} couldn't be made: ${r.failed[0]}`);
      toast.success(`${r.placed} sound effect${r.placed === 1 ? "" : "s"} placed on the SFX track${r.removed ? `, ${r.removed} earlier ones replaced` : ""} (Ctrl+Z takes them back)`);
      setOpen(false);
    } catch (e) {
      toast.error(`Auto SFX failed: ${(e as Error).message}`);
    } finally { setBusy(null); }
  }
  function removeAll() {
    const n = removeAutoSfxCommand(makeHost(), range === "inout" && hasInOut && plan ? plan.range : undefined);
    toast.message(n ? `Removed ${n} auto sound effect${n === 1 ? "" : "s"}` : "No auto sound effects to remove");
  }
  const toggle = (id: string) => setOff((x) => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Modal open={open} onClose={() => { if (!busy) setOpen(false); }} size="xl"
      title={<span className="inline-flex items-center gap-2"><AudioLines className="size-4 text-ai" />Auto SFX</span>}
      footer={(
        <div className="flex w-full items-center gap-2">
          <Button variant="ghost" icon={<Trash2 className="size-4" />} disabled={!autoNow || !!busy} onClick={removeAll}
            title="Removes the sounds auto SFX placed (yours stay)">Remove auto sound effects{autoNow ? ` (${autoNow})` : ""}</Button>
          <span className="ml-auto text-2xs text-dim">{busy ? `Making the sounds: ${busy.done} of ${busy.total}` : plan ? `${chosen.length} of ${plan.placements.length} chosen` : ""}</span>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={!!busy}>Cancel</Button>
          <Button variant="primary" icon={busy ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />} disabled={!!busy || !plan || (!chosen.length && !plan.replaces)}
            onClick={() => void apply()}>Apply</Button>
        </div>
      )}>
      {plan && (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-2xs uppercase tracking-wide text-dim">Intensity</span>
            <Segmented size="sm" value={intensity} options={INTENSITIES} onChange={setIntensity} aria-label="Intensity" />
            <span className="ml-2 text-2xs uppercase tracking-wide text-dim">Sound source</span>
            <Segmented size="sm" value={source} options={SFX_SOURCES} onChange={setSource} aria-label="Sound source" />
            <span className="ml-2 text-2xs uppercase tracking-wide text-dim">Range</span>
            <Segmented size="sm" value={range} onChange={setRange} aria-label="Range"
              options={[{ value: "all", label: "Whole sequence" }, { value: "inout", label: hasInOut ? "In to out" : "In to out (no marks)", title: hasInOut ? undefined : "Mark in and out first (I / O)" }]} />
            <span className="ml-auto inline-flex items-center gap-1.5 text-2xs text-dim">
              {listening ? <><Loader2 className="size-3 animate-spin" />Listening for speech…</> : <><Volume1 className="size-3" />{!speech ? "Speech: the dialogue clips" : speech.length ? "Speech from the silence analysis (6 dB lower under it)" : "No dialogue: nothing to duck under"}</>}
            </span>
          </div>

          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {RULES.map((r) => {
              const on = rules[r.id] ?? r.on;
              const n = on ? plan.counts[r.id] : plan.found[r.id];
              return (
                <div key={r.id} className="flex items-start gap-2 rounded-lg border border-line bg-panel/60 px-2.5 py-2">
                  <Toggle checked={on} onChange={(v) => setRules((x) => ({ ...x, [r.id]: v }))} label={<span className="font-medium">{r.label}</span>} />
                  <Badge tone={on && n ? "accent" : "neutral"} className="ml-auto shrink-0" title={on ? "Sounds it places" : "Events it would use"}>{n}</Badge>
                  <span className="sr-only">{r.hint}</span>
                </div>
              );
            })}
          </div>

          <div>
            <div className="mb-1 flex items-center gap-2">
              <p className="text-2xs font-medium uppercase tracking-wide text-dim">Preview</p>
              <button type="button" className="text-2xs text-accent-ink hover:underline" onClick={() => setOff(new Set())}>All</button>
              <button type="button" className="text-2xs text-accent-ink hover:underline" onClick={() => setOff(new Set(plan.placements.map((x) => x.id)))}>None</button>
              <span className="ml-auto text-2xs text-dim">{describeAutoSfx(plan)}</span>
            </div>
            <div className="max-h-[42vh] overflow-auto rounded-lg border border-line" data-testid="autosfx-preview">
              {plan.placements.length === 0
                ? <p className="p-4 text-center text-xs text-mute">Nothing in this edit calls for a sound effect yet (or every rule is off).</p>
                : (
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-raised text-left text-2xs uppercase tracking-wide text-dim">
                      <tr><th className="w-8 px-2 py-1.5" /><th className="px-2 py-1.5">Time</th><th className="px-2 py-1.5">Sound</th><th className="px-2 py-1.5">Why</th><th className="px-2 py-1.5 text-right">Level</th></tr>
                    </thead>
                    <tbody>
                      {plan.placements.map((x) => (
                        <tr key={x.id} className={clsx("border-t border-line/60", off.has(x.id) && "opacity-45")}>
                          <td className="px-2 py-1"><input type="checkbox" aria-label={`Use ${x.label} at ${sec(x.hit)} s`} checked={!off.has(x.id)} onChange={() => toggle(x.id)} /></td>
                          <td className="px-2 py-1 font-mono whitespace-nowrap">
                            <button type="button" className="hover:text-accent-ink" title="Go there" onClick={() => program.seek(Math.max(0, x.hit))}>{toTimecode(Math.max(0, x.hit), fps)}</button>
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap">{x.label}<span className="ml-1 text-2xs text-dim">{RULES.find((r) => r.id === x.rule)?.label}</span></td>
                          <td className="px-2 py-1 text-mute">{x.reason}</td>
                          <td className="px-2 py-1 text-right font-mono whitespace-nowrap">{x.gainDb} dB{x.ducked && <span className="ml-1 text-2xs text-dim" title="6 dB lower under speech">speech</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
            {plan.skipped.length > 0 && (
              <div className="mt-2 text-2xs text-mute">
                <button type="button" className="hover:text-ink" onClick={() => setShowSkipped((v) => !v)}>{showSkipped ? "▾" : "▸"} {plan.skipped.length} left out</button>
                {showSkipped && (
                  <ul className="mt-1 max-h-32 space-y-0.5 overflow-auto">
                    {plan.skipped.map((x) => <li key={x.id}><span className="font-mono">{toTimecode(Math.max(0, x.hit), fps)}</span> · {x.reason}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
          <p className="text-2xs text-dim">{source === "generated" ? "The sounds are made on this PC (no cost)" : source === "recorded" ? "The sounds are Kenney's CC0 recordings, bundled with Tatvam (no cost), copied into the edit" : "The sounds are made on this PC or are Kenney's CC0 recordings (no cost)"} and go on the SFX track{plan.replaces ? `, replacing ${plan.replaces} from an earlier run` : ""}. Apply is one step: Ctrl+Z takes it all back. Your own sound effects are never changed.</p>
        </div>
      )}
    </Modal>
  );
}
