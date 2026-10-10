import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  AudioLines, Boxes, Captions, Coins, Fingerprint, Languages, Lock, MessagesSquare, PenLine, Plug, RotateCcw, Save, ScanFace, Settings2,
  SlidersHorizontal, TriangleAlert, Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import "../../styles/console.css";
import "../../styles/settings.css";
import { LoadError } from "../../components/growth/common";
import { CAPTION_STYLES } from "../../components/growth/RenderOptions";
import YouTubeIntegration from "../../components/growth/YouTubeIntegration";
import { MOD } from "../../components/shell/keys";
import { Alert, Button, Input, Kbd, Page, PageHeader, Select, Skeleton, Textarea } from "../../components/ui";
import { api } from "../../lib/api";
import { LANG_NAMES, QUALITY_INFO, usdPerSec } from "../../lib/format";
import { UI_LANGUAGES, useT } from "../../lib/i18n";
import { useAuthStatus, useIntegrations, useMcpInfo, useMcpTokens, useProviderCredit, useSettings } from "../../lib/queries";
import type { Role, SettingsPayload } from "../../lib/types";
import { UnsavedBar } from "./shared/UnsavedBar";
import { useFlash } from "./shared/useFlash";
import { useUnsavedGuard } from "./shared/useUnsavedGuard";
import { Choice, Dollar, NumberInput, Row, Rows, SettingsCard, SliderRow, SwitchRow, TileGroup, ToggleChips } from "./settings/controls";
import { McpAccessCard } from "./settings/McpAccessCard";
import { SECTION_IDS, SETTING_SECTION, SettingsChips, SettingsNav, useScrollSpy } from "./settings/Nav";
import { ProvidersCard } from "./settings/ProvidersCard";
import { SpendGauge, StatusStrip } from "./settings/Status";
import { SectionStateContext, StateTag, type SectionStatus } from "./settings/state";
import { useApiKeys } from "./settings/useApiKeys";

// Keys the backend accepts in PATCH /api/settings (settings_store.DEFAULTS). `engine_policy` is managed in the Model Hub.
const EDITABLE = [
  "team_monthly_cap_usd", "alert_thresholds", "creator_default_monthly_limit_usd", "default_quality_mode", "auto_retake",
  "max_auto_retakes", "qc_threshold", "lipsync_model", "tts_provider_by_language", "make_webhook_url", "models", "prices",
  "dialogue_method", "dub_method", "hub_auto_sync", "hub_sync_hours", "hub_auto_enable", "identity_trainer", "face_match_threshold",
  "lipsync_qc", "lipsync_qc_threshold", "critic_rounds", "critic_min_score", "caption_style", "auto_reframe", "sfx_auto",
  "ui_default_language", "google_first", "native_dialogue_languages", "dialogue_words_qc", "dialogue_words_threshold", "outfit_qc",
  "cheapest_route", "text_provider", "openrouter_text_model", "director_engine", "quota_fallback_routes", "safety_fallback",
  "fallback_extra_limit_usd", "byteplus_auto_register",
  "auto_scene_continuity", "keyframe_qc", "keyframe_auto_retake", "keyframe_qc_threshold",
  "director_claude_model", "director_claude_effort",
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
  fallback_extra_limit_usd: { label: "Extra a backup may cost", min: 0, max: 100 },
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
  { value: "native", label: "Native — Veo speaks the line itself (Google route)", desc: "Speech and lips come out of the video model in one pass, in the languages ticked below. No TTS, no lip-sync step; the words check below guards the result." },
  { value: "native_when_possible", label: "Native when possible", desc: "Let Veo speak the lines directly in its native languages (cheapest, fastest); other languages use audio first." },
];

const DUB_METHODS = [
  { value: "redub", label: "Re-dub", desc: "Keep the original video and lip-sync it to the new language. Cheapest." },
  { value: "regenerate", label: "Regenerate per language", desc: "Make a fresh video for each language. On Veo's native languages Veo speaks the translated line itself; elsewhere the video is driven by that language's recorded audio. Best lips, costs more." },
];

/** The Director chat agent: a Claude model (director_engine "claude" + director_claude_model) or Gemini. */
const DIRECTOR_AGENTS = [
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { value: "gemini", label: "Gemini" },
];

/** How hard Claude thinks per step (director_claude_effort): more effort, better plans, more tokens. */
const DIRECTOR_EFFORTS = [
  { value: "low", label: "Low effort — quickest, cheapest" },
  { value: "medium", label: "Medium effort — balanced (default)" },
  { value: "high", label: "High effort — more thorough" },
  { value: "xhigh", label: "Extra-high effort — long multi-step jobs" },
  { value: "max", label: "Max effort — most thorough, most tokens" },
];

const MODEL_LABELS: Record<string, string> = {
  text: "Writing (fast)", text_pro: "Writing (best quality)", image: "Images", image_hero: "Images (hero)",
  video_saver: "Video — Saver", video_balanced: "Video — Balanced", video_hero: "Video — Hero", omni: "Omni video",
  tts_gemini: "Voice — Gemini", music: "Music (full track)", music_clip: "Music (short clip)", embedding: "Search embeddings",
  tts_elevenlabs: "Voice — ElevenLabs", sts_elevenlabs: "Voice changer — ElevenLabs", ttv_elevenlabs: "Voice design — ElevenLabs",
  tts_sarvam: "Voice — Sarvam", lipsync: "Lip-sync", lipsync_pro: "Lip-sync (pro)", lipsync_angles: "Lip-sync (angles)",
  director_claude: "Director chat — Claude",
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

/** Page frame while loading: header, system strip, section list and a few panels, all as skeletons. */
function SettingsSkeleton() {
  return (
    <Page width="wide">
      <div aria-busy="true">
        <div className="mb-6 flex items-center gap-3"><Skeleton className="size-10 rounded-xl" /><div className="space-y-2"><Skeleton className="h-6 w-40" /><Skeleton className="h-3.5 w-72 max-w-[60vw]" /></div></div>
        <Skeleton className="mb-4 h-24 w-full rounded-xl max-sm:h-48" />
        <div className="cx-split">
          <aside className="max-[900px]:hidden"><Skeleton className="h-[26rem] w-full rounded-xl" /></aside>
          <div className="min-w-0 space-y-4">
            {[220, 260, 340].map((h, i) => <Skeleton key={i} className="w-full rounded-xl" style={{ height: h }} />)}
          </div>
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
  const { data, isLoading, isError, isFetching, refetch } = useSettings();
  const { data: keys, isLoading: keysLoading } = useApiKeys(isAdmin);
  const { data: integrations } = useIntegrations();
  const { data: mcpInfo } = useMcpInfo();
  const { data: mcpTokens } = useMcpTokens();
  const { data: credit } = useProviderCredit();
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
    d.native_dialogue_languages = Array.isArray(d.native_dialogue_languages) ? d.native_dialogue_languages.map(String) : ["en"];
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
  const { changes, errors, errorBy } = useMemo(() => {
    const changes: Record<string, unknown> = {};
    const errors: string[] = [];
    /** First problem per section, so the section list can flag it. */
    const errorBy: Record<string, string> = {};
    if (!draft) return { changes, errors, errorBy };
    for (const k of EDITABLE) {
      const fail = (msg: string) => { errors.push(msg); if (!(SETTING_SECTION[k] in errorBy)) errorBy[SETTING_SECTION[k]] = msg; };
      let v: unknown = draft[k];
      if (k === "alert_thresholds") {
        const th = parseThresholds(thresholdsText);
        if (!th) { fail(t("Alert levels must be numbers separated by commas, for example 50, 80, 100")); continue; }
        v = th;
      } else if (k === "prices") {
        const p = parseJsonObject(pricesText);
        if (!p.ok) { fail(t("Price overrides: {e}", { e: p.error })); continue; }
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
            fail(spec.int
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
        if (!trainer || !inference) { fail(t("Identity training needs both a trainer and an inference model")); continue; }
        if (!Number.isInteger(steps) || steps < 100 || steps > 10000) { fail(t("Training steps must be a whole number from 100 to 10000")); continue; }
        if (!Number.isFinite(scale) || scale <= 0 || scale > 2) { fail(t("Identity strength must be between 0.1 and 2")); continue; }
        if (!Number.isInteger(minImages) || minImages < 4 || minImages > 100) { fail(t("Minimum photos must be a whole number from 4 to 100")); continue; }
        v = { ...it, trainer, inference, steps, scale, min_images: minImages };
      } else if (k === "make_webhook_url") {
        v = String(v ?? "").trim();
        if (v && !/^https?:\/\//i.test(v as string)) { fail(t("Webhook address must start with https://")); continue; }
      }
      if (!same(v, base[k])) changes[k] = v;
    }
    return { changes, errors, errorBy };
  }, [draft, thresholdsText, pricesText, base, t]);

  const changeCount = Object.keys(changes).length;
  const dirty = changeCount > 0 || errors.length > 0;
  /** Unsaved changes per section (drives the amber dot + count in the section list). */
  const dirtyCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const k of Object.keys(changes)) {
      const s = SETTING_SECTION[k];
      if (s) m[s] = (m[s] ?? 0) + 1;
    }
    return m;
  }, [changes]);

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

  if (isError && !data) {
    return (
      <Page width="wide">
        <PageHeader icon={<Settings2 className="size-5" />} title={t("Settings")}
          subtitle={t("Team budget, generation defaults, quality checks, delivery, integrations and AI service keys.")} />
        <LoadError title={t("We couldn't load the settings")} onRetry={() => void refetch()} retrying={isFetching} />
      </Page>
    );
  }
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
  // every language the studio knows (catalog first, then any the voices table lists), for the native-dialogue chips
  const catalogLangs = Object.entries(data.catalog?.languages ?? {});
  const nativeOptions = (catalogLangs.length ? catalogLangs.map(([code, l]) => ({ value: code, label: t(l.name || LANG_NAMES[code] || code) }))
    : langs.map((code) => ({ value: code, label: t(LANG_NAMES[code]) })));
  const nativeLangs = (Array.isArray(draft.native_dialogue_languages) ? draft.native_dialogue_languages : []) as string[];
  const it = (draft.identity_trainer ?? {}) as Record<string, any>;
  const baseIt = (base.identity_trainer ?? {}) as Record<string, any>;
  const setIt = (k: string, v: unknown) => set("identity_trainer", { ...it, [k]: v });
  const num = (k: string, fallback: number) => {
    const n = Number(draft[k]);
    return Number.isFinite(n) ? n : fallback;
  };
  const directorAgent = draft.director_engine === "gemini" ? "gemini"
    : draft.director_claude_model === "claude-opus-5-5" ? "claude-opus-5-5" : "claude-sonnet-5-5";
  const capPct = team.cap_usd ? (team.spent_usd / team.cap_usd) * 100 : 0;
  const bad = (k: string) => numBad(k, draft[k]);
  /** A value that differs from what is saved (or is being edited into something the server would reject). */
  const ch = (k: string) => k in changes || numBad(k, draft[k]);
  const itCh = (f: string, numeric?: boolean) => numeric
    ? Number(it[f]) !== Number(baseIt[f])
    : String(it[f] ?? "").trim() !== String(baseIt[f] ?? "").trim();
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
  const thresholds = parseThresholds(thresholdsText);
  const webhook = String(draft.make_webhook_url ?? "").trim();
  const webhookBad = !!webhook && !/^https?:\/\//i.test(webhook);
  const ttsMap = draft.tts_provider_by_language as Record<string, string>;
  const baseTtsMap = (base.tts_provider_by_language ?? {}) as Record<string, string>;

  // ── health of each section (the glyph in the section list and the panel header) ──
  // keys that run no generation themselves (the BytePlus asset library) are listed for editing but not counted as engines
  const engines = data.providers.filter((p) => p.engine !== false);
  const live = engines.filter((p) => p.mode === "live").length;
  const mocks = engines.filter((p) => p.mode === "mock").length;
  const missing = engines.filter((p) => p.mode === "missing").length;
  const outOfCredit = (credit?.providers ?? []).filter((c) => c.held && providerMode[c.provider] === "live").length;
  const voicesOff = langs.filter((l) => { const m = providerMode[ttsMap[l] ?? "gemini"]; return !!m && m !== "live"; }).length;
  const overrides = Object.keys(baseModelOverrides).length + Object.keys((base.prices ?? {}) as Record<string, unknown>).length;
  const yt = (integrations?.accounts ?? []).filter((a) => a.provider === "youtube");
  const st = (tone: SectionStatus["tone"], label: string): SectionStatus => ({ tone, label });
  const status: Record<string, SectionStatus> = {
    budget: capPct >= 100 ? st("bad", t("Cap reached")) : capPct >= 80 ? st("warn", t("Near the cap")) : team.cap_usd ? st("ok", t("Within budget")) : st("idle", t("No cap set")),
    generation: draft.google_first === false ? st("warn", t("May use fal")) : draft.quota_fallback_routes ? st("info", t("Google first, with backups")) : st("ok", t("Google first")),
    quality: draft.auto_retake ? st("ok", t("Retakes on")) : st("idle", t("Retakes off")),
    dialogue: String(draft.dialogue_method) === "native" && !nativeLangs.length ? st("warn", t("No native languages")) : st("ok", t("Configured")),
    delivery: st("ok", t("Configured")),
    room: num("critic_rounds", 0) > 0 ? st("ok", t("Critic on")) : st("idle", t("Critic off")),
    hub: draft.hub_auto_sync === false ? st("idle", t("Manual updates")) : st("ok", t("Auto-sync on")),
    identity: st("ok", t("Configured")),
    voices: voicesOff ? st("warn", t("{n} on placeholder", { n: voicesOff })) : st("ok", t("All voices ready")),
    integrations: !integrations ? st("idle", "") : !integrations.youtube_ready ? st("warn", t("Needs setup")) : yt.length ? st("ok", t("Connected")) : st("idle", t("Not connected")),
    mcp: !mcpInfo ? st("idle", "") : !mcpInfo.enabled ? st("warn", t("Server off")) : mcpTokens?.length ? st("ok", t("{n} active", { n: mcpTokens.length })) : st("idle", t("Not set up")),
    keys: missing ? st("bad", t("{n} missing", { n: missing })) : outOfCredit ? st("warn", t("{n} out of credit", { n: outOfCredit }))
      : mocks ? st("warn", t("{n} on placeholder", { n: mocks })) : engines.length && live === engines.length ? st("ok", t("All live")) : st("idle", ""),
    advanced: overrides ? st("info", t("{n} custom", { n: overrides })) : st("idle", t("Defaults")),
  };
  for (const sec of Object.keys(errorBy)) status[sec] = st("bad", t("Needs fixing"));
  const keyStats = isAdmin
    ? {
      loading: keysLoading, total: data.providers.length,
      present: (keys ?? []).filter((k) => k.source !== "missing").length,
      saved: (keys ?? []).filter((k) => k.source === "admin").length,
      env: (keys ?? []).filter((k) => k.source === "env").length,
    }
    : null;

  return (
    <Page width="wide">
      <PageHeader
        icon={<Settings2 className="size-5" />}
        title={t("Settings")}
        subtitle={t("Team budget, generation defaults, quality checks, delivery, integrations and AI service keys.")}
        actions={isAdmin ? (
          <>
            {dirty && <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={discard}>{t("Discard")}</Button>}
            <Button variant="secondary" icon={<Save className="size-4" />} loading={saving} disabled={!dirty || !!errors.length} onClick={save}>
              {changeCount ? t("Save changes ({n})", { n: changeCount }) : t("Save changes")}
            </Button>
          </>
        ) : undefined}
      />

      {ro && (
        <Alert tone="info" icon={<Lock className="size-4" />} className="mb-4">
          {t("You're viewing settings read-only. Only admins can change them.")}
        </Alert>
      )}

      <div className="mb-4">
        <StatusStrip providers={data.providers} keys={keyStats} team={team} changeCount={changeCount} dirtySections={Object.keys(dirtyCount).length}
          errorCount={errors.length} isAdmin={isAdmin} />
      </div>

      <SettingsChips active={active} onSelect={select} dirty={dirtyCount} status={status} />

      <SectionStateContext.Provider value={{ active, status, dirty: dirtyCount }}>
        <div className="cx-split">
          <aside className="max-[900px]:hidden">
            <SettingsNav active={active} onSelect={select} dirty={dirtyCount} status={status} />
          </aside>

          <div className="min-w-0 space-y-4">
            {/* Budget */}
            <SettingsCard id="budget" index={0} icon={<Coins className="size-4" />} title={t("Budget")} sub={t("Monthly spending limits for the whole team.")}>
              <SpendGauge spent={team.spent_usd} cap={team.cap_usd} reserved={team.reserved_usd} thresholds={thresholds} />
              <Rows>
                <Row label={t("Team monthly cap")} hint={t("Nobody can spend past this. 0 = no cap.")} changed={ch("team_monthly_cap_usd")}>
                  <Dollar label={t("Team monthly cap")} value={draft.team_monthly_cap_usd} disabled={ro} invalid={bad("team_monthly_cap_usd")} onChange={(v) => set("team_monthly_cap_usd", v)} />
                </Row>
                <Row label={t("Default creator limit (per month)")} hint={t("Used when a creator has no personal limit. Blank = no limit.")} changed={ch("creator_default_monthly_limit_usd")}>
                  <Dollar label={t("Default creator limit (per month)")} value={draft.creator_default_monthly_limit_usd} disabled={ro} placeholder={t("No limit")} invalid={bad("creator_default_monthly_limit_usd")}
                    onChange={(v) => set("creator_default_monthly_limit_usd", v)} />
                </Row>
                <Row label={t("Alert me at (% of cap)")} hint={t("Comma list. Admins are alerted when spending crosses each level.")} changed={"alert_thresholds" in changes || !thresholds}>
                  <div className="w-full max-w-44"><Input value={thresholdsText} disabled={ro} placeholder="50, 80, 100" aria-label={t("Alert me at (% of cap)")} aria-invalid={!thresholds || undefined}
                    className={clsx("font-mono tabular-nums", !thresholds && "border-bad/60 focus:border-bad")} onChange={(e) => setThresholdsText(e.target.value)} /></div>
                </Row>
              </Rows>
            </SettingsCard>

            {/* Generation defaults */}
            <SettingsCard id="generation" index={1} icon={<SlidersHorizontal className="size-4" />} title={t("Generation defaults")} sub={t("Used by new projects.")}>
              <Rows>
                <SwitchRow label={t("Google first (your Gemini key)")}
                  hint={draft.google_first !== false
                    ? t("Keyframes, videos and edits use only Google. If Google's quota is reached, jobs wait for it instead of moving to fal. fal is used only for what Google can't do (e.g. lip-sync) or when you pick a fal engine for a shot.")
                    : t("Off: when a Google engine fails or is rate-limited, the job moves to the next engine in the chain (fal, BytePlus or OpenRouter), which bills that provider.")}
                  checked={draft.google_first !== false} disabled={ro} changed={ch("google_first")} onChange={(v) => set("google_first", v)} />
                <SwitchRow label={t("Cheapest route first")}
                  hint={draft.cheapest_route !== false
                    ? t("When a model runs on several providers (e.g. Seedance on BytePlus, OpenRouter and fal), the cheapest live one is tried first and the others take over if it fails.")
                    : t("Off: the engine named in the chain is tried first; its other providers are only a fallback.")}
                  checked={draft.cheapest_route !== false} disabled={ro} changed={ch("cheapest_route")} onChange={(v) => set("cheapest_route", v)} />
                <Row label={t("Writing (scripts, prompts, reviews)")} hint={t("OpenRouter is also used automatically when there is no Gemini key. Clips sent for review stay on Gemini, which watches video.")} changed={ch("text_provider") || ch("openrouter_text_model")}>
                  <div className="flex w-full max-w-md flex-wrap gap-2">
                    <div className="min-w-36 flex-1">
                      <Select value={draft.text_provider ?? "gemini"} disabled={ro} aria-label={t("Writing (scripts, prompts, reviews)")} onChange={(e) => set("text_provider", e.target.value)}>
                        <option value="gemini">{t("Gemini (your Gemini key)")}</option>
                        <option value="openrouter">{t("OpenRouter")}</option>
                      </Select>
                    </div>
                    {draft.text_provider === "openrouter" && (
                      <Input className="min-w-44 flex-1 font-mono" value={draft.openrouter_text_model ?? ""} disabled={ro} aria-label={t("OpenRouter model")}
                        placeholder={t("Same Gemini model")} onChange={(e) => set("openrouter_text_model", e.target.value.trim())} />
                    )}
                  </div>
                </Row>
                <Row label={t("Director chat agent")} hint={t("Claude needs an Anthropic key (AI services below); without one the Director uses Gemini. If you pick Gemini, Claude is never used. Opus 5.5 plans better and costs about twice as much as Sonnet 5.5.")}
                  changed={ch("director_engine") || ch("director_claude_model") || ch("director_claude_effort")}>
                  <div className="flex w-full max-w-md flex-wrap gap-2">
                    <div className="min-w-36 flex-1">
                      <Select value={directorAgent} disabled={ro} aria-label={t("Director chat agent")}
                        onChange={(e) => {
                          const v = e.target.value;
                          set("director_engine", v === "gemini" ? "gemini" : "claude");
                          if (v !== "gemini") set("director_claude_model", v === "claude-opus-5-5" ? v : ""); // "" = the default, Sonnet 5.5
                        }}>
                        {DIRECTOR_AGENTS.map((a) => <option key={a.value} value={a.value}>{t(a.label)}</option>)}
                      </Select>
                    </div>
                    {directorAgent !== "gemini" && (
                      <div className="min-w-44 flex-1">
                        <Select value={draft.director_claude_effort || "medium"} disabled={ro} aria-label={t("Director effort")}
                          onChange={(e) => set("director_claude_effort", e.target.value)}>
                          {DIRECTOR_EFFORTS.map((x) => <option key={x.value} value={x.value}>{t(x.label)}</option>)}
                        </Select>
                      </div>
                    )}
                  </div>
                </Row>
                <Row stack label={t("Default video quality")} hint={t(QUALITY_INFO[quality]?.desc ?? "")} changed={ch("default_quality_mode")}>
                  <TileGroup ariaLabel={t("Default video quality")} value={quality} disabled={ro} onChange={(v) => set("default_quality_mode", v)}
                    options={Object.entries(QUALITY_INFO).map(([value, q]) => ({
                      value,
                      title: t(q.desc),
                      label: t(q.label),
                      sub: <span className="text-money">{q.price}</span>,
                    }))} />
                </Row>
                <Row label={t("Lip-sync model")} hint={t("Used when a voice is recorded first and the mouth is matched afterwards.")} changed={ch("lipsync_model")}>
                  <div className="w-full max-w-md">
                    <Select value={draft.lipsync_model ?? "lipsync-2"} disabled={ro} aria-label={t("Lip-sync model")} onChange={(e) => set("lipsync_model", e.target.value)}>
                      {LIPSYNC_MODELS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {t(m.label)}{lipsyncPrices[m.value] != null ? ` (~${usdPerSec(Number(lipsyncPrices[m.value]))})` : ""}
                        </option>
                      ))}
                    </Select>
                  </div>
                </Row>
              </Rows>

              {/* backup routes: what may happen when the first choice can't make a shot, and how much more it may cost */}
              <div className="mt-6 border-t border-line pt-5">
                <h3 className="text-sm font-medium">{t("Backup routes and spend safety")}</h3>
                <p className="mb-4 mt-0.5 max-w-[62ch] text-xs leading-relaxed text-mute">
                  {t("What the studio may do when the first choice can't make a shot. A backup never spends more than the limit below without a producer's approval.")}
                </p>
                <Rows>
                  <SwitchRow label={t("When Google's quota runs out, use the same model through another provider")}
                    hint={draft.google_first === false
                      ? t("Google first is off, so jobs already move to other providers when Google is busy.")
                      : draft.quota_fallback_routes
                        ? t("For example Nano Banana images through OpenRouter, so keyframes keep coming. That provider bills the work.")
                        : t("Off: Google first stays strict, and jobs wait for Google's quota to come back.")}
                    checked={!!draft.quota_fallback_routes} disabled={ro || draft.google_first === false} changed={ch("quota_fallback_routes")}
                    onChange={(v) => set("quota_fallback_routes", v)} />
                  <SwitchRow label={t("On a safety block, try another model")}
                    hint={t("When every engine tried blocks a shot for safety, other models get a turn, starting with those that keep registered characters (Seedance). Works even with Google first on.")}
                    checked={!!draft.safety_fallback} disabled={ro} changed={ch("safety_fallback")} onChange={(v) => set("safety_fallback", v)} />
                  <Row label={t("Extra a backup may cost")} changed={ch("fallback_extra_limit_usd")}
                    hint={t("How much more than the approved price a backup route may spend. Above this, the job pauses and asks a producer to approve it.")}>
                    <Dollar label={t("Extra a backup may cost")} value={draft.fallback_extra_limit_usd} disabled={ro} invalid={bad("fallback_extra_limit_usd")}
                      onChange={(v) => set("fallback_extra_limit_usd", v)} />
                  </Row>
                  <SwitchRow label={t("Register AI characters with BytePlus automatically")}
                    hint={<>
                      {t("When a character's sheet is approved or the character is locked, it is registered so Seedance keeps its look. Never for characters made from someone's photo: real people verify themselves in the BytePlus console.")}
                      {providerMode.byteplus_iam && providerMode.byteplus_iam !== "live" && (
                        <span className="mt-1 flex items-start gap-1.5 text-amber-300">
                          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                          <span>
                            {t("Needs the BytePlus asset library key.")}{" "}
                            <a href="#keys" className="font-medium text-accent-ink hover:underline" onClick={(e) => { e.preventDefault(); select("keys"); }}>{t("Go to AI services")}</a>
                          </span>
                        </span>
                      )}
                    </>}
                    checked={!!draft.byteplus_auto_register} disabled={ro} changed={ch("byteplus_auto_register")} onChange={(v) => set("byteplus_auto_register", v)} />
                </Rows>
              </div>
            </SettingsCard>

            {/* Quality control */}
            <SettingsCard id="quality" index={2} icon={<ScanFace className="size-4" />} title={t("Quality control")}
              sub={t("Every new take is checked for the right faces, extra people, garbled text and lip-sync. Failing takes can be retried automatically.")}>
              <Rows>
                <SwitchRow label={t("Automatic retakes")} hint={t("Re-shoot a take that fails the check, trying another engine.")}
                  checked={!!draft.auto_retake} disabled={ro} changed={ch("auto_retake")} onChange={(v) => set("auto_retake", v)} />
                <Row label={t("Max retakes per shot")} hint={t("0 to 5. Each retake costs money.")} changed={ch("max_auto_retakes")}>
                  <NumberInput label={t("Max retakes per shot")} min={0} max={5} step={1} disabled={ro || !draft.auto_retake} invalid={bad("max_auto_retakes")} value={draft.max_auto_retakes}
                    onChange={(v) => set("max_auto_retakes", v)} />
                </Row>
                <SliderRow label={t("Visual check strictness")} hint={t("AI review score a take needs to pass")} value={num("qc_threshold", 0.7)} min={0} max={1} step={0.05}
                  disabled={ro} changed={ch("qc_threshold")} onChange={(v) => set("qc_threshold", v)} left={t("Relaxed")} right={t("Strict")} />
                <SliderRow label={t("Face match threshold")} hint={t("Face similarity to the character photos · 0.36 ≈ same person")} value={num("face_match_threshold", 0.36)}
                  min={0.2} max={0.6} step={0.01} disabled={ro} changed={ch("face_match_threshold")} onChange={(v) => set("face_match_threshold", v)} left={t("Looser")} right={t("Stricter")} />
                <SwitchRow label={t("Lip-sync check")} hint={t("AI watches dubbed and lip-synced clips with sound and scores the mouth movement.")}
                  checked={!!draft.lipsync_qc} disabled={ro} changed={ch("lipsync_qc")} onChange={(v) => set("lipsync_qc", v)} />
                <SliderRow label={t("Lip-sync pass score")} value={num("lipsync_qc_threshold", 0.6)} min={0} max={1} step={0.05}
                  disabled={ro || !draft.lipsync_qc} changed={ch("lipsync_qc_threshold")} onChange={(v) => set("lipsync_qc_threshold", v)} left={t("Relaxed")} right={t("Strict")} />
                <SwitchRow label={t("Scene continuity")} hint={t("Every shot of a scene follows the scene's anchor keyframe (its first shot unless you pin another) for set, light and wardrobe, and the shot before it in the same place. Links you set on a shot still win.")}
                  checked={draft.auto_scene_continuity !== false} disabled={ro} changed={ch("auto_scene_continuity")} onChange={(v) => set("auto_scene_continuity", v)} />
                <SwitchRow label={t("Keyframe check")} hint={t("A quick AI look at every new keyframe: faces, wardrobe, set and light against the scene, extra people, hands and text.")}
                  checked={draft.keyframe_qc !== false} disabled={ro} changed={ch("keyframe_qc")} onChange={(v) => set("keyframe_qc", v)} />
                <SwitchRow label={t("Retake a failed keyframe once")} hint={t("One new keyframe when the check fails. It costs one image.")}
                  checked={draft.keyframe_auto_retake !== false} disabled={ro || draft.keyframe_qc === false} changed={ch("keyframe_auto_retake")}
                  onChange={(v) => set("keyframe_auto_retake", v)} />
                <SliderRow label={t("Scene match pass score")} hint={t("How closely set, light and wardrobe must match the scene's anchor keyframe")} value={num("keyframe_qc_threshold", 0.6)}
                  min={0} max={1} step={0.05} disabled={ro || draft.keyframe_qc === false} changed={ch("keyframe_qc_threshold")}
                  onChange={(v) => set("keyframe_qc_threshold", v)} left={t("Relaxed")} right={t("Strict")} />
              </Rows>
            </SettingsCard>

            {/* Dialogue & dubbing */}
            <SettingsCard id="dialogue" index={3} icon={<MessagesSquare className="size-4" />} title={t("Dialogue & dubbing")}
              sub={t("How speaking shots are made. Projects and individual shots can override this.")}>
              <Rows>
                <Row stack label={t("Dialogue method")} changed={ch("dialogue_method")}>
                  <Choice ariaLabel={t("Dialogue method")} options={DIALOGUE_METHODS} value={String(draft.dialogue_method ?? "audio_first")} disabled={ro}
                    onChange={(v) => set("dialogue_method", v)} />
                </Row>
                <Row stack label={t("Languages Veo may speak itself")} changed={ch("native_dialogue_languages")}
                  hint={t("Native dialogue is only used in these languages (speech and lips in one pass). Every other language is recorded with TTS and lip-synced. Decide the list from your Phase 0 test.")}>
                  <ToggleChips ariaLabel={t("Languages Veo may speak itself")} options={nativeOptions} value={nativeLangs} disabled={ro}
                    onChange={(v) => set("native_dialogue_languages", v)} />
                  {!nativeLangs.length && (
                    <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-300">
                      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      {t("With no language ticked, native dialogue is never used; shots fall back to audio first.")}
                    </p>
                  )}
                </Row>
                <Row stack label={t("Dubbing into other languages")} changed={ch("dub_method")}>
                  <Choice ariaLabel={t("Dubbing into other languages")} options={DUB_METHODS} value={String(draft.dub_method ?? "redub")} disabled={ro} onChange={(v) => set("dub_method", v)} />
                </Row>
                <SwitchRow label={t("Check the spoken words")}
                  hint={t("After a spoken clip (native or lip-synced), AI listens and checks that it said the scripted words in the right language. Failing takes are flagged.")}
                  checked={draft.dialogue_words_qc !== false} disabled={ro} changed={ch("dialogue_words_qc")} onChange={(v) => set("dialogue_words_qc", v)} />
                <SliderRow label={t("Words match threshold")} hint={t("Share of the scripted words a take must get right to pass.")}
                  value={num("dialogue_words_threshold", 0.75)} min={0} max={1} step={0.05} disabled={ro || draft.dialogue_words_qc === false} changed={ch("dialogue_words_threshold")}
                  onChange={(v) => set("dialogue_words_threshold", v)} left={t("Lenient")} right={t("Exact")} />
                <SwitchRow label={t("Outfit check")}
                  hint={t("Fail a take whose outfit does not match the scene's wardrobe, when the character lock asks for costume continuity.")}
                  checked={draft.outfit_qc !== false} disabled={ro} changed={ch("outfit_qc")} onChange={(v) => set("outfit_qc", v)} />
              </Rows>
            </SettingsCard>

            {/* Captions & delivery */}
            <SettingsCard id="delivery" index={4} icon={<Captions className="size-4" />} title={t("Captions & delivery")} sub={t("Defaults for every render. Each episode can pick its own caption style on the Export page.")}>
              <Rows>
                <Row stack label={t("Default caption style")} hint={t(CAPTION_STYLES.find((c) => c.value === draft.caption_style)?.desc ?? "")} changed={ch("caption_style")}>
                  <TileGroup ariaLabel={t("Default caption style")} value={String(draft.caption_style ?? "karaoke")} disabled={ro} onChange={(v) => set("caption_style", v)}
                    options={CAPTION_STYLES.map((c) => ({ value: c.value, label: t(c.label), title: t(c.desc) }))} />
                </Row>
                <SwitchRow label={t("Auto-reframe")} hint={t("When a clip's shape differs from the export (e.g. 16:9 → 9:16), crop around the main face instead of the centre.")}
                  checked={draft.auto_reframe !== false} disabled={ro} changed={ch("auto_reframe")} onChange={(v) => set("auto_reframe", v)} />
                <SwitchRow label={t("Automatic sound effects")} hint={t("Autopilot designs ambience and spot effects for each episode (ElevenLabs; small cost).")}
                  checked={!!draft.sfx_auto} disabled={ro} changed={ch("sfx_auto")} onChange={(v) => set("sfx_auto", v)} />
                <Row label={t("Default interface language")} hint={t("For people who haven't picked their own language yet.")} changed={ch("ui_default_language")}>
                  <div className="w-full max-w-md">
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
                <Row label={t("Critic rounds")} hint={t("Rewrite rounds per run. 0 to 5.")} changed={ch("critic_rounds")}>
                  <NumberInput label={t("Critic rounds")} min={0} max={5} step={1} disabled={ro} invalid={bad("critic_rounds")} value={draft.critic_rounds} onChange={(v) => set("critic_rounds", v)} />
                </Row>
                <Row label={t("Critic pass score")} hint={t("Out of 10. Stop rewriting once the script reaches this.")} changed={ch("critic_min_score")}>
                  <NumberInput label={t("Critic pass score")} min={0} max={10} step={0.5} disabled={ro} invalid={bad("critic_min_score")} value={draft.critic_min_score} onChange={(v) => set("critic_min_score", v)} />
                </Row>
              </Rows>
            </SettingsCard>

            {/* Model Hub */}
            <SettingsCard id="hub" index={6} icon={<Boxes className="size-4" />} title={t("Model Hub")}
              sub={<>{t("Keep the list of video, voice and image models up to date.")} <Link to="/models" className="font-medium text-accent-ink hover:underline">{t("Open Model Hub")}</Link></>}>
              <Rows>
                <SwitchRow label={t("Check for new models automatically")} hint={t("Syncs the fal.ai catalogue and prices in the background.")}
                  checked={draft.hub_auto_sync !== false} disabled={ro} changed={ch("hub_auto_sync")} onChange={(v) => set("hub_auto_sync", v)} />
                <Row label={t("Check every (hours)")} hint={t("1 to 720.")} changed={ch("hub_sync_hours")}>
                  <NumberInput label={t("Check every (hours)")} min={1} max={720} step={1} disabled={ro || draft.hub_auto_sync === false} invalid={bad("hub_sync_hours")} value={draft.hub_sync_hours}
                    onChange={(v) => set("hub_sync_hours", v)} />
                </Row>
                <SwitchRow label={t("Turn on new models straight away")} hint={t("Off = new models wait as \"new\" until an admin enables them. Safer for costs.")}
                  checked={!!draft.hub_auto_enable} disabled={ro} changed={ch("hub_auto_enable")} onChange={(v) => set("hub_auto_enable", v)} />
              </Rows>
            </SettingsCard>

            {/* Identity training */}
            <SettingsCard id="identity" index={7} icon={<Fingerprint className="size-4" />} title={t("Identity training")}
              sub={t("Trains a small model of a character's face from their approved photos so keyframes keep the same person (fal.ai).")}>
              <Rows>
                <Row stack label={t("Trainer model")} changed={itCh("trainer")}>
                  <Input className="font-mono text-xs" disabled={ro} aria-label={t("Trainer model")} value={it.trainer ?? ""} onChange={(e) => setIt("trainer", e.target.value)} />
                </Row>
                <Row stack label={t("Image model that uses the trained face")} changed={itCh("inference")}>
                  <Input className="font-mono text-xs" disabled={ro} aria-label={t("Image model that uses the trained face")} value={it.inference ?? ""} onChange={(e) => setIt("inference", e.target.value)} />
                </Row>
                <Row label={t("Training steps")} hint={t("More steps = closer likeness, longer and pricier.")} changed={itCh("steps", true)}>
                  <NumberInput label={t("Training steps")} min={100} max={10000} step={100} disabled={ro} invalid={!Number.isInteger(itSteps) || itSteps < 100 || itSteps > 10000} value={it.steps} onChange={(v) => setIt("steps", v)} />
                </Row>
                <Row label={t("Identity strength")} hint={t("How strongly the trained face is applied (0.1–2).")} changed={itCh("scale", true)}>
                  <NumberInput label={t("Identity strength")} min={0.1} max={2} step={0.05} disabled={ro} invalid={!Number.isFinite(itScale) || itScale <= 0 || itScale > 2} value={it.scale} onChange={(v) => setIt("scale", v)} />
                </Row>
                <Row label={t("Minimum photos")} hint={t("Approved character images needed before training.")} changed={itCh("min_images", true)}>
                  <NumberInput label={t("Minimum photos")} min={4} max={100} step={1} disabled={ro} invalid={!Number.isInteger(itMin) || itMin < 4 || itMin > 100} value={it.min_images} onChange={(v) => setIt("min_images", v)} />
                </Row>
              </Rows>
            </SettingsCard>

            {/* Voices */}
            <SettingsCard id="voices" index={8} icon={<AudioLines className="size-4" />} title={t("Voices")} sub={t("Which voice service speaks each language.")}>
              <Alert tone="accent" icon={<Languages className="size-4" />} className="mb-4">
                {t("Pick the winner of your Phase 0 listening test for each language.")}
              </Alert>
              <Rows>
                {langs.map((lang) => {
                  const val = ttsMap[lang] ?? "gemini";
                  const mode = providerMode[val];
                  return (
                    <Row key={lang} label={t(LANG_NAMES[lang])} changed={!same(ttsMap[lang], baseTtsMap[lang])}
                      hint={mode ? (
                        <StateTag tone={mode === "live" ? "ok" : mode === "mock" ? "warn" : "bad"} live={mode === "live"} title={mode === "mock" ? t("Mock — free placeholder") : undefined}>
                          {mode === "live" ? t("Live") : mode === "mock" ? t("Placeholder") : t("No key")}
                        </StateTag>
                      ) : undefined}>
                      <div className="w-full max-w-md">
                        <Select value={val} disabled={ro} aria-label={t(LANG_NAMES[lang])}
                          onChange={(e) => set("tts_provider_by_language", { ...draft.tts_provider_by_language, [lang]: e.target.value })}>
                          {TTS_PROVIDERS.map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label}{ttsPrices[p.value] != null ? ` ${t("(~${n} per 1,000 letters)", { n: ttsPrices[p.value] })}` : ""}
                            </option>
                          ))}
                        </Select>
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
                <Row stack label={t("Make.com webhook address")} hint={t("When an export finishes we send its details here (for Instagram and other channels). Leave blank to turn off.")}
                  changed={"make_webhook_url" in changes || webhookBad}>
                  <Input type="url" value={draft.make_webhook_url ?? ""} disabled={ro} placeholder="https://hook.eu2.make.com/…" aria-label={t("Make.com webhook address")}
                    aria-invalid={webhookBad || undefined}
                    className={clsx("font-mono text-xs", webhookBad && "border-bad/60 focus:border-bad")}
                    onChange={(e) => set("make_webhook_url", e.target.value)} />
                </Row>
              </Rows>
            </SettingsCard>

            {/* MCP access (per user, every role) */}
            <McpAccessCard index={10} />

            {/* API keys */}
            <ProvidersCard providers={data.providers} isAdmin={isAdmin} index={11} prices={data.prices} />

            {/* Advanced */}
            <SettingsCard id="advanced" index={12} icon={<Wrench className="size-4" />} title={t("Advanced")}
              sub={t("Only change these if a model is renamed or a price changes. Wrong values can break generation.")}>
              <div className="space-y-6">
                <div>
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
                    {t("Model names")}
                    <span className="mono rounded-md border border-line bg-raised/60 px-1.5 py-0.5 text-2xs font-normal text-dim">{Object.keys(data.models).length}</span>
                  </h3>
                  <div className="cx-block overflow-hidden">
                    {Object.keys(data.models).map((key) => {
                      const overridden = key in modelOverrides;
                      const pendingReset = !overridden && key in baseModelOverrides;
                      const value = overridden ? modelOverrides[key] : pendingReset ? "" : data.models[key];
                      const modelChanged = !same(modelOverrides[key], baseModelOverrides[key]);
                      return (
                        <div key={key} className="st-model">
                          <div className="min-w-0">
                            <p className="flex items-center gap-2 text-xs font-medium">
                              {modelChanged && (
                                <>
                                  <i aria-hidden className="st-dot" />
                                  <span className="sr-only">{t("Unsaved changes")}</span>
                                </>
                              )}
                              <span className="min-w-0 truncate">{t(MODEL_LABELS[key] ?? key)}</span>
                            </p>
                            <p className="truncate font-mono text-2xs text-dim">{key}</p>
                            {overridden && (
                              <button type="button" title={t("Go back to the built-in model")} disabled={ro} onClick={() => resetModel(key)}
                                className="-ml-1.5 mt-0.5 rounded-md px-1.5 py-1 text-2xs font-medium text-accent-ink hover:bg-hover disabled:opacity-50 max-sm:py-2.5">
                                {t("custom · reset")}
                              </button>
                            )}
                          </div>
                          <Input className="h-8 font-mono text-xs max-sm:h-10" value={value} disabled={ro} aria-label={t(MODEL_LABELS[key] ?? key)}
                            placeholder={pendingReset ? t("Default — shown after saving") : undefined}
                            onChange={(e) => setModel(key, e.target.value)} />
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-medium">{t("Price overrides (JSON)")}</h3>
                  <p className="mb-2 mt-0.5 max-w-[62ch] text-xs text-mute">{t("Only add what you want to change. Overrides merge one level deep, so give every resolution for a video model you change.")}</p>
                  <Textarea className="min-h-[200px] font-mono text-xs" spellCheck={false} disabled={ro} value={pricesText} aria-label={t("Price overrides (JSON)")}
                    aria-invalid={!pricesParsed.ok || undefined}
                    placeholder={'{\n  "lipsync_per_second": { "lipsync-2": 0.05 }\n}'} onChange={(e) => setPricesText(e.target.value)} />
                  {!pricesParsed.ok && <p className="mt-1.5 text-xs text-red-300">{t("Not valid yet: {e}", { e: pricesParsed.error })}</p>}
                  <details className="cx-block mt-3 px-3 py-2">
                    <summary className="cursor-pointer text-xs font-medium text-mute max-sm:py-2">{t("Current prices in use")}</summary>
                    <pre className="cx-scroll mt-2 max-h-72 font-mono text-2xs leading-relaxed text-dim">{pretty(data.prices)}</pre>
                  </details>
                </div>
              </div>
            </SettingsCard>
          </div>
        </div>
      </SectionStateContext.Provider>

      <div className="h-24" aria-hidden />
      {isAdmin && (
        <UnsavedBar show={dirty} saved={savedFlash && !dirty} saving={saving} error={errors[0]} onDiscard={discard} onSave={save} count={changeCount}
          shortcut={<><Kbd>{MOD}</Kbd><Kbd>S</Kbd></>}
          savedLabel={savedCount === 1 ? t("Settings saved (1 change)") : t("Settings saved ({n} changes)", { n: savedCount })}
          message={changeCount === 1 ? t("You have 1 unsaved change.") : t("You have {n} unsaved changes.", { n: changeCount })} />
      )}
    </Page>
  );
}
