import { clsx } from "clsx";
import { CalendarClock, Check, Download, ExternalLink, Globe, ImageIcon, Link2, Lock, MonitorPlay, Plug, ShieldAlert, Sparkles, Upload } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import "../../styles/console.css";
import { api } from "../../lib/api";
import { LANG_NAMES, secs } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useIntegrations, useMarketing, useSettings } from "../../lib/queries";
import type { Episode, ExportRow, Project, SubmitResult } from "../../lib/types";
import { useGenerate } from "../Generate";
import { Alert, Avatar, Badge, Button, Field, Input, Modal, Select, Skeleton, Textarea, Toggle } from "../ui";
import { agoT, CharCount, Notice } from "./common";
import { bestCopy, chosenThumbnail } from "./MarketingPanel";

type Privacy = "private" | "unlisted" | "public";

export default function PublishModal({ x, onClose, project, episode }: {
  x: ExportRow | null; onClose: () => void; project: Project; episode: Episode;
}) {
  const t = useT();
  const { submit } = useGenerate();
  const { data: integ, isLoading } = useIntegrations();
  const { data: pack } = useMarketing(episode.id);
  const { data: settings } = useSettings();
  const accounts = useMemo(() => (integ?.accounts ?? []).filter((a) => a.provider === "youtube"), [integ]);
  const [account, setAccount] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [privacy, setPrivacy] = useState<Privacy>("unlisted");
  const [scheduleAt, setScheduleAt] = useState(""); // datetime-local value, viewer's time zone
  const [useThumb, setUseThumb] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmPublic, setConfirmPublic] = useState(false);

  const short = !!x && (x.preset === "shorts" || x.preset === "reels");
  const copy = x ? bestCopy(pack, x.language, short ? "shorts" : "youtube") ?? bestCopy(pack, x.language, "youtube") : null;
  const thumb = chosenThumbnail(episode, pack);
  const prior = x?.published?.youtube;

  // Prefill from the marketing pack each time the dialog opens for a render.
  useEffect(() => {
    if (!x) return;
    setTitle(copy?.titles?.[0] ?? (episode.title || project.title));
    setDescription(copy?.description ?? "");
    setTags((copy?.hashtags ?? []).map((h) => h.replace(/^#/, "")).join(", "));
    setPrivacy("unlisted");
    setScheduleAt("");
    setUseThumb(true);
    setConfirmPublic(false);
  }, [x?.id, pack?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (accounts.length && (account === null || !accounts.some((a) => a.id === account))) setAccount(accounts[0].id);
  }, [accounts, account]);

  const tagList = tags.split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
  const titleTooLong = title.length > 100;
  const scheduleDate = scheduleAt ? new Date(scheduleAt) : null;
  const scheduleBad = !!scheduleDate && (isNaN(scheduleDate.getTime()) || scheduleDate.getTime() < Date.now() + 5 * 60_000);
  const goesPublic = !scheduleDate && privacy === "public";

  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (!x || !account) return;
    if (scheduleBad) return;
    // Publishing publicly needs a second, explicit click.
    if (goesPublic && !confirmPublic) { setConfirmPublic(true); return; }
    setBusy(true);
    try {
      const res = await submit(() => api.post<SubmitResult>(`/api/exports/${x.id}/publish`, {
        integration_id: account, title: title.trim() || null, description: description.trim() || null,
        tags: tagList.length ? tagList.slice(0, 30) : null, privacy: scheduleDate ? "private" : privacy,
        publish_at: scheduleDate ? scheduleDate.toISOString() : null, use_thumbnail: !!thumb && useThumb,
      }), t("Publish to YouTube"));
      if (res) onClose();
    } finally {
      setBusy(false);
    }
  };

  const noChannel = !isLoading && !accounts.length;
  const channel = accounts.find((a) => a.id === account) ?? accounts[0];
  const privacyOptions: { value: Privacy; icon: React.ReactNode; label: string; hint: string }[] = [
    { value: "private", icon: <Lock className="size-4" />, label: t("Private"), hint: t("Only you can watch") },
    { value: "unlisted", icon: <Link2 className="size-4" />, label: t("Unlisted"), hint: t("Anyone with the link") },
    { value: "public", icon: <Globe className="size-4" />, label: t("Public"), hint: t("Everyone on YouTube") },
  ];

  return (
    <Modal
      open={!!x}
      onClose={onClose}
      size="lg"
      title={<span className="flex items-center gap-2"><span className="grid size-7 place-items-center rounded-lg border border-accent/25 bg-accent/10 text-accent-ink"><MonitorPlay className="size-4" /></span>{t("Publish to YouTube")}</span>}
      footer={noChannel ? (
        <Button variant="ghost" onClick={onClose}>{t("Close")}</Button>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
          <Button variant={confirmPublic ? "danger" : "primary"} type="submit" form="publish-form" loading={busy} disabled={!account || !title.trim() || titleTooLong || scheduleBad}
            icon={scheduleDate ? <CalendarClock className="size-4" /> : confirmPublic ? <Globe className="size-4" /> : <Upload className="size-4" />}>
            {scheduleDate ? t("Schedule") : confirmPublic ? t("Yes, publish publicly") : t("Upload")}
          </Button>
        </>
      )}
    >
      {isLoading ? (
        <div className="space-y-4" aria-hidden><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-10" /><Skeleton className="h-28" /></div>
      ) : noChannel ? (
        <div className="space-y-4">
          {!integ?.youtube_ready ? (
            <Notice tone="warn" icon={<Plug className="mt-0.5 size-4 shrink-0 text-warn" />}>
              {t("YouTube isn't set up on this server yet. An admin needs to add a Google OAuth client (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET) and then connect a channel.")}
            </Notice>
          ) : (
            <Notice tone="info" icon={<Plug className="mt-0.5 size-4 shrink-0 text-info" />}>
              {t("No YouTube channel is connected yet. A producer or admin can connect one in Settings → Integrations.")}
            </Notice>
          )}
          <Link to="/settings#integrations" onClick={onClose}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-raised px-3.5 text-sm font-medium transition-colors hover:bg-hover">
            <Plug className="size-4" />{t("Open Settings → Integrations")}
          </Link>
        </div>
      ) : x && (
        <form id="publish-form" onSubmit={go} className="space-y-5">
          {/* what is being published */}
          <div className="cx-block flex items-center gap-3 p-3">
            <span className="cx-monitor grid h-14 w-10 shrink-0 place-items-center">
              {x.thumb_url ? <img src={x.thumb_url} alt="" className="size-full object-contain" /> : <MonitorPlay className="size-4 text-dim" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{t("Final")} · {t(LANG_NAMES[x.language] ?? x.language)}</p>
              <p className="mono mt-0.5 truncate text-2xs text-dim">{t(settings?.catalog.export_presets[x.preset]?.label ?? x.preset)} · {secs(x.duration_s)} · #{x.id}</p>
            </div>
            {channel && (
              <div className="flex shrink-0 items-center gap-2 text-xs text-mute">
                <Avatar name={channel.account_name || channel.account_id || "YT"} size={28} />
                <span className="hidden max-w-36 truncate font-medium text-ink sm:inline">{channel.account_name || channel.account_id}</span>
              </div>
            )}
          </div>
          {!copy && (
            <p className="-mt-2 flex items-center gap-1.5 text-xs text-mute"><Sparkles className="size-3.5 text-ai" />{t("Tip: generate a marketing pack to prefill this form.")}</p>
          )}

          {prior && (
            <Notice tone="warn">
              {t("Already uploaded {when}.", { when: agoT(prior.at) })}{" "}
              {prior.url && <a href={prior.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline"><ExternalLink className="size-3.5" />{prior.url}</a>}
              {" "}{t("Uploading again creates a second video.")}
            </Notice>
          )}

          {accounts.length > 1 && (
            <Field label={t("Channel")}>
              <Select value={account ?? ""} onChange={(e) => setAccount(Number(e.target.value))}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_name || a.account_id}</option>)}
              </Select>
            </Field>
          )}

          <div className="space-y-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label htmlFor="pub-title" className="text-xs font-medium text-mute">{t("Title")}</label>
                <CharCount n={title.length} limit={100} soft={short ? 70 : undefined} />
              </div>
              <Input id="pub-title" value={title} onChange={(e) => setTitle(e.target.value)} required aria-invalid={titleTooLong || undefined}
                className={clsx(titleTooLong && "!border-bad/70")} />
              {(copy?.titles?.length ?? 0) > 1 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {copy!.titles.map((tt, i) => (
                    <button key={i} type="button" onClick={() => setTitle(tt)} title={tt}
                      className={clsx("max-w-[240px] truncate rounded-lg border px-2.5 py-1 text-2xs transition-colors max-sm:py-2",
                        tt === title ? "border-ai/45 bg-ai/12 text-ai" : "border-line text-mute hover:border-dim hover:text-ink")}>
                      {tt}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label htmlFor="pub-desc" className="text-xs font-medium text-mute">{t("Description")}</label>
                <CharCount n={description.length} limit={4900} />
              </div>
              <Textarea id="pub-desc" className="min-h-[120px]" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4900} />
              <p className="mt-1.5 text-xs text-dim">{t("An AI-generated-content note is added automatically if it's missing.")}</p>
            </div>
            <Field label={t("Tags")} hint={<span className={tagList.length > 30 ? "text-bad" : undefined}>{t("Comma separated · {n} of 30", { n: tagList.length })}</span>}>
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t("story, kannada, shorts")} />
            </Field>
          </div>

          {/* visibility + schedule */}
          <div>
            <p className="eyebrow mb-2">{t("Visibility")}</p>
            <div role="radiogroup" aria-label={t("Visibility")} className={clsx("grid grid-cols-3 gap-2 transition-opacity", scheduleDate && "pointer-events-none opacity-50")}>
              {privacyOptions.map((o) => {
                const sel = (scheduleDate ? "private" : privacy) === o.value;
                return (
                  <button key={o.value} type="button" role="radio" aria-checked={sel} onClick={() => { setPrivacy(o.value); setConfirmPublic(false); }}
                    className={clsx("relative flex min-h-12 flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-[border-color,background-color] duration-150",
                      sel ? "border-accent/60 bg-accent/[0.07]" : "border-line hover:border-dim/50 hover:bg-hover/40")}>
                    <span className={clsx("flex items-center gap-1.5 pr-5 text-sm font-medium", sel && "text-accent-ink")}>{o.icon}{o.label}</span>
                    <span className="text-2xs leading-tight text-mute">{o.hint}</span>
                    {sel && <Check className="absolute right-2 top-2 size-3.5 text-accent-ink" strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
            <AnimatePresence initial={false}>
              {goesPublic && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                  <Alert tone={confirmPublic ? "bad" : "warn"} icon={<ShieldAlert className="size-4" />} className="mt-2.5"
                    title={confirmPublic ? t("Publish this video publicly on YouTube? Anyone will be able to find and watch it.") : undefined}>
                    {confirmPublic ? t("Press the red button again to publish.") : t("Public videos can be found and watched by anyone. You'll be asked to confirm.")}
                  </Alert>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <Field label={t("Schedule (optional)")}
            hint={scheduleBad ? <span className="text-bad">{t("Pick a time at least 5 minutes from now.")}</span>
              : scheduleDate ? t("Uploads as Private now; YouTube makes it public on {when}.", { when: scheduleDate.toLocaleString() })
              : t("Leave empty to publish with the visibility above right away.")}>
            <div className="flex gap-2">
              <Input type="datetime-local" value={scheduleAt} onChange={(e) => { setScheduleAt(e.target.value); setConfirmPublic(false); }} className="flex-1" />
              {scheduleAt && <Button type="button" variant="ghost" onClick={() => setScheduleAt("")}>{t("Clear")}</Button>}
            </div>
          </Field>

          {thumb && (
            <div className="cx-block flex items-center gap-3 p-3" data-tone="ai">
              <img src={thumb.url} alt="" className="h-16 w-auto rounded-md ring-1 ring-inset ring-line" />
              <div className="min-w-0 flex-1 space-y-1">
                <Toggle checked={useThumb} onChange={setUseThumb} label={<span className="flex items-center gap-1.5 text-sm font-medium"><ImageIcon className="size-4 text-mute" />{t("Upload the picked thumbnail")}</span>} />
                <p className="text-xs leading-snug text-mute">{t("Custom thumbnails need a verified YouTube channel. If YouTube refuses it, the video still uploads.")}</p>
              </div>
              <a href={thumb.url} download className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-line px-2.5 text-xs font-medium transition-colors hover:bg-hover max-sm:h-10">
                <Download className="size-3.5" />{t("Download")}
              </a>
            </div>
          )}
          <p className="flex items-start gap-2 text-xs leading-relaxed text-dim">
            <Badge tone="ai">{t("AI")}</Badge>
            <span>{t("The video is labelled as altered or synthetic content on YouTube.")}{short ? ` ${t("#Shorts is added for vertical renders.")}` : ""}</span>
          </p>
        </form>
      )}
    </Modal>
  );
}
