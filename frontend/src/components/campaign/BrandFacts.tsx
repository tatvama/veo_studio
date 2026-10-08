/** The locked brand facts: logo, colours, tagline, CTA and product assets from the brand kit. Nothing here is generated. */
import { clsx } from "clsx";
import { Lock, Package } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { BrandKit } from "../../lib/types";
import { Alert, Input } from "../ui";
import type { BrandFacts as Facts } from "./types";

/** A kit (from the picker) or a stored snapshot (from a running campaign) rendered the same way. */
export function factsOf(kit: BrandKit | undefined | null, cta: string): Facts | null {
  if (!kit) return null;
  return {
    brand_kit_id: kit.id, name: kit.name, logo_path: kit.logo_path, logo_url: kit.logo_url, colors: kit.colors ?? [], tagline: kit.tagline,
    cta: cta.trim() || kit.cta, website: kit.website, fonts: kit.fonts ?? {}, product_assets: kit.product_urls ?? [], end_card: kit.end_card ?? {},
    locked_at: "",
  };
}

export function Swatches({ colors, size = "md" }: { colors: string[]; size?: "sm" | "md" }) {
  if (!colors.length) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {colors.slice(0, 6).map((c, i) => (
        // user data: brand colours are the one allowed inline colour
        <span key={`${c}${i}`} title={c} className={clsx("rounded-full ring-1 ring-inset ring-white/15", size === "sm" ? "size-3" : "size-4")} style={{ background: c }} />
      ))}
    </span>
  );
}

export default function BrandFacts({ facts, cta, onCta, compact, className }: {
  facts: Facts | null; cta?: string; onCta?: (v: string) => void; compact?: boolean; className?: string;
}) {
  const t = useT();
  if (!facts) {
    return (
      <Alert tone="warn" title={t("No brand kit picked")} className={className}>
        {t("Pick a brand kit so the logo, colours, tagline and CTA are locked for every variant.")}
      </Alert>
    );
  }
  const ctaValue = cta ?? facts.cta;
  return (
    <section aria-label={t("Locked brand facts")} className={clsx("rounded-xl border border-accent/30 bg-accent/5", className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-accent/20 px-4 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent-ink"><Lock className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight">{t("Locked brand facts")} <span className="font-normal text-mute">· {facts.name}</span></p>
          <p className="text-xs text-mute">{t("These never change, no model may invent them.")}</p>
        </div>
      </header>
      <div className={clsx("grid gap-x-5 gap-y-3 px-4 py-3", compact ? "@md:grid-cols-2" : "@md:grid-cols-[auto_minmax(0,1fr)]")}>
        {!compact && (
          <div className="flex items-start gap-3 @md:flex-col">
            <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-raised">
              {facts.logo_url ? <img src={facts.logo_url} alt={t("Logo")} className="max-h-full max-w-full object-contain p-1.5" /> : <span className="text-2xs text-dim">{t("No logo")}</span>}
            </div>
            <Swatches colors={facts.colors} />
          </div>
        )}
        <dl className="grid gap-x-4 gap-y-2 text-sm @md:grid-cols-[auto_minmax(0,1fr)]">
          {compact && facts.colors.length > 0 && (<><dt className="text-xs font-medium text-mute">{t("Colours")}</dt><dd><Swatches colors={facts.colors} size="sm" /></dd></>)}
          <dt className="text-xs font-medium text-mute">{t("Tagline")}</dt>
          <dd className={clsx("min-w-0 truncate", !facts.tagline && "text-dim")} title={facts.tagline}>{facts.tagline || t("none")}</dd>
          <dt className="self-center text-xs font-medium text-mute">{t("CTA")}</dt>
          <dd className="min-w-0">
            {onCta ? (
              <Input value={ctaValue} onChange={(e) => onCta(e.target.value)} placeholder={facts.cta || t("e.g. Follow for Part 2")} aria-label={t("CTA")} className="!h-8 text-xs" />
            ) : (
              <span className={clsx("truncate", !ctaValue && "text-dim")}>{ctaValue || t("none")}</span>
            )}
          </dd>
          {facts.product_assets.length > 0 && (
            <>
              <dt className="text-xs font-medium text-mute">{t("Products")}</dt>
              <dd className="flex flex-wrap gap-1">
                {facts.product_assets.map((a, i) => (
                  <span key={`${a.path}${i}`} className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-raised px-1.5 py-0.5 text-2xs text-mute">
                    <Package className="size-3 shrink-0" /><span className="truncate">{a.label || t("Product {n}", { n: i + 1 })}</span>
                  </span>
                ))}
              </dd>
            </>
          )}
          <dt className="text-xs font-medium text-mute">{t("End card")}</dt>
          <dd className="text-mute">{facts.end_card?.enabled ? t("{n}s with the tagline and CTA", { n: facts.end_card.seconds ?? 3 }) : t("off in this kit")}</dd>
        </dl>
      </div>
    </section>
  );
}
