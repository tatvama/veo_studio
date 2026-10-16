import { ArrowRight, Check, Lock } from "lucide-react";
import { InView } from "../../components/ui";
import { cn } from "../../lib/cn";
import { ENGINES } from "../login/showcase";
import { FEATURES, type Feature } from "./content";
import { Section, SectionHead, Spot } from "./parts";

/* Each card carries a small picture of the feature. They are decorative (aria-hidden): the words say the same thing. */

const chip = "inline-flex items-center gap-1.5 rounded-full border border-line bg-raised/60 px-2.5 py-1 text-xs text-mute";

function DirectorArt() {
  return (
    <div aria-hidden className="mt-6 space-y-2 text-sm">
      <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-accent/15 px-3.5 py-2">Make a 30-second Holi ad for my sweet shop, in Hindi.</p>
      <p className="w-fit max-w-[92%] rounded-2xl rounded-bl-md border border-line bg-raised/70 px-3.5 py-2 text-mute">
        <span className="mr-1.5 font-medium text-ai">Director</span>Three scenes, one cast member and a Hindi voice-over are ready. Shall I start shooting?
      </p>
    </div>
  );
}

function WritersArt() {
  return (
    <ul aria-hidden className="mt-5 space-y-2 text-xs">
      <li className="flex items-center gap-2.5 rounded-lg border border-line bg-raised/50 px-3 py-2"><i className="size-2 rounded-full bg-warn" /><span className="text-mute">Draft 1</span><span className="ml-auto text-dim">The hook is slow</span></li>
      <li className="flex items-center gap-2.5 rounded-lg border border-ok/30 bg-ok/5 px-3 py-2"><i className="size-2 rounded-full bg-ok" /><span>Draft 2</span><span className="ml-auto text-ok">Critic passed</span></li>
    </ul>
  );
}

function LockArt() {
  return (
    <div aria-hidden className="mt-5 flex flex-wrap gap-1.5">
      {["Face", "Body", "Costume", "Voice", "Gestures"].map((l) => <span key={l} className={cn(chip, "border-accent/30 bg-accent/10 text-accent-ink")}><Lock className="size-3" />{l}</span>)}
    </div>
  );
}

const TAKES = [["holi", "Veo 3.1"], ["dance", "Kling 3"], ["backwaters", "Seedance"]] as const;

function ShotsArt() {
  return (
    <div aria-hidden className="mt-6 grid grid-cols-3 gap-2">
      {TAKES.map(([slug, engine], i) => (
        <div key={slug} className={cn("relative aspect-video overflow-hidden rounded-lg border border-line", i === 1 && "ring-2 ring-ok")}>
          <img src={`/showcase/${slug}-sm.webp`} alt="" loading="lazy" decoding="async" className={cn("size-full object-cover", i !== 1 && "opacity-70")} />
          <span className="mono absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1 pt-4 text-[0.625rem] text-white/90">{engine}</span>
          {i === 1 && <span className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-ok text-black"><Check className="size-3" strokeWidth={3} /></span>}
        </div>
      ))}
    </div>
  );
}

function HubArt() {
  return (
    <div aria-hidden className="mt-6">
      <div className="flex flex-wrap gap-1.5">
        {ENGINES.map((e) => <span key={e.name} className={chip}>{e.name}</span>)}
        <span className="rounded-full border border-dashed border-line px-2.5 py-1 text-xs text-dim">+ hundreds more</span>
      </div>
      <div className="mt-4 inline-flex rounded-lg border border-line bg-raised/60 p-0.5 text-xs">
        {["Saver", "Balanced", "Hero"].map((t, i) => <span key={t} className={cn("rounded-md px-3 py-1", i === 1 ? "bg-accent/15 text-accent-ink" : "text-dim")}>{t}</span>)}
      </div>
    </div>
  );
}

const CLIPS = [3, 2, 4, 2];
const BARS = Array.from({ length: 40 }, (_, i) => 0.2 + 0.8 * Math.abs(Math.sin(i * 0.8) * 0.6 + Math.sin(i * 0.3 + 1) * 0.4));

function TimelineArt() {
  return (
    <div aria-hidden className="relative mt-5 rounded-lg border border-line bg-raised/40 p-2">
      <div className="flex h-5 gap-0.5">
        {CLIPS.map((w, i) => <i key={i} style={{ flex: w }} className="rounded bg-gradient-to-r from-accent/45 to-accent-2/45" />)}
      </div>
      <div className="mt-1.5 flex h-5 items-center gap-px">{BARS.map((h, i) => <i key={i} style={{ height: `${h * 100}%` }} className="w-full rounded-full bg-accent/45" />)}</div>
      <span className="absolute inset-y-1 left-[42%] w-px bg-accent"><i className="absolute -left-[3px] -top-0.5 size-[7px] rounded-full bg-accent" /></span>
    </div>
  );
}

function SoundArt() {
  return (
    <div aria-hidden className="mt-5">
      <div className="flex h-9 items-center gap-px">{BARS.map((h, i) => <i key={i} style={{ height: `${h * 100}%` }} className={cn("w-full rounded-full", i % 9 === 4 ? "bg-money/70" : "bg-accent/45")} />)}</div>
      <div className="mt-2 flex gap-1.5">{["whoosh", "riser", "impact"].map((t) => <span key={t} className={cn(chip, "mono")}>{t}</span>)}</div>
    </div>
  );
}

function VoicesArt() {
  return (
    <div aria-hidden className="mt-5 flex flex-wrap gap-1.5">
      {([["hi", "हिन्दी"], ["kn", "ಕನ್ನಡ"], ["te", "తెలుగు"], ["ta", "தமிழ்"], ["en", "English"]] as const).map(([code, name]) => (
        <span key={code} lang={code} className={cn(chip, "ld-script text-sm text-ink")}>{name}</span>
      ))}
    </div>
  );
}

function DesktopArt() {
  return (
    <div aria-hidden className="mt-5 flex items-center gap-3">
      <span className="mono rounded-lg border border-line bg-raised/60 px-3 py-2 text-xs text-mute">1080p</span>
      <ArrowRight className="size-4 text-dim" />
      <span className="mono rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-semibold text-accent-ink">4K</span>
      <span className="text-xs text-dim">on your own GPU</span>
    </div>
  );
}

function AdsArt() {
  return (
    <div aria-hidden className="mt-5 flex items-end gap-2">
      <img src="/showcase/monsoon-sm.webp" alt="" loading="lazy" className="aspect-[9/16] h-24 rounded-md border border-line object-cover" />
      <img src="/showcase/holi-sm.webp" alt="" loading="lazy" className="aspect-square h-[4.5rem] rounded-md border border-line object-cover" />
      <img src="/showcase/lamp-sm.webp" alt="" loading="lazy" className="aspect-video h-14 rounded-md border border-line object-cover" />
      <span className="mono ml-1 text-2xs leading-tight text-dim">Reel · Post · YouTube</span>
    </div>
  );
}

function TeamArt() {
  return (
    <div aria-hidden className="mt-5 flex flex-wrap items-center gap-1.5">
      {["Viewer", "Reviewer", "Creator", "Producer", "Admin"].map((r, i) => (
        <span key={r} className={cn(chip, i === 3 && "border-info/40 bg-info/10 text-info")}>{r}</span>
      ))}
    </div>
  );
}

const AUTOPILOT = ["Brief", "Script", "Cast", "Shots", "Edit"];

function AutopilotArt() {
  return (
    <div aria-hidden className="mt-5 space-y-2">
      <p className="mono truncate rounded-lg border border-line bg-raised/50 px-3 py-2 text-xs text-mute">› A festival ad for my sweet shop<span className="ml-0.5 inline-block h-3 w-px translate-y-0.5 animate-pulse bg-accent" /></p>
      <div className="flex flex-wrap gap-1.5">
        {AUTOPILOT.map((s, i) => (
          <span key={s} className={cn(chip, i < 3 ? "border-ok/30 text-ok" : i === 3 ? "border-accent/40 text-accent-ink" : "text-dim")}>{i < 3 && <Check className="size-3" strokeWidth={3} />}{s}</span>
        ))}
      </div>
    </div>
  );
}

const ART: Record<Feature["id"], () => React.JSX.Element> = {
  director: DirectorArt, writers: WritersArt, lock: LockArt, shots: ShotsArt, hub: HubArt, timeline: TimelineArt,
  sound: SoundArt, voices: VoicesArt, desktop: DesktopArt, ads: AdsArt, team: TeamArt, autopilot: AutopilotArt,
};

export function Features() {
  return (
    <Section id="features">
      <SectionHead center eyebrow="Features" title="Everything a film crew does, in one studio."
        lead="A writers' room, a casting office, a camera department, an edit suite and a distribution desk, all working from the same project." />
      <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-3 lg:[grid-auto-flow:dense]">
        {FEATURES.map((f, i) => {
          const Art = ART[f.id];
          return (
            <InView key={f.id} delay={(i % 3) * 0.06} className={cn("min-w-0", f.wide && "md:col-span-2", f.id === "autopilot" && "md:col-span-2 lg:col-span-1")}>
              <Spot className="ld-card h-full p-6">
                <div className="flex items-start justify-between gap-3">
                  <span className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-accent/20 to-accent-2/15 text-accent-ink ring-1 ring-inset ring-accent/20"><f.icon className="size-5" /></span>
                  {f.tag && <span className="mono rounded-full border border-line px-2.5 py-1 text-2xs text-mute">{f.tag}</span>}
                </div>
                <h3 className="mt-5 text-lg font-semibold tracking-tight">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-mute">{f.text}</p>
                <Art />
              </Spot>
            </InView>
          );
        })}
      </div>
    </Section>
  );
}
