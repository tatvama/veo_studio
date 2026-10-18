import { clsx } from "clsx";
import { ArrowRight, ChevronDown, Equal, FlagTriangleRight, ImageUp, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useGenerate } from "../Generate";
import { Button, Menu, Tooltip } from "../ui";
import { quote } from "../../lib/estimates";
import { clearEndFrame, makeEndFrame, uploadEndFrame } from "../../lib/frames";
import { tr, useT } from "../../lib/i18n";
import type { Shot, Take } from "../../lib/types";

const ACCEPT = "image/png,image/jpeg,image/webp";

/** "End frame" (make one) with a menu to upload your own or stop using one. The clip then runs start → end frame. */
export function EndFrameControls({ shot, onDone, busy, onBusy }: {
  shot: Shot; onDone: () => void; busy?: boolean; onBusy?: (b: boolean) => void;
}) {
  const t = useT();
  const { priced } = useGenerate();
  const input = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setWorking(true); onBusy?.(true);
    try { await fn(); } catch { /* api() showed the error */ } finally { setWorking(false); onBusy?.(false); }
  };
  // the price first (a start frame is made too when the shot has none)
  const make = () => run(async () => {
    const r = await priced({ quote: () => quote({ action: "endframe", shot_id: shot.id }), run: () => makeEndFrame(shot.id),
      what: tr("End frame {code}", { code: shot.code }) });
    if (r) onDone();
  });
  const upload = (f: File | undefined) => f && run(async () => {
    await uploadEndFrame(shot.id, f);
    toast.success(tr("Your end frame is set — the clip will run from the start frame to it"));
    onDone();
  });
  const clear = () => run(async () => {
    await clearEndFrame(shot.id);
    toast.success(tr("End frame removed — the clip starts from the start frame only"));
    onDone();
  });
  const synced = shot.frames_link?.from;
  return (
    <div className="inline-flex">
      <Tooltip content={t("Make the frame this shot ends on (from its start frame, the cast and how it ends). The clip then runs from the start frame to it.")}>
        <Button size="sm" className="rounded-r-none" icon={<FlagTriangleRight className="size-3.5" />} loading={working || busy} onClick={() => void make()}>
          {shot.endframe ? t("Remake end frame") : t("End frame")}
        </Button>
      </Tooltip>
      <Menu width={244} items={[
        { icon: <ImageUp className="size-4" />, label: t("Upload your own end frame"), onClick: () => input.current?.click() },
        shot.endframe ? { icon: <Trash2 className="size-4" />, label: t("Stop using an end frame"), danger: true, separator: true, onClick: () => void clear() } : null,
        synced ? { icon: <Equal className="size-4" />, label: t("Starts on {code}'s end frame", { code: synced }), disabled: true, separator: true } : null,
      ]} trigger={(p) => (
        <Button size="sm" className="-ml-px rounded-l-none px-1.5" aria-label={t("End frame options")} {...p}><ChevronDown className="size-3.5" /></Button>
      )} />
      <input ref={input} type="file" hidden accept={ACCEPT} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void upload(f); }} />
    </div>
  );
}

function Thumb({ take, label, active, onClick, aspect, empty }: {
  take: Take | null | undefined; label: string; active: boolean; onClick?: () => void; aspect: string; empty: string;
}) {
  const src = take?.thumb_url || take?.url || "";
  return (
    <button type="button" onClick={onClick} disabled={!take} aria-pressed={active} aria-label={label}
      className={clsx("scr [--scr-l:6px] group/fr relative block w-[72px] shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        !take && "scr-empty cursor-default", active && "is-lit")}
      style={{ aspectRatio: aspect.replace(":", " / ") }}>
      {src ? <img src={src} alt="" loading="lazy" className="size-full object-cover" /> : (
        <span className="grid size-full place-items-center px-1 text-center text-2xs leading-tight text-white/55">{empty}</span>
      )}
      <span className="mono pointer-events-none absolute bottom-0 left-0 z-[5] rounded-tr bg-black/70 px-1 text-2xs font-semibold leading-[14px] text-white">{label}</span>
    </button>
  );
}

/** Start → end frame of a shot, side by side, with how the shot is linked (synced to the end frame before it). Click a frame
 *  to show it in the viewer. */
export function FramePair({ shot, aspect, viewing, onView }: {
  shot: Shot; aspect: string; viewing?: "keyframe" | "endframe" | null; onView?: (which: "keyframe" | "endframe") => void;
}) {
  const t = useT();
  const link = shot.frames_link;
  const runsToEnd = !!shot.endframe;
  const linkText = !link ? "" : link.status === "ok" ? t("Starts exactly on {code}'s end frame (synced)", { code: link.from })
    : link.status === "waiting" ? t("Will start on {code}'s end frame once it has one", { code: link.from })
    : link.status === "pending" ? t("Starts on {code}'s end frame: not made yet", { code: link.from })
    : t("Its start frame is no longer {code}'s end frame — make the start frame again to sync", { code: link.from });
  return (
    <div className="flex items-center gap-2.5">
      <Thumb take={shot.keyframe} label={t("Start")} aspect={aspect} active={viewing === "keyframe"} empty={t("no start frame")}
        onClick={() => onView?.("keyframe")} />
      <ArrowRight className={clsx("size-4 shrink-0", runsToEnd ? "text-accent-ink" : "text-dim/60")} aria-hidden />
      <Thumb take={shot.endframe} label={t("End")} aspect={aspect} active={viewing === "endframe"} empty={t("no end frame")}
        onClick={() => onView?.("endframe")} />
      <div className="min-w-0 flex-1 space-y-1 text-2xs leading-snug">
        <p className={clsx("font-medium", runsToEnd ? "text-ink" : "text-mute")}>
          {runsToEnd ? t("The clip runs from the start frame to the end frame") : t("The clip starts from the start frame")}
        </p>
        {link && (
          <p className={clsx("flex items-start gap-1", link.status === "ok" ? "text-ok" : link.status === "broken" ? "text-warn" : "text-dim")}>
            <Equal className="mt-px size-3 shrink-0" />{linkText}
          </p>
        )}
        {shot.end_note && <p className="line-clamp-2 text-dim" title={shot.end_note}>{t("Ends on: {note}", { note: shot.end_note })}</p>}
      </div>
    </div>
  );
}
