import { useState, type CSSProperties } from "react";
import { AnimatedNumber } from "../../components/ui";
import { cn } from "../../lib/cn";
import { TIER_COPY } from "./content";
import { Section, SectionHead, Spot, rupees, usePublicRates } from "./parts";

const PRESETS = [15, 30, 60, 90];
const MIN = 5;
const MAX = 180;

function length(s: number) {
  if (s < 60) return `${s} sec`;
  return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} sec` : `${s / 60} min`;
}

/** What a video costs to generate, by length and quality tier. Prices and the rupee rate come from the studio itself. */
export function Estimator() {
  const { tiers, inr, live } = usePublicRates();
  const [secs, setSecs] = useState(30);
  const totals = tiers.map((t) => ({ ...t, usd: t.usd_per_second * secs, inr: t.usd_per_second * secs * inr }));
  const top = Math.max(...totals.map((t) => t.inr));

  return (
    <Section id="cost">
      <SectionHead center eyebrow="Cost" title="Know the cost before you press go."
        lead="Pick a length and a quality tier. Tatvam prices every paid step in rupees first, and nothing runs until you approve it." />

      <Spot className="ld-card mx-auto mt-12 max-w-5xl p-5 sm:p-8">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <label htmlFor="ld-secs" className="eyebrow">Length of your video</label>
            <p className="mt-2 text-4xl font-semibold tabular-nums tracking-tight" aria-live="polite">{length(secs)}</p>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Common lengths">
            {PRESETS.map((p) => (
              <button key={p} type="button" onClick={() => setSecs(p)} aria-pressed={secs === p}
                className={cn("h-9 rounded-full border px-4 text-sm transition-colors", secs === p ? "border-accent/60 bg-accent/15 text-accent-ink" : "border-line text-mute hover:border-dim/50 hover:text-ink")}>
                {length(p)}
              </button>
            ))}
          </div>
        </div>

        <input id="ld-secs" type="range" min={MIN} max={MAX} step={5} value={secs} onChange={(e) => setSecs(Number(e.target.value))}
          aria-valuetext={length(secs)} className="ld-range mt-6 w-full" style={{ "--p": `${((secs - MIN) / (MAX - MIN)) * 100}%` } as CSSProperties} />

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {totals.map((t, i) => {
            const copy = TIER_COPY[t.id] ?? { name: t.id, for: "" };
            return (
              <div key={t.id} className={cn("rounded-2xl border bg-raised/40 p-5", i === 1 ? "border-accent/40" : "border-line")}>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-lg font-semibold tracking-tight">{copy.name}</h3>
                  <span className="mono rounded-full border border-line px-2.5 py-1 text-2xs text-mute">{t.resolution}</span>
                </div>
                <p className="mt-1 min-h-10 text-sm leading-snug text-mute">{copy.for}</p>
                <p className="mt-4 text-4xl font-semibold tabular-nums tracking-tight text-money">
                  <AnimatedNumber value={t.inr} format={rupees} duration={0.45} />
                </p>
                <p className="mt-1 text-xs text-dim">≈ ${t.usd.toFixed(2)} · ₹{(t.usd_per_second * inr).toFixed(2)} per second</p>
                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-raised" aria-hidden>
                  <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-500" style={{ width: `${(t.inr / top) * 100}%` }} />
                </div>
              </div>
            );
          })}
        </div>

        <p className="mt-6 text-xs leading-relaxed text-dim">
          Estimated cost of generating the video itself, at ₹{inr.toFixed(1)} to the dollar{live ? "" : " (approximate)"}. Voice, music and upscaling are priced
          separately, and Tatvam shows the estimate for each paid step before you approve it.
        </p>
      </Spot>
    </Section>
  );
}
