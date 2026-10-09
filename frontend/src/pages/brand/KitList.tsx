import { clsx } from "clsx";
import { Palette, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { agoT } from "../../components/growth/common";
import { hex6 } from "../../components/growth/BrandPreview";
import { Panel, ScrollStrip, SearchField, Tag, rise } from "../../components/ui";
import { useT } from "../../lib/i18n";
import type { BrandKit, Project } from "../../lib/types";
import "../../styles/brand.css";

function LogoTile({ kit, size }: { kit: BrandKit; size: string }) {
  return (
    // user data: the kit's first colour is the tile's background
    <span className={clsx("grid shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-raised", size)} style={{ background: hex6(kit.colors?.[0]) ?? undefined }}>
      {kit.logo_url ? <img src={kit.logo_url} alt="" className="max-h-[70%] max-w-[70%] object-contain" /> : <Palette className="size-4 text-white/70 mix-blend-difference" />}
    </span>
  );
}

/** The kit's colours as one bar. */
export function Strip({ colors }: { colors: string[] }) {
  const list = (colors ?? []).slice(0, 6);
  return (
    <span aria-hidden className="bk-strip">
      {list.length ? list.map((c, i) => <i key={i} style={{ background: hex6(c) ?? undefined }} />) : <i />}
    </span>
  );
}

const fontsOf = (k: BrandKit) => [k.fonts?.heading, k.fonts?.body].filter(Boolean).join(" / ");

/** The kit gallery: one card per kit (logo, colour strip, fonts, usage), a dashed "new kit" card, and a search box once there are many. */
export function KitList({ kits, selectedId, onSelect, onNew, canEdit, projects }: {
  kits: BrandKit[]; selectedId: number | undefined; onSelect: (id: number) => void; onNew: () => void; canEdit: boolean; projects: Project[] | undefined;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const usage = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of projects ?? []) if (p.brand_kit_id) m.set(p.brand_kit_id, (m.get(p.brand_kit_id) ?? 0) + 1);
    return m;
  }, [projects]);
  const needle = q.trim().toLowerCase();
  const shown = needle ? kits.filter((k) => k.name.toLowerCase().includes(needle)) : kits;
  const tall = kits.length > 8;

  return (
    <Panel eyebrow={t("Kit library")} icon={<Palette />} index={1}
      title={<span className="mono text-sm">{kits.length === 1 ? t("1 brand kit") : t("{n} brand kits", { n: kits.length })}</span>}
      actions={kits.length > 6 ? <SearchField value={q} onChange={setQ} placeholder={t("Search kits…")} aria-label={t("Search kits")} className="w-44 sm:w-56" /> : undefined}>
      <ScrollStrip role="list" aria-label={t("Brand kits")}
        className={clsx("-mx-1 flex gap-3 px-1 pb-1 sm:mx-0 sm:grid sm:grid-cols-[repeat(auto-fill,minmax(15.5rem,1fr))] sm:overflow-visible sm:px-0 sm:pb-0", tall && "sm:max-h-[24rem] sm:overflow-y-auto sm:pr-1")}>
        {shown.map((k, i) => {
          const on = k.id === selectedId;
          const n = usage.get(k.id) ?? 0;
          const products = k.product_urls?.length ?? 0;
          const fonts = fontsOf(k);
          const r = kits.length > 24 ? { className: "", style: undefined } : rise(i);
          return (
            <div key={k.id} role="listitem" className={clsx("w-[15.5rem] shrink-0 sm:w-auto", r.className)} style={r.style}>
              <button type="button" aria-pressed={on} data-active={on} onClick={() => onSelect(k.id)} className="bk-card hud h-full">
                <span className="flex items-start gap-3">
                  <LogoTile kit={k} size="size-12" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold" title={k.name}>{k.name}</span>
                    <span className="mono mt-1 block truncate text-2xs text-dim">{n ? (n === 1 ? t("Used by 1 project") : t("Used by {n} projects", { n })) : t("Created {when}", { when: agoT(k.created_at) })}</span>
                  </span>
                  {on && <span className="eyebrow mt-0.5 shrink-0 !text-accent-ink">{t("Editing")}</span>}
                </span>
                <Strip colors={k.colors} />
                <span className="mono block min-h-4 truncate text-2xs text-mute" title={fonts}>{fonts || <span className="text-dim">{t("No fonts set")}</span>}</span>
                <span className="mt-auto flex flex-wrap gap-1.5">
                  <Tag k={t("Used")}>{n}</Tag>
                  <Tag k={t("Assets")}>{products}</Tag>
                  <Tag k={t("End card")} tone={k.end_card?.enabled ? "ok" : "neutral"}>{k.end_card?.enabled ? t("on") : t("off")}</Tag>
                </span>
              </button>
            </div>
          );
        })}
        {canEdit && (
          <div role="listitem" className="w-[15.5rem] shrink-0 sm:w-auto">
            <button type="button" onClick={onNew} className="bk-card is-new h-full">
              <span className="grid size-10 place-items-center rounded-lg border border-line bg-raised"><Plus className="size-5" /></span>
              <span className="text-sm font-medium">{t("New kit")}</span>
            </button>
          </div>
        )}
        {!shown.length && <div role="listitem" className="px-2 py-4 text-sm text-dim">{t("No kits match.")}</div>}
      </ScrollStrip>
      <p className="mt-3 text-2xs text-dim">{t("Kits are shared by the whole team.")}</p>
    </Panel>
  );
}
