import { BadgeCheck, ChevronDown } from "lucide-react";
import { InView } from "../../components/ui";
import { cn } from "../../lib/cn";
import { SLIDES } from "../login/showcase";
import { BUILT_ON, FAQ, RECOGNITION } from "./content";
import { Section, SectionHead, Spot } from "./parts";

/** How each showreel frame sits in the mosaic (4 columns × 3 rows on wide screens, 2 columns on phones). */
const TILES = [
  ["holi", "col-span-2 row-span-2"], ["monsoon", "row-span-2"], ["backwaters", ""], ["lamp", ""], ["nightshoot", "col-span-2"], ["dance", "col-span-2"],
] as const;

export function Gallery() {
  return (
    <Section id="gallery">
      <SectionHead center eyebrow="Showreel" title="Stories that look like home."
        lead="Frames from the Tatvam showreel, each one made with the AI engine named on it." />
      <div className="mt-14 grid auto-rows-[9rem] grid-cols-2 gap-3 sm:auto-rows-[11rem] md:grid-cols-4 lg:auto-rows-[13rem] [grid-auto-flow:dense]">
        {TILES.map(([slug, span], i) => {
          const s = SLIDES.find((x) => x.slug === slug);
          if (!s) return null;
          return (
            <InView key={slug} delay={(i % 3) * 0.07} className={cn("min-h-0", span)}>
              <figure className="group relative size-full overflow-hidden rounded-2xl border border-line">
                <img src={`/showcase/${slug}.webp`} srcSet={`/showcase/${slug}-sm.webp 720w, /showcase/${slug}.webp 1920w`} sizes={span.includes("col-span-2") ? "(min-width: 768px) 50vw, 100vw" : "(min-width: 768px) 25vw, 50vw"}
                  alt={s.title} loading="lazy" decoding="async" className="size-full object-cover transition-transform duration-700 ease-out group-hover:scale-105" />
                <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent p-3 pt-10 text-white sm:p-4 sm:pt-12">
                  <p className="text-sm font-semibold sm:text-base">{s.title}</p>
                  <p className="mono text-2xs text-white/70">Made with {s.model}</p>
                </figcaption>
              </figure>
            </InView>
          );
        })}
      </div>
    </Section>
  );
}

export function BuiltOn() {
  return (
    <Section id="engines">
      <SectionHead center eyebrow="Powered by" title="The AI engines creators already trust."
        lead="Tatvam brings the leading AI providers into one studio and routes each job to the right engine." />

      {RECOGNITION.length > 0 && (
        <ul className="mt-10 flex flex-wrap justify-center gap-3">
          {RECOGNITION.map((r) => (
            <li key={r.name} className="lg-glass flex items-center gap-3 rounded-2xl px-4 py-3">
              <BadgeCheck className="size-6 shrink-0 text-ok" />
              <span><span className="block text-sm font-semibold">{r.name}</span><span className="block text-xs text-mute">{r.line}</span></span>
            </li>
          ))}
        </ul>
      )}

      <ul className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {BUILT_ON.map((p, i) => (
          <li key={p.name}>
            <InView delay={(i % 4) * 0.05} className="h-full">
              <Spot className="ld-card h-full p-5">
                <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-accent/20 to-accent-2/20 text-lg font-semibold text-accent-ink ring-1 ring-inset ring-accent/20">{p.name[0]}</span>
                <h3 className="mt-4 text-base font-semibold tracking-tight">{p.name}</h3>
                <p className="mt-1 text-sm leading-snug text-mute">{p.what}</p>
              </Spot>
            </InView>
          </li>
        ))}
      </ul>
      <p className="mx-auto mt-6 max-w-2xl text-center text-2xs leading-relaxed text-dim">
        All names and marks belong to their respective owners. Tatvam connects to these providers through their public APIs.
      </p>
    </Section>
  );
}

export function Faq() {
  return (
    <Section id="faq" className="max-w-4xl">
      <SectionHead center eyebrow="FAQ" title="Questions, answered." />
      <div className="mt-12 divide-y divide-line rounded-2xl border border-line bg-panel/60">
        {FAQ.map((f) => (
          <details key={f.q} name="ld-faq" className="group px-5 sm:px-7">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-left text-base font-medium sm:text-lg [&::-webkit-details-marker]:hidden">
              {f.q}
              <ChevronDown className="size-5 shrink-0 text-dim transition-transform duration-300 group-open:rotate-180" />
            </summary>
            <p className="pb-6 pr-8 text-sm leading-relaxed text-mute sm:text-base">{f.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}
