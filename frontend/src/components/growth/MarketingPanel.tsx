import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, Download, Hash, ImageIcon, Lightbulb, Loader2, Megaphone, MessageSquareText, RefreshCw, Sparkles, Type, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { LANG_NAMES, LANG_SHORT } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useMarketing, useSettings } from "../../lib/queries";
import type { Episode, MarketingPack, Project, SubmitResult } from "../../lib/types";
import { useGenerate } from "../Generate";
import { Badge, Button, Empty, Segmented, Skeleton, Tabs } from "../ui";
import {
  agoT, CardHeader, CharCount, Chip, CopyButton, CostConfirm, copyText, estimateImages, listItem, platformLabel, useActiveJobs,
} from "./common";

type Copy = NonNullable<MarketingPack["copies"]>[number];

/** Path of the thumbnail the team picked (kept in the episode's settings). */
export function chosenThumbnail(ep: Episode | undefined, pack: MarketingPack | undefined) {
  const path = (ep?.settings ?? {}).marketing_thumbnail as string | undefined;
  const files = pack?.thumbnail_files ?? [];
  return files.find((f) => f.path === path) ?? null;
}

/** Best copy for a platform family + language (used to prefill publishing). */
export function bestCopy(pack: MarketingPack | undefined, language: string, platformHint = "youtube"): Copy | null {
  const copies = pack?.copies ?? [];
  return copies.find((c) => c.language === language && c.platform.includes(platformHint))
    ?? copies.find((c) => c.language === language) ?? null;
}

const DEFAULT_PLATFORMS = (aspect: string) => (aspect === "16:9" ? ["youtube"] : ["youtube_shorts", "instagram_reels"]);
const PLATFORM_CHOICES = ["youtube", "youtube_shorts", "instagram_reels", "facebook_reels", "whatsapp"];

/** Platform limits we know for sure: YouTube titles 100 / descriptions 5000, Instagram captions 2200 / 30 hashtags. */
function limitsFor(platform: string) {
  const insta = platform.startsWith("instagram");
  return { title: 100, titleSoft: /short|reel|status|tiktok/.test(platform) ? 70 : undefined, desc: insta ? 2200 : 5000, tags: insta ? 30 : undefined };
}

function GenerateDialog({ open, onClose, project, eid }: { open: boolean; onClose: () => void; project: Project; eid: number }) {
  const t = useT();
  const { submit } = useGenerate();
  const { data: settings } = useSettings();
  const [platforms, setPlatforms] = useState<string[]>(() => DEFAULT_PLATFORMS(project.aspect));
  const [langs, setLangs] = useState<string[]>(() => project.languages);
  useEffect(() => {
    if (open) {
      setPlatforms(DEFAULT_PLATFORMS(project.aspect));
      setLangs(project.languages);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const thumbs = estimateImages(settings, 3);

  return (
    <CostConfirm
      open={open}
      onClose={onClose}
      title={t("Marketing pack")}
      amount={thumbs}
      disabled={!platforms.length || !langs.length}
      lines={[
        { label: t("Copy for {p} platform(s) × {l} language(s)", { p: platforms.length, l: langs.length }), usd: 0 },
        { label: t("3 thumbnail images"), usd: thumbs },
      ]}
      note={t("Writing the copy also uses a small amount of AI text, recorded in the ledger.")}
      onConfirm={() => submit(() => api.post<SubmitResult>(`/api/episodes/${eid}/marketing`, { platforms, languages: langs }), t("Marketing pack"))}
    >
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-xs font-medium text-mute">{t("Platforms")}</p>
          <div className="flex flex-wrap gap-1.5">
            {PLATFORM_CHOICES.map((p) => (
              <Chip key={p} active={platforms.includes(p)} onClick={() => setPlatforms(toggle(platforms, p))}
                icon={platforms.includes(p) ? <Check className="size-3" strokeWidth={3} /> : undefined}>{t(platformLabel(p))}</Chip>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-mute">{t("Languages")}</p>
          <div className="flex flex-wrap gap-1.5">
            {project.languages.map((l) => (
              <Chip key={l} active={langs.includes(l)} onClick={() => setLangs(toggle(langs, l))}
                icon={langs.includes(l) ? <Check className="size-3" strokeWidth={3} /> : undefined}>{t(LANG_NAMES[l] ?? l)}</Chip>
            ))}
          </div>
        </div>
      </div>
    </CostConfirm>
  );
}

/** A labelled block of copy with its own copy button(s). */
function Block({ icon, label, right, children }: { icon?: React.ReactNode; label: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-mute">{icon}{label}</p>
        <div className="ml-auto flex items-center gap-1.5">{right}</div>
      </div>
      {children}
    </div>
  );
}

function CopyView({ c }: { c: Copy }) {
  const t = useT();
  const lim = limitsFor(c.platform);
  const tags = c.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`));
  const everything = [c.titles[0] ?? "", "", c.description, "", tags.join(" ")].join("\n").trim();
  return (
    <motion.div {...listItem} className="space-y-5">
      <Block icon={<Type className="size-3.5" />} label={t("Title options")} right={<CopyButton text={everything} what={t("Title, description and hashtags")} label={t("Copy all")} />}>
        <ol className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {c.titles.map((title, i) => (
            <li key={i} className="group flex items-center gap-3 px-3.5 py-2.5 text-sm transition-colors hover:bg-hover/40">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-raised text-2xs font-semibold text-mute">{i + 1}</span>
              <span className="min-w-0 flex-1 leading-snug">{title}</span>
              <CharCount n={title.length} limit={lim.title} soft={lim.titleSoft} className="max-sm:hidden" />
              <span className="font-mono text-2xs tabular-nums text-dim sm:hidden">{title.length}</span>
              <CopyButton size="icon" text={title} what={t("Title")} />
            </li>
          ))}
        </ol>
      </Block>

      <Block label={t("Description")} right={<><CharCount n={c.description.length} limit={lim.desc} /><CopyButton size="icon" text={c.description} what={t("Description")} /></>}>
        <p className="max-h-48 overflow-y-auto whitespace-pre-line rounded-xl border border-line bg-raised/40 px-3.5 py-3 text-sm leading-relaxed">
          {c.description || <span className="text-dim">—</span>}
        </p>
      </Block>

      <Block icon={<Hash className="size-3.5" />} label={t("Hashtags")}
        right={<>
          {lim.tags ? <span className={clsx("font-mono text-2xs tabular-nums", tags.length > lim.tags ? "text-red-300" : "text-dim")}>{tags.length}/{lim.tags}</span>
            : <span className="font-mono text-2xs tabular-nums text-dim">{tags.length}</span>}
          {!!tags.length && <CopyButton size="icon" text={tags.join(" ")} what={t("Hashtags")} />}
        </>}>
        <div className="flex flex-wrap gap-1.5">
          {tags.length ? tags.map((h) => <HashChip key={h} tag={h} />) : <span className="text-sm text-dim">—</span>}
        </div>
      </Block>

      {c.pinned_comment && (
        <Block icon={<MessageSquareText className="size-3.5" />} label={t("Pinned comment")} right={<CopyButton size="icon" text={c.pinned_comment} what={t("Pinned comment")} />}>
          <p className="rounded-xl border border-line bg-raised/40 px-3.5 py-3 text-sm leading-relaxed">{c.pinned_comment}</p>
        </Block>
      )}
    </motion.div>
  );
}

/** A hashtag chip that copies itself when clicked. */
function HashChip({ tag }: { tag: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button type="button" title={t("Copy")} onClick={async () => { if (await copyText(tag, t("Hashtag"))) { setDone(true); setTimeout(() => setDone(false), 1200); } }}
      className={clsx("inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium leading-none transition-colors active:scale-95 max-sm:h-9",
        done ? "border-ok/40 bg-ok/12 text-green-300" : "border-info/30 bg-info/10 text-sky-300 hover:bg-info/20")}>
      {done && <Check className="size-3" strokeWidth={3} />}{tag}
    </button>
  );
}

export default function MarketingPanel({ project, episode, canEdit }: { project: Project; episode: Episode; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const eid = episode.id;
  const { data: pack, isLoading } = useMarketing(eid);
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<string | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["marketing", eid] });
  const running = useActiveJobs((j) => j.type === "marketing" && j.episode_id === eid, project.id, refresh);
  // The live feed refreshes the episode when the pack changes — follow it.
  const stamp = `${episode.marketing?.at ?? ""}|${episode.marketing?.thumbnail_files?.length ?? 0}`;
  const firstStamp = useRef(stamp);
  useEffect(() => {
    if (stamp !== firstStamp.current) qc.invalidateQueries({ queryKey: ["marketing", eid] });
  }, [stamp, eid, qc]);

  const copies = pack?.copies ?? [];
  const platforms = useMemo(() => [...new Set(copies.map((c) => c.platform))], [copies]);
  const curPlatform = platform && platforms.includes(platform) ? platform : platforms[0];
  const langsFor = copies.filter((c) => c.platform === curPlatform).map((c) => c.language);
  const curLang = language && langsFor.includes(language) ? language : langsFor.includes(project.primary_language) ? project.primary_language : langsFor[0];
  const current = copies.find((c) => c.platform === curPlatform && c.language === curLang);
  const files = pack?.thumbnail_files ?? [];
  const ideas = pack?.thumbnails ?? [];
  const chosen = chosenThumbnail(episode, pack);
  const tips = pack?.posting_tips ?? [];
  const has = copies.length > 0 || files.length > 0 || ideas.length > 0;
  const waiting = running.some((j) => j.status === "awaiting_approval" || j.status === "proposed");
  const vertical = project.aspect !== "16:9";

  const pick = async (path: string) => {
    setPicking(path);
    try {
      const next = chosen?.path === path ? null : path;
      await api.patch(`/api/episodes/${eid}`, { settings: { marketing_thumbnail: next } });
      await qc.invalidateQueries({ queryKey: ["episode", eid] });
      toast.success(next ? t("Thumbnail picked") : t("Thumbnail choice cleared"));
    } catch {
      /* toasted by api */
    } finally {
      setPicking(null);
    }
  };

  return (
    <section className="@container rounded-xl border border-line bg-panel p-4 sm:p-5">
      <CardHeader
        icon={<Megaphone className="size-4" />}
        title={t("Marketing pack")}
        sub={pack?.at ? t("Titles, descriptions, hashtags and thumbnails · made {when}", { when: agoT(pack.at) })
          : t("Titles, descriptions, hashtags and thumbnails for each platform and language.")}
        actions={<>
          {running.length > 0 && (
            <Badge tone={waiting ? "warn" : "accent"}>
              {waiting ? t("Waiting for approval") : <><Loader2 className="size-3 animate-spin" />{t("Generating…")}</>}
            </Badge>
          )}
          {canEdit && (
            <Button size="sm" className="max-sm:h-10" variant={has ? "outline" : "primary"} disabled={running.length > 0}
              icon={has ? <RefreshCw className="size-3.5" /> : <Sparkles className="size-3.5" />} onClick={() => setOpen(true)}>
              {has ? t("Regenerate") : t("Generate pack")}
            </Button>
          )}
        </>}
      />

      {isLoading ? (
        <div className="grid gap-6 @3xl:grid-cols-[minmax(0,1fr)_320px]" aria-hidden>
          <div className="space-y-4"><Skeleton className="h-9 w-2/3" /><Skeleton className="h-32 rounded-xl" /><Skeleton className="h-24 rounded-xl" /></div>
          <div className="space-y-3"><Skeleton className="h-4 w-32" /><div className="grid grid-cols-3 gap-2"><Skeleton className="aspect-[9/16] rounded-lg" /><Skeleton className="aspect-[9/16] rounded-lg" /><Skeleton className="aspect-[9/16] rounded-lg" /></div></div>
        </div>
      ) : !has ? (
        <Empty icon={<Megaphone className="size-7" />} title={t("No marketing pack yet")}
          sub={t("Generate platform-ready titles, descriptions, hashtags and three thumbnail options from this episode's hook and script.")}
          action={canEdit ? <Button variant="primary" icon={<Sparkles className="size-4" />} disabled={running.length > 0} onClick={() => setOpen(true)}>{t("Generate pack")}</Button> : undefined} />
      ) : (
        <div className="@container">
          <div className="grid gap-x-8 gap-y-6 @3xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0">
              {copies.length ? (
                <>
                  <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <Tabs className="min-w-0 flex-1" value={curPlatform ?? ""} onChange={setPlatform}
                      tabs={platforms.map((p) => ({ value: p, label: t(platformLabel(p)) }))} />
                    {langsFor.length > 1 && (
                      <Segmented value={curLang ?? ""} onChange={setLanguage} aria-label={t("Language")}
                        options={langsFor.map((l) => ({ value: l, label: LANG_SHORT[l] ?? l, title: t(LANG_NAMES[l] ?? l) }))} />
                    )}
                  </div>
                  <AnimatePresence mode="wait" initial={false}>
                    {current && <CopyView key={`${current.platform}-${current.language}`} c={current} />}
                  </AnimatePresence>
                </>
              ) : <p className="text-sm text-mute">{t("No copy in this pack.")}</p>}
            </div>

            <aside className="space-y-6">
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-mute"><ImageIcon className="size-3.5" />{t("Thumbnail options")}</p>
                  {chosen && canEdit && (
                    <button type="button" onClick={() => pick(chosen.path)} disabled={!!picking}
                      className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium text-mute transition-colors hover:bg-hover hover:text-ink"><X className="size-3" />{t("Clear")}</button>
                  )}
                </div>
                {files.length ? (
                  <div role="group" aria-label={t("Thumbnail options")}
                    className={clsx("grid gap-2.5", vertical ? "grid-cols-[repeat(auto-fill,minmax(96px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(150px,1fr))]")}>
                    {files.map((f) => {
                      const sel = chosen?.path === f.path;
                      return (
                        <motion.div key={f.path} layout whileHover={{ y: -2 }} transition={{ duration: 0.15 }}
                          className={clsx("group relative overflow-hidden rounded-xl border bg-bg transition-[border-color,box-shadow]", sel ? "border-accent shadow-glow" : "border-line hover:border-dim/60")}>
                          <button type="button" aria-pressed={sel} disabled={!canEdit || !!picking} onClick={() => pick(f.path)} title={f.concept}
                            className={clsx("relative block w-full", vertical ? "aspect-[9/16]" : "aspect-video", canEdit ? "cursor-pointer" : "cursor-default")}>
                            <img src={f.url} alt={f.overlay_text} className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" loading="lazy" />
                            <AnimatePresence>
                              {sel && (
                                <motion.span key="tick" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={{ type: "spring", stiffness: 500, damping: 28 }}
                                  className="absolute left-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-accent text-black shadow"><Check className="size-3.5" strokeWidth={3} /></motion.span>
                              )}
                            </AnimatePresence>
                            {picking === f.path && <span className="absolute inset-0 grid place-items-center bg-bg/60"><Loader2 className="size-4 animate-spin" /></span>}
                          </button>
                          <a href={f.url} download title={t("Download")} aria-label={t("Download")} onClick={(e) => e.stopPropagation()}
                            className="absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-md bg-black/60 max-sm:size-9 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/80 focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-100">
                            <Download className="size-3.5" />
                          </a>
                          <p className={clsx("truncate px-2 py-1.5 text-2xs", sel ? "font-semibold text-accent-ink" : "text-mute")} title={f.concept}>{sel ? t("Picked") : f.overlay_text}</p>
                        </motion.div>
                      );
                    })}
                  </div>
                ) : ideas.length ? (
                  <ul className="space-y-2">
                    {ideas.map((th, i) => (
                      <li key={i} className="rounded-xl border border-line px-3.5 py-2.5 text-sm">
                        <p className="font-medium">{th.overlay_text}</p>
                        <p className="mt-0.5 text-xs text-mute">{th.concept}</p>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-dim">{t("No thumbnails yet.")}</p>}
                {files.length > 0 && (
                  <p className="mt-2 text-xs leading-relaxed text-mute">
                    {canEdit ? t("Click one to pick it for publishing. It's uploaded with the video (custom thumbnails need a verified YouTube channel).")
                      : t("The picked thumbnail is uploaded with the video (custom thumbnails need a verified YouTube channel).")}
                  </p>
                )}
              </div>

              {tips.length > 0 && (
                <div className="rounded-xl border border-line bg-raised/40 p-3.5">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-mute"><Lightbulb className="size-3.5 text-accent-ink" />{t("Posting tips")}</p>
                  <ul className="space-y-1.5 text-sm text-mute">
                    {tips.map((tip, i) => <li key={i} className="flex gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-accent" /><span className="leading-snug">{tip}</span></li>)}
                  </ul>
                </div>
              )}
            </aside>
          </div>
        </div>
      )}
      {canEdit && <GenerateDialog open={open} onClose={() => setOpen(false)} project={project} eid={eid} />}
    </section>
  );
}
