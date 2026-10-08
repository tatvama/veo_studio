import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  AudioLines, Boxes, Captions, Coins, Fingerprint, Languages, Lock, MessagesSquare, PenLine, Plug, RotateCcw, Save, ScanFace, Settings2,
  SlidersHorizontal, Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Notice } from "../../components/growth/common";
import { CAPTION_STYLES } from "../../components/growth/RenderOptions";
import YouTubeIntegration from "../../components/growth/YouTubeIntegration";
import { AnimatedNumber, Button, Input, Page, PageHeader, Progress, Segmented, Select, Skeleton, Textarea } from "../../components/ui";
import { api } from "../../lib/api";
import { LANG_NAMES, QUALITY_INFO, usd } from "../../lib/format";
import { UI_LANGUAGES, useT } from "../../lib/i18n";
import { useAuthStatus, useSettings } from "../../lib/queries";
import type { Role, SettingsPayload } from "../../lib/types";
import { UnsavedBar } from "./shared/UnsavedBar";
import { useFlash } from "./shared/useFlash";
import { useUnsavedGuard } from "./shared/useUnsavedGuard";
import { Choice, Dollar, NumberInput, Row, Rows, SettingsCard, SliderRow, SwitchRow } from "./settings/controls";
import { SECTION_IDS, SETTING_SECTION, SettingsChips, SettingsNav, useScrollSpy } from "./settings/Nav";
import { ProvidersCard } from "./settings/ProvidersCard";

import { Pill } from "./shared/Pill";
// Keys the backend accepts in PATCH /api/settings (settings_store.DEFAULTS). `engine_policy` is managed in the Model Hub.
const EDITABLE = [
  "team_monthly_cap_usd", "alert_thresholds", "creator_default_monthly_limit_usd", "default_quality_mode", "auto_retake",
  "max_auto_retakes", "qc_threshold", "lipsync_model", "tts_provider_by_language", "make_webhook_url", "models", "prices",
  "dialogue_method", "dub_method", "hub_auto_sync", "hub_sync_hours", "hub_auto_enable", "identity_trainer", "face_match_threshold",
  "lipsync_qc", "lipsync_qc_threshold", "critic_rounds", "critic_min_score", "caption_style", "auto_reframe", "sfx_auto",
  "ui_default_language", "google_first",
] as const;

type Draft = Record<string, any>;

/** Plain-number settings: validated and converted before saving. */
const NUMERIC: Record<string, { label: string; min: number; max: number; int?: boolean; blankNull?: boolean }> = {
  team_monthly_cap_usd: { label: "Team monthly cap", min: 0, max: 1_000_000 },
  creator_default_monthly_limit_usd: { label: "Default creator limit", min: 0, max: 1_000_000, blankNull: true },
  max_auto_retakes: { label: "Max retakes per shot", min: 0, max: 5, int: true },
  hub_sync_hours: { label: "Check for new models every", min: 1, max: 720 },
  critic_rounds: { label: "Critic rounds", min: 0, max: 5, int: true },
  critic_min_score: { label: "Critic pass score", min: 0, max: 10 },
};

const LIPSYNC_MODELS = [
  { value: "lipsync-2", label: "lipsync-2 — standard" },
  { value: "lipsync-2-pro", label: "lipsync-2-pro — sharper mouth detail" },
  { value: "sync-3", label: "sync-3 — handles head turns and angles" },
];

const TTS_PROVIDERS = [
  { value: "gemini", label: "Gemini" },
  { value: "elevenlabs", label: "ElevenLabs" },
  { value: "sarvam", label: "Sarvam" },
];

const DIALOGUE_METHODS = [
  { value: "audio_first", label: "Audio first + lip-sync", desc: "Record each line in the character's voice, make the video, then match the lips. Most reliable for Indian languages." },
  { value: "audio_driven", label: "Audio-driven video", desc: "Talking-head engines animate the face straight from the recorded line. Best mouth shapes; fewer engines and camera moves." },
  { value: "voice_lock", label: "Native voice + voice lock", desc: "Veo speaks the line, then ElevenLabs swaps in the character's own voice. Natural acting, needs ElevenLabs." },
  { value: "native_when_possible", label: "Native when possible", desc: "Let Veo speak English lines directly (cheapest, fastest); other languages use audio first." },
];

const DUB_METHODS = [
  { value: "redub", label: "Re-dub", desc: "Keep the original video and lip-sync it to the new language. Cheapest." },
  { value: "regenerate", label: "Regenerate", desc: "For audio-driven shots, make a fresh video from each language's audio. Best lips, costs more." },
];

const MODEL_LABELS: Record<string, string> = {
  text: "Writing (fast)", text_pro: "Writing (best quality)", image: "Images", image_hero: "Images (hero)",
  video_saver: "Video — Saver", video_balanced: "Video — Balanced", video_hero: "Video — Hero", omni: "Omni video",
  tts_gemini: "Voice — Gemini", music: "Music (full track)", music_clip: "Music (short clip)", embedding: "Search embeddings",
  tts_elevenlabs: "Voice — ElevenLabs", sts_elevenlabs: "Voice changer — ElevenLabs", ttv_elevenlabs: "Voice design — ElevenLabs",
  tts_sarvam: "Voice — Sarvam", lipsync: "Lip-sync", lipsync_pro: "Lip-sync (pro)", lipsync_angles: "Lip-sync (angles)",
};

/** True when a plain-number setting holds something the server would reject (shown as a red field). */
function numBad(k: string, v: unknown): boolean {
  const spec = NUMERIC[k];
  if (!spec) return false;
  const raw = v === null || v === undefined ? "" : String(v).trim();
  if (raw === "") return !spec.blankNull;
  const n = Number(raw);
  return !Number.isFinite(n) || n < spec.min || n > spec.max || (!!spec.int && !Number.isInteger(n));
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const pretty = (v: unknown) => JSON.stringify(v && typeof v === "object" ? v : {}, null, 2);

function parseThresholds(text: string): number[] | null {
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n <= 0 || n > 200)) return null;
  return [...new Set(nums)].sort((a, b) => a - b);
}

function parseJsonObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "must be a JSON object { … }" };
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "not valid JSON" };
  }
}

function SettingsSkeleton() {
  return (
    <Page width="default">
      <div className="mb-6 flex items-center gap-3"><Skeleton className="size-10 rounded-xl" /><div className="space-y-2"><Skeleton className="h-6 w-40" /><Skeleton className="h-3.5 w-72" /></div></div>
      <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
        <div className="hidden space-y-2 lg:block">{Array.from({ length: 9 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
        <div className="space-y-5">
          {[220, 260, 340].map((h, i) => <Skeleton key={i} className="w-full rounded-xl" style={{ height: h }} />)}
        </div>
      </div>
    </Page>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data: auth } = useAuthStatus();
  const role: Role = auth?.user?.role ?? "viewer";
  const isAdmin = role === "admin";
  const { data, isLoading } = useSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [active, select] = useScrollSpy(SECTION_IDS, !!data && !!draft);
  const [thresholdsText, setThresholdsText] = useState("");
  const [pricesText, setPricesText] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, flashSaved] = useFlash(2600);
  const [savedCount, setSavedCount] = useState(0);
  const [params, setParams] = useSearchParams();
  const loc = useLocation();
  const scrolled = useRef(false);

  // Back from Google's consent screen: /settings?connected=youtube
  useEffect(() => {
    if (params.get("connected") === "youtube") {
      toast.success(t("YouTube channel connected"));
      qc.invalidateQueries({ queryKey: ["integrations"] });
      const next = new URLSearchParams(params);
      next.delete("connected");
      setParams(next, { replace: true });
    }
  }, [params, setParams, qc, t]);

  const load = useCallback((s: SettingsPayload) => {
    const d: Draft = {};
    for (const k of EDITABLE) d[k] = clone(s.settings[k]);
    d.models = d.models && typeof d.models === "object" ? d.models : {};
    d.tts_provider_by_language = d.tts_provider_by_language && typeof d.tts_provider_by_language === "object" ? d.tts_provider_by_language : {};
    d.identity_trainer = d.identity_trainer && typeof d.identity_trainer === "object" ? d.identity_trainer : {};
    setDraft(d);
    setThresholdsText(Array.isArray(s.settings.alert_thresholds) ? s.settings.alert_thresholds.join(", ") : "");
    const p = s.settings.prices;
    setPricesText(p && typeof p === "object" && Object.keys(p).length ? pretty(p) : "");
  }, []);

  // Load once; later refetches must not wipe unsaved edits.
  useEffect(() => {
    if (data && !draft) load(data);
  }, [data, draft, load]);

  // Deep links like /settings#integrations (from the Export page).
  useEffect(() => {
    if (!draft || scrolled.current || !loc.hash) return;
    scrolled.current = true;
    const id = loc.hash.slice(1);
    setTimeout(() => { if (document.getElementById(id)) select(id); }, 80);
  }, [draft, loc.hash, select]);

  const set = (k: string, v: unknown) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  const base = data?.settings ?? {};
  const { changes, errors } = useMemo(() => {
    const changes: Record<string, unknown> = {};
    const errors: string[] = [];
    if (!draft) return { changes, errors };
    for (const k of EDITABLE) {
      let v: unknown = draft[k];
      if (k === "alert_thresholds") {
        const th = parseThresholds(thresholdsText);
        if (!th) { errors.push(t("Alert levels must be numbers separated by commas, for example 50, 80, 100")); continue; }
        v = th;
      } else if (k === "prices") {
        const p = parseJsonObject(pricesText);
        if (!p.ok) { errors.push(t("Price overrides: {e}", { e: p.error })); continue; }
        v = p.value;
      } else if (k === "models") {
        v = Object.fromEntries(Object.entries((draft.models ?? {}) as Record<string, string>)
          .map(([mk, mv]) => [mk, String(mv).trim()]).filter(([, mv]) => mv));
      } else if (k in NUMERIC) {
        const spec = NUMERIC[k];
        const raw = v === null || v === undefined ? "" : String(v).trim();
        if (raw === "" && spec.blankNull) v = null;
        else {
          const n = Number(raw === "" ? NaN : raw);
          if (!Number.isFinite(n) || n < spec.min || n > spec.max || (spec.int && !Number.isInteger(n))) {
            errors.push(spec.int
              ? t("{label} must be a whole number from {min} to {max}", { label: t(spec.label), min: spec.min, max: spec.max })
              : t("{label} must be a number from {min} to {max}", { label: t(spec.label), min: spec.min, max: spec.max.toLocaleString() }));
            continue;
          }
          v = n;
        }
      } else if (k === "identity_trainer") {
        const it = (draft.identity_trainer ?? {}) as Record<string, unknown>;
        const steps = Number(it.steps), scale = Number(it.scale), minImages = Number(it.min_images);
        const trainer = String(it.trainer ?? "").trim(), inference = String(it.inference ?? "").trim();
        if (!trainer || !inference) { errors.push(t("Identity training needs both a trainer and an inference model")); continue; }
        if (!Number.isInteger(steps) || steps < 100 || steps > 10000) { errors.push(t("Training steps must be a whole number from 100 to 10000")); continue; }
        if (!Number.isFinite(scale) || scale <= 0 || scale > 2) { errors.push(t("Identity strength must be between 0.1 and 2")); continue; }
        if (!Number.isInteger(minImages) || minImages < 4 || minImages > 100) { errors.push(t("Minimum photos must be a whole number from 4 to 100")); continue; }
        v = { ...it, trainer, inference, steps, scale, min_images: minImages };
      } else if (k === "make_webhook_url") {
        v = String(v ?? "").trim();
        if (v && !/^https?:\/\//i.test(v as string)) { errors.push(t("Webhook address must start with https://")); continue; }
      }
      if (!same(v, base[k])) changes[k] = v;
    }
    return { changes, errors };
  }, [draft, thresholdsText, pricesText, base, t]);

  const changeCount = Object.keys(changes).length;
  const dirty = changeCount > 0 || errors.length > 0;
  const dirtySections = useMemo(() => new Set(Object.keys(changes).map((k) => SETTING_SECTION[k]).filter(Boolean)), [changes]);

  const save = async () => {
    if (errors.length) return void toast.error(errors[0]);
    if (!changeCount) return;
    setSaving(true);
    try {
      const res = await api.patch<SettingsPayload>("/api/settings", changes);
      qc.setQueryData(["settings"], res);
      load(res);
      await Promise.all([qc.invalidateQueries({ queryKey: ["settings"] }), qc.invalidateQueries({ queryKey: ["costs"] })]);
      setSavedCount(changeCount);
      flashSaved();
    } catch {
      /* already toasted */
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (data) load(data);
  };
  useUnsavedGuard(isAdmin && dirty, () => { if (!saving) void save(); });

  if (isLoading || !data || !draft) return <SettingsSkeleton />;

  const ro = !isAdmin;
  const team = data.team;
  const quality = String(draft.default_quality_mode || "saver");
  const ttsPrices = (data.prices?.tts_per_1k_chars ?? {}) as Record<string, number>;
  const lipsyncPrices = (data.prices?.lipsync_per_second ?? {}) as Record<string, number>;
  const providerMode = Object.fromEntries(data.providers.map((p) => [p.provider, p.mode]));
  const baseModelOverrides = (base.models ?? {}) as Record<string, string>;
  const modelOverrides = (draft.models ?? {}) as Record<string, string>;
  const langs = Object.keys(LANG_NAMES);
  const it = (draft.identity_trainer ?? {}) as Record<string, any>;
  const setIt = (k: string, v: unknown) => set("identity_trainer", { ...it, [k]: v });
  const num = (k: string, fallback: number) => {
    const n = Number(draft[k]);
    return Number.isFinite(n) ? n : fallback;
  };
  const capPct = team.cap_usd ? (team.spent_usd / team.cap_usd) * 100 : 0;
  const bad = (k: string) => numBad(k, draft[k]);
  const itSteps = Number(it.steps), itScale = Number(it.scale), itMin = Number(it.min_images);

  const setModel = (key: string, val: string) => {
    const next = { ...modelOverrides };
    if (!(key in baseModelOverrides) && val === data.models[key]) delete next[key];
    else next[key] = val;
    set("models", next);
  };
  const resetModel = (key: string) => {
    const next = { ...modelOverrides };
    delete next[key];
    set("models", next);
  };
  const pricesParsed = parseJsonObject(pricesText);

  return (
    <Page width="default">
      <PageHeader
        icon={<Settings2 className="size-5" />}
        title={t("Settings")}
        subtitle={t("Team budget, generation defaults, quality checks, delivery, integrations and AI service keys.")}
        actions={isAdmin ? (
          <>
            {dirty && <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={discard}>{t("Discard")}</Button>}
            <Button variant="primary" icon={<Save className="size-4" />} loading={saving} disabled={!dirty || !!errors.length} onClick={save}>
              {changeCount ? t("Save changes ({n})", { n: changeCount }) : t("Save changes")}
            </Button>
          </>
        ) : undefined}
      />

      {ro && (
        <Notice tone="info" icon={<Lock className="mt-0.5 size-4 shrink-0 text-info" />} className="mb-5">
          {t("You're viewing settings read-only. Only admins can change them.")}
        </Notice>
      )}

      <SettingsChips active={active} onSelect={select} dirty={dirtySections} />

      <div className="lg:grid lg:grid-cols-[196px_minmax(0,1fr)] lg:gap-10">
        <SettingsNav active={active} onSelect={select} dirty={dirtySections} />

        <div className="min-w-0 space-y-5">
          {/* Budget */}
          <SettingsCard id="budget" index={0} icon={<Coins className="size-4" />} title={t("Budget")} sub={t("Monthly spending limits for the whole team.")}>
            <div className="mb-5 rounded-xl border border-line bg-raised/40 p-4">
              <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
                <div>
                  <p className="text-xs font-medium text-mute">{t("This month")}</p>
                  <p className="mt-1 text-2xl font-semibold leading-none tabular-nums tracking-tight">
                    <AnimatedNumber value={team.spent_usd} format={(n) => usd(n)} />
                    <span className="ml-2 text-sm font-normal text-mute">{team.cap_usd ? t("spent of {cap}", { cap: usd(team.cap_usd) }) : t("spent")}</span>
                  </p>
                </div>
                <Link to="/costs" className="-my-2 py-2 text-xs font-medium text-accent-ink hover:underline">{t("See all costs")} →</Link>
              </div>
              <Progress value={team.cap_usd ? team.spent_usd / team.cap_usd : 0} size="lg" tone={capPct >= 100 ? "bad" : capPct >= 80 ? "warn" : "accent"} className="mt-3.5" />
              <p className="mt-2 text-xs text-dim">{t("{usd} reserved for running jobs", { usd: usd(team.reserved_usd) })}</p>
            </div>
            <Rows>
              <Row label={t("Team monthly cap")} hint={t("Nobody can spend past this. 0 = no cap.")}>
                <Dollar label={t("Team monthly cap")} value={draft.team_monthly_cap_usd} disabled={ro} invalid={bad("team_monthly_cap_usd")} onChange={(v) => set("team_monthly_cap_usd", v)} />
              </Row>
              <Row label={t("Default creator limit (per month)")} hint={t("Used when a creator has no personal limit. Blank = no limit.")}>
                <Dollar label={t("Default creator limit (per month)")} value={draft.creator_default_monthly_limit_usd} disabled={ro} placeholder={t("No limit")} invalid={bad("creator_default_monthly_limit_usd")}
                  onChange={(v) => set("creator_default_monthly_limit_usd", v)} />
              </Row>
              <Row label={t("Alert me at (% of cap)")} hint={t("Comma list. Admins are alerted when spending crosses each level.")}>
                <div className="w-48"><Input value={thresholdsText} disabled={ro} placeholder="50, 80, 100" aria-label={t("Alert me at (% of cap)")} aria-invalid={!parseThresholds(thresholdsText) || undefined}
                  className={clsx(!parseThresholds(thresholdsText) && "border-bad/60 focus:border-bad")} onChange={(e) => setThresholdsText(e.target.value)} /></div>
              </Row>
            </Rows>
          </SettingsCard>

          {/* Generation defaults */}
          <SettingsCard id="generation" index={1} icon={<SlidersHorizontal className="size-4" />} title={t("Generation defaults")} sub={t("Used by new projects.")}>
            <Rows>
              <SwitchRow label={t("Google first (your Gemini key)")}
                hint={draft.google_first !== false
                  ? t("Keyframes, videos and edits use only Google. If Google's quota is reached, jobs wait for it instead of moving to fal. fal is used only for what Google can't do (e.g. lip-sync) or when you pick a fal engine for a shot.")
                  : t("Off: when a Google engine fails or is rate-limited, the job moves to the next engine in the chain (fal), which bills your fal balance.")}
                checked={draft.google_first !== false} disabled={ro} onChange={(v) => set("google_first", v)} />
              <Row stack label={t("Default video quality")} hint={t(QUALITY_INFO[quality]?.desc ?? "")}>
                <div className={clsx("overflow-x-auto", ro && "pointer-events-none opacity-60")}>
                  <Segmented
                    value={quality}
                    onChange={(v) => set("default_quality_mode", v)}
                    aria-label={t("Default video quality")}
                    options={Object.entries(QUALITY_INFO).map(([value, q]) => ({
                      value,
                      title: t(q.desc),
                      label: <span>{t(q.label)} <span className="text-xs font-normal text-dim">{q.price}</span></span>,
                    }))}
                  />
                </div>
              </Row>
              <Row label={t("Lip-sync model")} hint={t("Used when a voice is recorded first and the mouth is matched afterwards.")}>
                <div className="w-full sm:w-72">
                  <Select value={draft.lipsync_model ?? "lipsync-2"} disabled={ro} aria-label={t("Lip-sync model")} onChange={(e) => set("lipsync_model", e.target.value)}>
                    {LIPSYNC_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {t(m.label)}{lipsyncPrices[m.value] != null ? ` (~$${lipsyncPrices[m.value]}/s)` : ""}
                      </option>
                    ))}
                  </Select>
                </div>
              </Row>
            </Rows>
          </SettingsCard>

          {/* Quality control */}
          <SettingsCard id="quality" index={2} icon={<ScanFace className="size-4" />} title={t("Quality control")}
            sub={t("Every new take is checked for the right faces, extra people, garbled text and lip-sync. Failing takes can be retried automatically.")}>
            <Rows>
              <SwitchRow label={t("Automatic retakes")} hint={t("Re-shoot a take that fails the check, trying another engine.")}
                checked={!!draft.auto_retake} disabled={ro} onChange={(v) => set("auto_retake", v)} />
              <Row label={t("Max retakes per shot")} hint={t("0 to 5. Each retake costs money.")}>
                <NumberInput label={t("Max retakes per shot")} min={0} max={5} step={1} disabled={ro || !draft.auto_retake} invalid={bad("max_auto_retakes")} value={draft.max_auto_retakes}
                  onChange={(v) => set("max_auto_retakes", v)} />
              </Row>
              <SliderRow label={t("Visual check strictness")} hint={t("AI review score a take needs to pass")} value={num("qc_threshold", 0.7)} min={0} max={1} step={0.05}
                disabled={ro} onChange={(v) => set("qc_threshold", v)} left={t("Relaxed")} right={t("Strict")} />
              <SliderRow label={t("Face match threshold")} hint={t("Face similarity to the character photos · 0.36 ≈ same person")} value={num("face_match_threshold", 0.36)}
                min={0.2} max={0.6} step={0.01} disabled={ro} onChange={(v) => set("face_match_threshold", v)} left={t("Looser")} right={t("Stricter")} />
              <SwitchRow label={t("Lip-sync check")} hint={t("AI watches dubbed and lip-synced clips with sound and scores the mouth movement.")}
                checked={!!draft.lipsync_qc} disabled={ro} onChange={(v) => set("lipsync_qc", v)} />
              <SliderRow label={t("Lip-sync pass score")} value={num("lipsync_qc_threshold", 0.6)} min={0} max={1} step={0.05}
                disabled={ro || !draft.lipsync_qc} onChange={(v) => set("lipsync_qc_threshold", v)} left={t("Relaxed")} right={t("Strict")} />
            </Rows>
          </SettingsCard>

          {/* Dialogue & dubbing */}
          <SettingsCard id="dialogue" index={3} icon={<MessagesSquare className="size-4" />} title={t("Dialogue & dubbing")}
            sub={t("How speaking shots are made. Projects and individual shots can override this.")}>
            <Rows>
              <Row stack label={t("Dialogue method")}>
                <Choice ariaLabel={t("Dialogue method")} options={DIALOGUE_METHODS} value={String(draft.dialogue_method ?? "audio_first")} disabled={ro}
                  onChange={(v) => set("dialogue_method", v)} />
              </Row>
              <Row stack label={t("Dubbing into other languages")}>
                <Choice ariaLabel={t("Dubbing into other languages")} options={DUB_METHODS} value={String(draft.dub_method ?? "redub")} disabled={ro} onChange={(v) => set("dub_method", v)} />
              </Row>
            </Rows>
          </SettingsCard>

          {/* Captions & delivery */}
          <SettingsCard id="delivery" index={4} icon={<Captions className="size-4" />} title={t("Captions & delivery")} sub={t("Defaults for every render. Each episode can pick its own caption style on the Export page.")}>
            <Rows>
              <Row stack label={t("Default caption style")} hint={t(CAPTION_STYLES.find((c) => c.value === draft.caption_style)?.desc ?? "")}>
                <div className={clsx("overflow-x-auto", ro && "pointer-events-none opacity-60")}>
                  <Segmented value={String(draft.caption_style ?? "karaoke")} onChange={(v) => set("caption_style", v)} aria-label={t("Default caption style")}
                    options={CAPTION_STYLES.map((c) => ({ value: c.value, label: t(c.label), title: t(c.desc) }))} />
                </div>
              </Row>
              <SwitchRow label={t("Auto-reframe")} hint={t("When a clip's shape differs from the export (e.g. 16:9 → 9:16), crop around the main face instead of the centre.")}
                checked={draft.auto_reframe !== false} disabled={ro} onChange={(v) => set("auto_reframe", v)} />
              <SwitchRow label={t("Automatic sound effects")} hint={t("Autopilot designs ambience and spot effects for each episode (ElevenLabs; small cost).")}
                checked={!!draft.sfx_auto} disabled={ro} onChange={(v) => set("sfx_auto", v)} />
              <Row label={t("Default interface language")} hint={t("For people who haven't picked their own language yet.")}>
                <div className="w-full sm:w-56">
                  <Select value={draft.ui_default_language ?? "en"} disabled={ro} aria-label={t("Default interface language")} onChange={(e) => set("ui_default_language", e.target.value)}>
                    {Object.entries(UI_LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                </div>
              </Row>
            </Rows>
          </SettingsCard>

          {/* Writers' room */}
          <SettingsCard id="room" index={5} icon={<PenLine className="size-4" />} title={t("Writers' room")} sub={t("The AI critic reviews scripts and asks for rewrites until they score high enough.")}>
            <Rows>
              <Row label={t("Critic rounds")} hint={t("Rewrite rounds per run. 0 to 5.")}>
                <NumberInput label={t("Critic rounds")} min={0} max={5} step={1} disabled={ro} invalid={bad("critic_rounds")} value={draft.critic_rounds} onChange={(v) => set("critic_rounds", v)} />
              </Row>
              <Row label={t("Critic pass score")} hint={t("Out of 10. Stop rewriting once the script reaches this.")}>
                <NumberInput label={t("Critic pass score")} min={0} max={10} step={0.5} disabled={ro} invalid={bad("critic_min_score")} value={draft.critic_min_score} onChange={(v) => set("critic_min_score", v)} />
              </Row>
            </Rows>
          </SettingsCard>

          {/* Model Hub */}
          <SettingsCard id="hub" index={6} icon={<Boxes className="size-4" />} title={t("Model Hub")}
            sub={<>{t("Keep the list of video, voice and image models up to date.")} <Link to="/models" className="font-medium text-accent-ink hover:underline">{t("Open Model Hub")}</Link></>}>
            <Rows>
              <SwitchRow label={t("Check for new models automatically")} hint={t("Syncs the fal.ai catalogue and prices in the background.")}
                checked={draft.hub_auto_sync !== false} disabled={ro} onChange={(v) => set("hub_auto_sync", v)} />
              <Row label={t("Check every (hours)")} hint={t("1 to 720.")}>
                <NumberInput label={t("Check every (hours)")} min={1} max={720} step={1} disabled={ro || draft.hub_auto_sync === false} invalid={bad("hub_sync_hours")} value={draft.hub_sync_hours}
                  onChange={(v) => set("hub_sync_hours", v)} />
              </Row>
              <SwitchRow label={t("Turn on new models straight away")} hint={t("Off = new models wait as \"new\" until an admin enables them. Safer for costs.")}
                checked={!!draft.hub_auto_enable} disabled={ro} onChange={(v) => set("hub_auto_enable", v)} />
            </Rows>
          </SettingsCard>

          {/* Identity training */}
          <SettingsCard id="identity" index={7} icon={<Fingerprint className="size-4" />} title={t("Identity training")}
            sub={t("Trains a small model of a character's face from their approved photos so keyframes keep the same person (fal.ai).")}>
            <Rows>
              <Row stack label={t("Trainer model")}>
                <Input className="font-mono text-xs" disabled={ro} aria-label={t("Trainer model")} value={it.trainer ?? ""} onChange={(e) => setIt("trainer", e.target.value)} />
              </Row>
              <Row stack label={t("Image model that uses the trained face")}>
                <Input className="font-mono text-xs" disabled={ro} aria-label={t("Image model that uses the trained face")} value={it.inference ?? ""} onChange={(e) => setIt("inference", e.target.value)} />
              </Row>
              <Row label={t("Training steps")} hint={t("More steps = closer likeness, longer and pricier.")}>
                <NumberInput label={t("Training steps")} min={100} max={10000} step={100} disabled={ro} invalid={!Number.isInteger(itSteps) || itSteps < 100 || itSteps > 10000} value={it.steps} onChange={(v) => setIt("steps", v)} />
              </Row>
              <Row label={t("Identity strength")} hint={t("How strongly the trained face is applied (0.1–2).")}>
                <NumberInput label={t("Identity strength")} min={0.1} max={2} step={0.05} disabled={ro} invalid={!Number.isFinite(itScale) || itScale <= 0 || itScale > 2} value={it.scale} onChange={(v) => setIt("scale", v)} />
              </Row>
              <Row label={t("Minimum photos")} hint={t("Approved character images needed before training.")}>
                <NumberInput label={t("Minimum photos")} min={4} max={100} step={1} disabled={ro} invalid={!Number.isInteger(itMin) || itMin < 4 || itMin > 100} value={it.min_images} onChange={(v) => setIt("min_images", v)} />
              </Row>
            </Rows>
          </SettingsCard>

          {/* Voices */}
          <SettingsCard id="voices" index={8} icon={<AudioLines className="size-4" />} title={t("Voices")} sub={t("Which voice service speaks each language.")}>
            <Notice tone="accent" icon={<Languages className="mt-0.5 size-4 shrink-0 text-accent-ink" />} className="mb-4">
              {t("Pick the winner of your Phase 0 listening test for each language.")}
            </Notice>
            <Rows>
              {langs.map((lang) => {
                const val = (draft.tts_provider_by_language as Record<string, string>)[lang] ?? "gemini";
                const mode = providerMode[val];
                return (
                  <Row key={lang} label={t(LANG_NAMES[lang])}>
                    <div className="flex items-center gap-2">
                      {mode && mode !== "live" && <Pill tone={mode === "mock" ? "warn" : "bad"} dot>{mode === "mock" ? t("Mock") : t("No key")}</Pill>}
                      <div className="w-full sm:w-64">
                        <Select value={val} disabled={ro} aria-label={t(LANG_NAMES[lang])}
                          onChange={(e) => set("tts_provider_by_language", { ...draft.tts_provider_by_language, [lang]: e.target.value })}>
                          {TTS_PROVIDERS.map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label}{ttsPrices[p.value] != null ? ` ${t("(~${n} per 1,000 letters)", { n: ttsPrices[p.value] })}` : ""}
                            </option>
                          ))}
                        </Select>
                      </div>
                    </div>
                  </Row>
                );
              })}
            </Rows>
          </SettingsCard>

          {/* Integrations */}
          <SettingsCard id="integrations" index={9} icon={<Plug className="size-4" />} title={t("Integrations")} sub={t("Connect the studio to your channels and other tools.")}>
            <Rows>
              <div><YouTubeIntegration role={role} /></div>
              <Row stack label={t("Make.com webhook address")} hint={t("When an export finishes we send its details here (for Instagram and other channels). Leave blank to turn off.")}>
                <Input type="url" value={draft.make_webhook_url ?? ""} disabled={ro} placeholder="https://hook.eu2.make.com/…" aria-label={t("Make.com webhook address")}
                  className={clsx(!!String(draft.make_webhook_url ?? "").trim() && !/^https?:\/\//i.test(String(draft.make_webhook_url).trim()) && "border-bad/60 focus:border-bad")}
                  onChange={(e) => set("make_webhook_url", e.target.value)} />
              </Row>
            </Rows>
          </SettingsCard>

          {/* API keys */}
          <ProvidersCard providers={data.providers} isAdmin={isAdmin} index={10} />

          {/* Advanced */}
          <SettingsCard id="advanced" index={11} icon={<Wrench className="size-4" />} title={t("Advanced")}
            sub={t("Only change these if a model is renamed or a price changes. Wrong values can break generation.")}>
            <div className="space-y-6">
              <div>
                <h3 className="mb-2 text-sm font-medium">{t("Model names")}</h3>
                <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {Object.keys(data.models).map((key) => {
                    const overridden = key in modelOverrides;
                    const pendingReset = !overridden && key in baseModelOverrides;
                    const value = overridden ? modelOverrides[key] : pendingReset ? "" : data.models[key];
                    return (
                      <div key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                        <div className="w-full shrink-0 sm:w-44">
                          <p className="truncate text-xs font-medium">{t(MODEL_LABELS[key] ?? key)}</p>
                          <p className="truncate font-mono text-2xs text-dim">{key}</p>
                        </div>
                        <div className="min-w-0 flex-1 basis-56">
                          <Input className="h-8 font-mono text-xs" value={value} disabled={ro} aria-label={t(MODEL_LABELS[key] ?? key)}
                            placeholder={pendingReset ? t("Default — shown after saving") : undefined}
                            onChange={(e) => setModel(key, e.target.value)} />
                        </div>
                        <span className="w-[84px] shrink-0 text-right">
                          {overridden && (
                            <button type="button" title={t("Go back to the built-in model")} disabled={ro} onClick={() => resetModel(key)}
                              className="rounded-md px-1.5 py-1 text-2xs font-medium text-accent-ink hover:bg-hover disabled:opacity-50">
                              {t("custom · reset")}
                            </button>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <h3 className="text-sm font-medium">{t("Price overrides (JSON)")}</h3>
                <p className="mb-2 mt-0.5 text-xs text-mute">{t("Only add what you want to change. Overrides merge one level deep, so give every resolution for a video model you change.")}</p>
                <Textarea className="min-h-[200px] font-mono text-xs" spellCheck={false} disabled={ro} value={pricesText} aria-label={t("Price overrides (JSON)")}
                  placeholder={'{\n  "lipsync_per_second": { "lipsync-2": 0.05 }\n}'} onChange={(e) => setPricesText(e.target.value)} />
                {!pricesParsed.ok && <p className="mt-1.5 text-xs text-red-300">{t("Not valid yet: {e}", { e: pricesParsed.error })}</p>}
                <details className="mt-3 rounded-xl border border-line bg-raised/40 px-3 py-2">
                  <summary className="cursor-pointer text-xs font-medium text-mute">{t("Current prices in use")}</summary>
                  <pre className="mt-2 max-h-72 overflow-auto font-mono text-2xs leading-relaxed text-dim">{pretty(data.prices)}</pre>
                </details>
              </div>
            </div>
          </SettingsCard>
        </div>
      </div>

      <div className="h-24" aria-hidden />
      {isAdmin && (
        <UnsavedBar show={dirty} saved={savedFlash && !dirty} saving={saving} error={errors[0]} onDiscard={discard} onSave={save}
          savedLabel={savedCount === 1 ? t("Settings saved (1 change)") : t("Settings saved ({n} changes)", { n: savedCount })}
          message={changeCount === 1 ? t("You have 1 unsaved change.") : t("You have {n} unsaved changes.", { n: changeCount })} />
      )}
    </Page>
  );
}
