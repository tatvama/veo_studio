import { clsx } from "clsx";
import { Palette, Plus } from "lucide-react";
import { motion } from "motion/react";
import { useId, useMemo, useState } from "react";
import { agoT } from "../../components/growth/common";
import { hex6 } from "../../components/growth/BrandPreview";
import { ScrollStrip, SearchField, rise } from "../../components/ui";
import { useT } from "../../lib/i18n";
import type { BrandKit, Project } from "../../lib/types";

const SPRING = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;

function LogoTile({ kit, size }: { kit: BrandKit; size: string }) {
  return (
    <span className={clsx("grid shrink-0 place-items-center overflow-hidden rounded-lg border border-line", size)} style={{ background: hex6(kit.colors?.[0]) ?? undefined }}>
      {kit.logo_url ? <img src={kit.logo_url} alt="" className="max-h-[70%] max-w-[70%] object-contain" /> : <Palette className="size-4 text-white/70 mix-blend-difference" />}
    </span>
  );
}

function Dots({ colors }: { colors: string[] }) {
  return (
    <span className="flex items-center -space-x-1">
      {(colors ?? []).slice(0, 6).map((c, i) => <span key={i} className="size-3.5 rounded-full border-2 border-panel ring-1 ring-line" style={{ background: hex6(c) ?? undefined }} />)}
    </span>
  );
}

/** The kit picker: a vertical list on wide screens, sideways chips below 1024px. */
export function KitList({ kits, selectedId, onSelect, onNew, canEdit, projects }: {
  kits: BrandKit[]; selectedId: number | undefined; onSelect: (id: number) => void; onNew: () => void; canEdit: boolean; projects: Project[] | undefined;
}) {
  const t = useT();
  const uid = useId();
  const [q, setQ] = useState("");
  const usage = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of projects ?? []) if (p.brand_kit_id) m.set(p.brand_kit_id, (m.get(p.brand_kit_id) ?? 0) + 1);
    return m;
  }, [projects]);
  const needle = q.trim().toLowerCase();
  const shown = needle ? kits.filter((k) => k.name.toLowerCase().includes(needle)) : kits;

  return (
    <>
      {/* phones and tablets */}
      <div className="lg:hidden">
        <ScrollStrip className="-mx-1 flex gap-2 px-1 pb-1">
          {kits.map((k) => {
            const on = k.id === selectedId;
            return (
              <button key={k.id} type="button" data-active={on} aria-pressed={on} onClick={() => onSelect(k.id)}
                className={clsx("flex h-11 shrink-0 items-center gap-2 rounded-xl border pl-1.5 pr-3 text-sm font-medium transition-colors",
                  on ? "border-accent/55 bg-accent/10 text-ink" : "border-line bg-panel text-mute hover:text-ink")}>
                <LogoTile kit={k} size="size-8" />
                <span className="max-w-[10rem] truncate">{k.name}</span>
              </button>
            );
          })}
          {canEdit && (
            <button type="button" onClick={onNew} className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-line px-3 text-sm font-medium text-mute transition-colors hover:border-accent/60 hover:text-accent-ink">
              <Plus className="size-4" />{t("New kit")}
            </button>
          )}
        </ScrollStrip>
      </div>

      {/* desktop */}
      <div className="hidden lg:sticky lg:top-6 lg:block lg:self-start">
        {kits.length > 6 && <SearchField value={q} onChange={setQ} placeholder={t("Search kits…")} aria-label={t("Search kits")} className="mb-3" />}
        <ul className="space-y-2">
          {shown.map((k, i) => {
            const on = k.id === selectedId;
            const n = usage.get(k.id) ?? 0;
            const r = rise(i);
            return (
              <li key={k.id} className={r.className} style={r.style}>
                <button type="button" aria-pressed={on} onClick={() => onSelect(k.id)}
                  className={clsx("relative flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-[border-color,background-color,box-shadow,transform] duration-150",
                    on ? "border-accent/50 shadow-card" : "border-line bg-panel hover:-translate-y-px hover:border-dim/50 hover:shadow-lift")}>
                  {on && <motion.span layoutId={`kit-active-${uid}`} transition={SPRING} className="absolute inset-0 rounded-xl bg-accent/[0.07]" />}
                  <LogoTile kit={k} size="relative size-11" />
                  <span className="relative min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{k.name}</span>
                    <span className="mt-0.5 block truncate text-2xs text-dim">{n ? (n === 1 ? t("Used by 1 project") : t("Used by {n} projects", { n })) : t("Created {when}", { when: agoT(k.created_at) })}</span>
                    <span className="mt-1.5 block"><Dots colors={k.colors} /></span>
                  </span>
                </button>
              </li>
            );
          })}
          {!shown.length && <li className="px-2 py-4 text-center text-sm text-dim">{t("No kits match.")}</li>}
        </ul>
        {canEdit && (
          <button type="button" onClick={onNew}
            className="mt-2 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line text-sm font-medium text-mute transition-colors hover:border-accent/60 hover:bg-accent/5 hover:text-accent-ink">
            <Plus className="size-4" />{t("New kit")}
          </button>
        )}
        <p className="px-1 pt-3 text-2xs text-dim">{t("Kits are shared by the whole team.")}</p>
      </div>
    </>
  );
}
