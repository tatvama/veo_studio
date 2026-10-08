/** Live preview of a brand kit: a video frame with caption + lower-third, and the end card the renderer adds. */
import { clsx } from "clsx";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { Segmented } from "../ui";

export interface PreviewKit {
  name: string; colors: string[]; fonts: Record<string, string>; tagline: string; cta: string; website: string;
  logo_url?: string; end_card: { enabled?: boolean; seconds?: number; text?: string };
}

const family = (f?: string) => (f?.trim() ? `"${f.trim()}", "Segoe UI", "Nirmala UI", system-ui, sans-serif` : undefined);
/** "#abc" / "#aabbcc" / "#aabbccdd" → "#aabbcc" (so an alpha suffix can be appended); null when not a hex colour. */
export function hex6(c?: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec((c ?? "").trim());
  if (!m) return null;
  const h = m[1];
  return `#${h.length === 3 ? h.split("").map((x) => x + x).join("") : h.slice(0, 6)}`.toLowerCase();
}

export default function BrandPreview({ kit }: { kit: PreviewKit }) {
  const t = useT();
  const reduce = useReducedMotion();
  const [view, setView] = useState<"frame" | "end">("frame");
  const [shape, setShape] = useState<"9:16" | "16:9">("9:16");
  const base = hex6(kit.colors[0]) ?? "#111111";
  const accent = hex6(kit.colors[1]) ?? "#f97316";
  const heading = family(kit.fonts.heading);
  const body = family(kit.fonts.body);
  const words = t("Every great story starts with one brave step").split(" ");
  const [word, setWord] = useState(2);

  useEffect(() => {
    if (reduce || view !== "frame") return;
    const id = setInterval(() => setWord((w) => (w + 1) % (words.length + 2)), 420);
    return () => clearInterval(id);
  }, [reduce, view, words.length]);

  const endText = kit.end_card.text || kit.cta;
  const vertical = shape === "9:16";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented value={view} onChange={setView} aria-label={t("Preview")}
          options={[{ value: "frame", label: t("Video frame") }, { value: "end", label: t("End card") }]} />
        <Segmented value={shape} onChange={setShape} aria-label={t("Shape")} options={[{ value: "9:16", label: "9:16" }, { value: "16:9", label: "16:9" }]} />
      </div>

      <div className="rounded-xl bg-raised/50 p-3 ring-1 ring-inset ring-line">
        {/* device: a phone bezel for vertical video, a plain frame for wide video */}
        <div className={clsx("mx-auto bg-black shadow-lift ring-1 ring-white/10", vertical ? "max-w-[236px] rounded-[26px] p-[5px]" : "w-full rounded-xl p-[3px]")}>
          <div className={clsx("relative overflow-hidden", vertical ? "aspect-[9/16] rounded-[21px]" : "aspect-video rounded-[9px]")}>
            <AnimatePresence mode="wait" initial={false}>
              {view === "frame" ? (
                <motion.div key={`frame-${shape}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} className="absolute inset-0"
                  style={{ background: `radial-gradient(120% 80% at 30% 20%, ${base}cc 0%, rgba(10,10,14,0.92) 55%), linear-gradient(200deg, ${accent}33, rgba(0,0,0,0.9))` }}>
                  {/* stand-in subject */}
                  <div className="absolute left-1/2 top-[22%] h-[38%] w-[34%] -translate-x-1/2 rounded-[45%] opacity-25"
                    style={{ background: "radial-gradient(circle at 50% 35%, rgba(255,255,255,0.9), rgba(255,255,255,0) 70%)" }} />
                  {vertical && <span aria-hidden className="absolute left-1/2 top-1.5 h-1 w-9 -translate-x-1/2 rounded-full bg-white/20" />}
                  {kit.logo_url && (
                    <img src={kit.logo_url} alt="" className={clsx("absolute right-3 object-contain opacity-90", vertical ? "top-5 h-7 max-w-[30%]" : "top-3 h-8 max-w-[20%]")} />
                  )}
                  {/* lower third */}
                  <motion.div key={`${shape}-lt`} initial={reduce ? false : { x: -24, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
                    transition={{ duration: 0.35, ease: "easeOut" }}
                    className={clsx("absolute left-3 flex overflow-hidden rounded-md", vertical ? "bottom-[30%] max-w-[85%]" : "bottom-[28%] max-w-[55%]")}>
                    <span className="w-1.5 shrink-0" style={{ background: accent }} />
                    <div className="px-2.5 py-1.5" style={{ background: `${base}e6` }}>
                      <p className="truncate text-[13px] font-bold leading-tight text-white" style={{ fontFamily: heading }}>{kit.name || t("Brand name")}</p>
                      <p className="truncate text-2xs leading-tight text-white/75" style={{ fontFamily: body }}>{kit.tagline || kit.website || t("Your tagline")}</p>
                    </div>
                  </motion.div>
                  {/* caption */}
                  <p className={clsx("absolute inset-x-3 text-center font-extrabold leading-snug", vertical ? "bottom-[12%] text-[15px]" : "bottom-[9%] text-[17px]")}
                    style={{ fontFamily: body, textShadow: "0 2px 6px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.9)" }}>
                    {words.map((w, i) => (
                      <span key={i} style={{ color: i < word ? accent : "#FFFFFF" }} className="transition-colors duration-150">{w}{i < words.length - 1 ? " " : ""}</span>
                    ))}
                  </p>
                </motion.div>
              ) : (
                <motion.div key={`end-${shape}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}
                  className="absolute inset-0 flex flex-col items-center justify-center gap-[6%] px-6 text-center" style={{ background: base }}>
                  {kit.logo_url ? (
                    <motion.img src={kit.logo_url} alt="" initial={reduce ? false : { scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                      transition={{ duration: 0.3, ease: "easeOut" }} className={clsx("object-contain", vertical ? "max-h-[18%] max-w-[60%]" : "max-h-[24%] max-w-[40%]")} />
                  ) : <div className="rounded-lg border border-dashed border-white/30 px-4 py-2 text-2xs text-white/60">{t("Logo")}</div>}
                  {kit.tagline && <p className={clsx("font-bold leading-tight text-white", vertical ? "text-lg" : "text-2xl")} style={{ fontFamily: heading }}>{kit.tagline}</p>}
                  {endText && <p className={clsx("font-semibold", vertical ? "text-sm" : "text-base")} style={{ color: accent, fontFamily: body }}>{endText}</p>}
                  {kit.website && <p className="text-xs text-white/75" style={{ fontFamily: body }}>{kit.website}</p>}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <p className="text-center text-2xs text-dim">
        {view === "end"
          ? (kit.end_card.enabled ? t("Added for {n}s at the end of final renders.", { n: kit.end_card.seconds ?? 3 }) : t("End card is off — turn it on below to add it to final renders."))
          : t("Approximate preview. Fonts show only if they're installed on this computer.")}
      </p>
    </div>
  );
}
