import { InView } from "../../components/ui";
import { INDIA_POINTS } from "./content";
import { SectionHead } from "./parts";

/** The five languages the studio writes, speaks and captions in, each with the word for "story". */
const LANGS = [
  { code: "hi", script: "हिन्दी", name: "Hindi", word: "कहानी" },
  { code: "kn", script: "ಕನ್ನಡ", name: "Kannada", word: "ಕಥೆ" },
  { code: "te", script: "తెలుగు", name: "Telugu", word: "కథ" },
  { code: "ta", script: "தமிழ்", name: "Tamil", word: "கதை" },
  { code: "en", script: "English", name: "English", word: "story" },
] as const;

function LanguagesCard() {
  return (
    <div className="lg-card p-5 sm:p-7">
      <p className="eyebrow">Scripts · voices · captions · dubbing</p>
      <ul className="mt-4 divide-y divide-line">
        {LANGS.map((l) => (
          <li key={l.code} className="flex items-center gap-4 py-3.5">
            <span lang={l.code} className="ld-script w-32 shrink-0 text-3xl font-semibold leading-tight sm:w-40 sm:text-4xl">{l.script}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{l.name}</span>
              <span lang={l.code} className="ld-script block truncate text-sm text-dim">{l.word}</span>
            </span>
            <span aria-hidden className="eq"><i style={{ height: "100%" }} /><i style={{ height: "70%" }} /><i style={{ height: "90%" }} /><i style={{ height: "55%" }} /></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A slow band of the five scripts, big and quiet, between the section and the next. */
function ScriptBand() {
  const row = (copy: number) => LANGS.map((l) => (
    <li key={`${copy}-${l.code}`} aria-hidden lang={l.code} className="ld-script flex shrink-0 items-center gap-10 text-6xl font-semibold text-ink/10 sm:text-8xl">
      {l.script}<span className="text-3xl text-accent/40 sm:text-4xl">✦</span>
    </li>
  ));
  return (
    <div className="lg-marquee mt-16 sm:mt-24" aria-hidden>
      <ul className="lg-marquee-track !gap-10 !animate-[lg-marquee_70s_linear_infinite]">{row(0)}{row(1)}</ul>
    </div>
  );
}

export function India() {
  return (
    <section id="india" className="ld-section ld-india relative isolate overflow-hidden py-16 sm:py-24">
      <div aria-hidden className="ld-india-glow" />
      <div className="mx-auto max-w-[80rem] px-4 sm:px-8">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
          <div>
            <SectionHead eyebrow="Made in India"
              title={<>Built in India. <span className="text-gradient">Priced for India.</span></>}
              lead="Most AI video tools are built for somebody else's stories, in somebody else's language, priced in somebody else's money. Tatvam starts from ours." />
            <ul className="mt-10 space-y-7">
              {INDIA_POINTS.map((p, i) => (
                <li key={p.title}>
                  <InView delay={i * 0.08} className="flex gap-4">
                    <span className="mono grid size-9 shrink-0 place-items-center rounded-full border border-accent/30 bg-accent/10 text-xs text-accent-ink">{i + 1}</span>
                    <div>
                      <h3 className="text-lg font-semibold tracking-tight">{p.title}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-mute sm:text-base">{p.text}</p>
                    </div>
                  </InView>
                </li>
              ))}
            </ul>
          </div>
          <InView delay={0.1}><LanguagesCard /></InView>
        </div>
      </div>
      <ScriptBand />
    </section>
  );
}
