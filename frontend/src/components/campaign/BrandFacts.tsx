/** The locked brand facts, as a compact fact sheet: logo, colours, tagline, CTA and product assets from the brand kit. Nothing here is generated. */
import { clsx } from "clsx";
import { Lock, Package } from "lucide-react";
import type { ReactNode } from "react";
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
        <span key={`${c}${i}`} title={c} className={clsx("rounded-md border border-line", size === "sm" ? "size-3.5" : "size-5")} style={{ background: c }} />
      ))}
    </span>
  );
}

/** One key / value row of the sheet: a mono eyebrow on the left, the value on the right. */
function Row({ k, children, center }: { k: ReactNode; children: ReactNode; center?: boolean }) {
  return (
    <div className={clsx("grid grid-cols-[5.25rem_minmax(0,1fr)] gap-3 px-3.5 py-2", center ? "items-center" : "items-start")}>
      <dt className="eyebrow pt-[3px]">{k}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
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
  const fonts = [facts.fonts?.heading, facts.fonts?.body].filter(Boolean) as string[];
  return (
    <section aria-label={t("Locked brand facts")} data-tone="accent" className={clsx("cx-block overflow-hidden", className)}>
      <header className="flex items-center gap-3 border-b border-line px-3.5 py-2.5">
        <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-raised">
          {facts.logo_url ? <img src={facts.logo_url} alt={t("Logo")} className="max-h-full max-w-full object-contain p-1" /> : <span className="text-2xs text-dim">{t("No logo")}</span>}
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow flex items-center gap-1.5 !text-accent-ink"><Lock className="size-3" />{t("Locked brand facts")}</p>
          <p className="mt-1.5 truncate text-sm font-semibold leading-none" title={facts.name}>{facts.name}</p>
        </div>
      </header>
      <dl className="divide-y divide-line">
        {facts.colors.length > 0 && (
          <Row k={t("Colours")} center>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Swatches colors={facts.colors} size={compact ? "sm" : "md"} />
              {!compact && <span className="mono truncate text-2xs uppercase text-dim">{facts.colors.slice(0, 3).join(" ")}</span>}
            </span>
          </Row>
        )}
        <Row k={t("Tagline")}>
          <span className={clsx("block break-words", !facts.tagline && "text-dim")}>{facts.tagline || t("none")}</span>
        </Row>
        <Row k={t("CTA")} center>
          {onCta ? (
            <Input value={ctaValue} onChange={(e) => onCta(e.target.value)} placeholder={facts.cta || t("e.g. Follow for Part 2")} aria-label={t("CTA")} className="!h-8 text-xs" />
          ) : (
            <span className={clsx("block break-words font-medium", !ctaValue && "font-normal text-dim")}>{ctaValue || t("none")}</span>
          )}
        </Row>
        {!compact && facts.website && <Row k={t("Website")}><span className="mono block truncate text-xs text-mute" title={facts.website}>{facts.website}</span></Row>}
        {!compact && fonts.length > 0 && <Row k={t("Fonts")}><span className="mono block truncate text-xs text-mute" title={fonts.join(" / ")}>{fonts.join(" / ")}</span></Row>}
        {facts.product_assets.length > 0 && (
          <Row k={t("Products")}>
            <span className="flex flex-wrap gap-1">
              {facts.product_assets.map((a, i) => (
                <span key={`${a.path}${i}`} className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-raised px-1.5 py-0.5 text-2xs text-mute">
                  <Package className="size-3 shrink-0" /><span className="truncate">{a.label || t("Product {n}", { n: i + 1 })}</span>
                </span>
              ))}
            </span>
          </Row>
        )}
        <Row k={t("End card")}>
          <span className="text-xs text-mute">{facts.end_card?.enabled ? t("{n}s with the tagline and CTA", { n: facts.end_card.seconds ?? 3 }) : t("off in this kit")}</span>
        </Row>
      </dl>
      <p className="border-t border-line px-3.5 py-2 text-2xs text-dim">{t("These never change, no model may invent them.")}</p>
    </section>
  );
}
