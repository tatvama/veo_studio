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

/** What the viewer is showing: kind, language, engine, cost and age of one take. */
export function TakeInfo({ take, className }: { take: Take | null; className?: string }) {
  const t = useT();
  if (!take) return null;
  const engine = takeEngine(take) || take.provider;
  const kind = t(KIND_LABELS[take.kind] ?? take.kind);
  return (
    <div className={clsx("space-y-1.5 rounded-lg border border-line bg-raised/40 p-2.5", className)}>
      <div className="flex flex-wrap items-center gap-1">
        <Badge tone="neutral">{kind}{take.language ? ` · ${LANG_SHORT[take.language] ?? take.language}` : ""}</Badge>
        {take.selected && <Badge tone="accent"><Check className="size-3" strokeWidth={3} />{t("in use")}</Badge>}
        {take.params?.shootout && <Badge tone="info" title={t("Made in a shootout")}><Swords className="size-3" />{t("shootout")}</Badge>}
      </div>
      {engine && (
        <p className="flex items-start gap-1.5 text-xs font-medium leading-snug" title={take.params?.engine || take.model}>
          <Cpu className="mt-0.5 size-3.5 shrink-0 text-mute" /><span className="min-w-0 break-words">{engine}</span>
        </p>
      )}
      <p className="text-2xs tabular-nums text-dim">
        #{take.id}{take.duration_s > 0 && ` · ${secs(take.duration_s)}`}{` · ${usd(take.cost_usd)} · ${ago(take.created_at)}`}
      </p>
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
      <p className="mb-1 text-2xs font-medium text-dim">{t("Takes of this shot")}</p>
      <ScrollStrip className="-mx-1 px-1 pb-1" follow='[data-active="true"]'>
        <div className="flex w-max gap-1.5">
          {takes.slice(0, 14).map((x) => {
            const on = active === x.id;
            const src = x.thumb_url || (x.kind === "keyframe" ? x.url : "");
            const tip = `${t(KIND_LABELS[x.kind] ?? x.kind)}${x.language ? ` ${LANG_SHORT[x.language] ?? x.language}` : ""} #${x.id} · ${takeEngine(x) || x.provider} · ${ago(x.created_at)}`;
            return (
              <Tooltip key={x.id} content={tip}>
                <button type="button" onClick={() => onPick(x)} aria-pressed={on} aria-label={tip} data-active={on || undefined}
                  className={clsx("relative shrink-0 overflow-hidden rounded-md border bg-raised transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5",
                    portrait ? "h-14 w-8" : "h-9 w-16", on ? "border-accent shadow-glow" : "border-line hover:border-dim/60")}>
                  {src ? <img src={src} alt="" loading="lazy" className="size-full object-cover" /> : <span className="grid size-full place-items-center text-2xs text-dim">{KIND_LETTER[x.kind]}</span>}
                  <span className="absolute bottom-0 left-0 rounded-tr bg-black/65 px-1 font-mono text-2xs font-semibold leading-[14px] text-white">{KIND_LETTER[x.kind] ?? "?"}</span>
                  {x.selected && <span className="absolute right-0.5 top-0.5 grid size-3 place-items-center rounded-full bg-accent text-black"><Check className="size-2" strokeWidth={4} /></span>}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </ScrollStrip>
    </div>
  );
}
