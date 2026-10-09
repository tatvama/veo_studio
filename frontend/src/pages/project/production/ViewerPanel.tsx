import { clsx } from "clsx";
import { Check, Cpu, Swords } from "lucide-react";
import { takeEngine } from "../../../components/hub/util";
import { Badge, ScrollStrip, Tooltip } from "../../../components/ui";
import { LANG_SHORT, ago, secs, usd } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import type { Take } from "../../../lib/types";
import { ratioOf } from "./shotMeta";

export const KIND_LABELS: Record<string, string> = {
  lipsync: "Lip-sync", voicelock: "Voice lock", video: "Video", keyframe: "Keyframe", voice: "Voice", narration: "Narration",
};
const KIND_LETTER: Record<string, string> = { lipsync: "L", voicelock: "VL", video: "V", keyframe: "K" };

/** What the viewer is showing, as a readout: kind, language, engine, then id / length / cost / age in mono. */
export function TakeInfo({ take, className }: { take: Take | null; className?: string }) {
  const t = useT();
  if (!take) return null;
  const engine = takeEngine(take) || take.provider;
  const kind = t(KIND_LABELS[take.kind] ?? take.kind);
  return (
    <div className={clsx("hud relative space-y-2 rounded-lg border border-line bg-raised/40 p-2.5", className)}>
      <div className="flex flex-wrap items-center gap-1">
        <Badge tone="neutral">{kind}{take.language ? ` · ${LANG_SHORT[take.language] ?? take.language}` : ""}</Badge>
        {take.selected && <Badge tone="accent"><Check className="size-3" strokeWidth={3} />{t("in use")}</Badge>}
        {take.params?.shootout && <Badge tone="info" title={t("Made in a shootout")}><Swords className="size-3" />{t("shootout")}</Badge>}
      </div>
      {engine && (
        <p className="mono flex items-start gap-1.5 text-xs font-medium leading-snug" title={take.params?.engine || take.model}>
          <Cpu className="mt-0.5 size-3.5 shrink-0 text-mute" /><span className="min-w-0 break-words">{engine}</span>
        </p>
      )}
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(3.5rem,1fr))] gap-x-3 gap-y-1.5 border-t border-line/70 pt-2">
        <div className="min-w-0"><dt className="eyebrow">{t("Take")}</dt><dd className="mono mt-1 text-xs tabular-nums">#{take.id}</dd></div>
        {take.duration_s > 0 && <div className="min-w-0"><dt className="eyebrow">{t("Length")}</dt><dd className="mono mt-1 text-xs tabular-nums">{secs(take.duration_s)}</dd></div>}
        <div className="min-w-0"><dt className="eyebrow">{t("Cost")}</dt><dd className="mono mt-1 text-xs tabular-nums text-money">{usd(take.cost_usd)}</dd></div>
        <div className="min-w-0"><dt className="eyebrow">{t("Made")}</dt><dd className="mono mt-1 truncate text-xs tabular-nums text-mute">{ago(take.created_at)}</dd></div>
      </dl>
    </div>
  );
}

/** Thumbnails of every visual take, newest first. Clicking one previews it in the viewer without changing what is in use. */
export function TakeStrip({ takes, active, aspect, onPick }: { takes: Take[]; active: number | null; aspect: string; onPick: (t: Take) => void }) {
  const t = useT();
  const r = ratioOf(aspect);
  const portrait = r.h > r.w;
  if (takes.length < 2) return null;
  return (
    <div>
      <p className="eyebrow mb-1.5 flex items-center gap-2">{t("Takes of this shot")}<span className="mono text-dim">{takes.length}</span><span aria-hidden className="h-px flex-1 bg-line" /></p>
      <ScrollStrip className="-mx-1 px-1 py-1" follow='[data-active="true"]'>
        <div className="flex w-max gap-1.5">
          {takes.slice(0, 14).map((x) => {
            const on = active === x.id;
            const src = x.thumb_url || (x.kind === "keyframe" ? x.url : "");
            const tip = `${t(KIND_LABELS[x.kind] ?? x.kind)}${x.language ? ` ${LANG_SHORT[x.language] ?? x.language}` : ""} #${x.id} · ${takeEngine(x) || x.provider} · ${ago(x.created_at)}`;
            return (
              <Tooltip key={x.id} content={tip}>
                <button type="button" onClick={() => onPick(x)} aria-pressed={on} aria-label={tip} data-active={on || undefined}
                  className={clsx("relative shrink-0 overflow-hidden rounded-md border bg-raised outline-none transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-accent/60",
                    portrait ? "h-14 w-8" : "h-9 w-16", on ? "border-accent shadow-[0_0_0_1px_var(--color-accent),0_0_14px_-3px_var(--color-accent)]" : "border-line hover:border-dim/60")}>
                  {src ? <img src={src} alt="" loading="lazy" className="size-full object-cover" /> : <span className="mono grid size-full place-items-center text-2xs text-dim">{KIND_LETTER[x.kind]}</span>}
                  <span className="mono absolute bottom-0 left-0 rounded-tr bg-black/70 px-1 text-2xs font-semibold leading-[14px] text-white">{KIND_LETTER[x.kind] ?? "?"}</span>
                  {x.selected && <span className="absolute right-0.5 top-0.5 grid size-3 place-items-center rounded-full bg-accent text-[var(--on-accent)]"><Check className="size-2" strokeWidth={4} /></span>}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </ScrollStrip>
    </div>
  );
}
