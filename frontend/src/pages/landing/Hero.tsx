import { ArrowRight, Bot, Check, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui";
import { Reel, Stage, useShowreel } from "../login/Cinema";
import { HERO_WORDS, PROOF } from "./content";
import { rupees, usePublicRates } from "./parts";

const WORD_MS = 2600;

/** "story" in Hindi, Tamil, Telugu, Kannada and English, one after another. With reduced motion it stays on "story". */
function RotatingWord({ still }: { still: boolean }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (still) return;
    const id = window.setInterval(() => setI((n) => (n + 1) % HERO_WORDS.length), WORD_MS);
    return () => window.clearInterval(id);
  }, [still]);
  const shown = still ? HERO_WORDS.length - 1 : i;
  return (
    <span className="ld-words" aria-hidden>
      {HERO_WORDS.map((w, k) => (
        <span key={w.lang} lang={w.lang} data-on={k === shown || undefined} className="text-gradient">{w.text}</span>
      ))}
    </span>
  );
}

const chip = "rounded-lg px-3 py-1.5 text-xs font-medium";

/** Three pictures of the studio at work, floating beside the headline. Decorative: nothing in here can be clicked. */
function Floaters() {
  const { tiers, inr } = usePublicRates();
  const tier = tiers.find((t) => t.id === "balanced") ?? tiers[0];
  const cost = 8 * tier.usd_per_second * inr;
  return (
    <div aria-hidden className="pointer-events-none relative hidden h-[30rem] select-none lg:block">
      <div className="lg-glass anim-float absolute left-0 top-2 w-[19.5rem] rounded-2xl p-4 shadow-pop" style={{ animationDelay: "-1s" }}>
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-full bg-ai/15 text-ai"><Bot className="size-4" /></span>
          <div className="leading-tight"><p className="text-sm font-medium">Director</p><p className="mono text-2xs text-dim">just now</p></div>
        </div>
        <p className="mt-3 text-sm leading-relaxed">I split your script into six scenes and cast Asha. Shall I shoot scene one in Tamil?</p>
        <div className="mt-3 flex gap-2">
          <span className={`${chip} btn-primary text-black`}>Yes, go ahead</span>
          <span className={`${chip} border border-line text-mute`}>Change</span>
        </div>
      </div>

      <div className="lg-glass anim-float absolute right-0 top-[10.5rem] w-[17.5rem] rounded-2xl p-4 shadow-pop" style={{ animationDelay: "-2.6s" }}>
        <p className="eyebrow flex items-center gap-2 !text-money"><span className="live-dot is-warn" />Needs your approval</p>
        <div className="mt-3 flex items-end justify-between gap-3">
          <div><p className="text-sm font-medium">Scene 1 · 8 s</p><p className="text-xs text-mute">Balanced · {tier.resolution}</p></div>
          <p className="text-2xl font-semibold tabular-nums text-money">≈ {rupees(cost)}</p>
        </div>
        <div className="mt-3 flex gap-2">
          <span className={`${chip} btn-primary text-black`}>Approve</span>
          <span className={`${chip} border border-line text-mute`}>Edit</span>
        </div>
      </div>

      <div className="lg-glass anim-float absolute bottom-0 left-10 w-[18.5rem] rounded-2xl p-3.5 shadow-pop" style={{ animationDelay: "-4s" }}>
        <div className="flex items-center gap-3">
          <img src="/showcase/monsoon-sm.webp" alt="" className="h-11 w-[4.5rem] shrink-0 rounded-md object-cover" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">Monsoon Rooftop</p>
            <p className="text-xs text-mute">Rendering in Tamil…</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised"><div className="sweep h-full w-3/5 rounded-full bg-accent" /></div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Hero({ onJoin, onHow }: { onJoin: () => void; onHow: () => void }) {
  const reel = useShowreel();
  return (
    <header id="top" className="relative isolate flex min-h-[100svh] flex-col" style={{ overflow: "clip" }}>
      <Stage index={reel.index} />
      <div aria-hidden className="ld-scrim" />

      <div className="relative z-10 mx-auto flex w-full max-w-[80rem] flex-1 items-center px-4 pb-8 pt-28 sm:px-8 sm:pt-32 lg:grid lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:gap-8">
        <div>
          <p className="lg-glass anim-rise inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs text-mute">
            <span aria-hidden className="live-dot" />Made in India, for India
          </p>
          <h1 className="ld-h1 anim-rise mt-6" style={{ "--i": 1 } as React.CSSProperties} aria-label="Every story, made cinematic.">
            <span aria-hidden>
              Every <RotatingWord still={reel.reduced} />,<br />
              <span className="text-gradient">made cinematic.</span>
            </span>
          </h1>
          <p className="anim-rise mt-6 max-w-xl text-base leading-relaxed text-mute sm:text-lg" style={{ "--i": 2 } as React.CSSProperties}>
            Tatvam is the AI film studio built in India. Write it, cast it, shoot it and finish it in Hindi, Tamil, Telugu, Kannada or English,
            and see every cost in rupees before you spend a single one.
          </p>
          <div className="anim-rise mt-8 flex flex-wrap items-center gap-3" style={{ "--i": 3 } as React.CSSProperties}>
            <Button variant="primary" size="lg" onClick={onJoin} className="lg-sheen h-12 w-full rounded-xl px-6 sm:w-auto" iconRight={<ArrowRight className="size-4" />}>
              Join the waitlist
            </Button>
            <Button variant="outline" size="lg" onClick={onHow} className="lg-glass h-12 w-full rounded-xl px-6 sm:w-auto" iconRight={<ChevronDown className="size-4" />}>
              See how it works
            </Button>
          </div>
          <ul className="anim-rise mt-7 flex flex-wrap gap-x-5 gap-y-2 text-sm text-mute" style={{ "--i": 4 } as React.CSSProperties}>
            {PROOF.map((p) => <li key={p} className="flex items-center gap-1.5"><Check className="size-4 text-ok" />{p}</li>)}
          </ul>
        </div>
        <Floaters />
      </div>

      <div className="relative z-10 mx-auto w-full max-w-[80rem] px-4 pb-8 sm:px-8">
        <div className="max-w-xl"><Reel index={reel.index} paused={reel.paused} onPick={reel.go} onHold={reel.setHold} /></div>
      </div>
    </header>
  );
}
