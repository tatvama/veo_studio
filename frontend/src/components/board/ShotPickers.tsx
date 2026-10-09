import { clsx } from "clsx";
import {
  AlertTriangle, Check, ChevronDown, Cpu, ImagePlus, Images, Info, MapPin, Plus, Search, UserRound, Volume2, Wand2,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { usd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { Character, VideoEngine, VideoEngines, VideoFit } from "../../lib/types";
import { Avatar, Badge, Button, Popover, Toggle, Tooltip } from "../ui";
import { SeedanceBadge } from "../room/SeedanceBadge";
import { TONE_TEXT_SM } from "../room/util";
import { providerName } from "../hub/Chips";

// ── characters ───────────────────────────────────────────────────────────────

/** "+ Character": pick from this project's cast or the library, or make a new one (name + optional photo). */
export function CharacterPicker({ selected, projectCast, library, onToggle, onCreate, disabled }: {
  selected: number[]; projectCast: Character[]; library: Character[]; onToggle: (id: number) => void;
  /** creates the character in this project; resolves with it (or undefined if it failed) */
  onCreate?: (name: string, photo: File | null) => Promise<Character | undefined>; disabled?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const inProject = new Set(projectCast.map((c) => c.id));
  const others = library.filter((c) => !inProject.has(c.id));
  const needle = q.trim().toLowerCase();
  const match = (c: Character) => !needle || c.name.toLowerCase().includes(needle);
  const exact = [...projectCast, ...others].some((c) => c.name.trim().toLowerCase() === needle);

  const create = async () => {
    if (!onCreate || !q.trim()) return;
    setBusy(true);
    try {
      const c = await onCreate(q.trim(), photo);
      if (c) { onToggle(c.id); setQ(""); setPhoto(null); setOpen(false); }
    } finally { setBusy(false); }
  };

  const row = (c: Character) => {
    const on = selected.includes(c.id);
    return (
      <button key={c.id} type="button" onClick={() => onToggle(c.id)} role="option" aria-selected={on}
        className={clsx("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors", on ? "bg-accent/10" : "hover:bg-hover")}>
        <Avatar name={c.name} src={c.avatar_url} size={24} />
        <span className="min-w-0 flex-1 truncate">{c.name}</span>
        {!c.avatar_url && <span className={clsx("text-2xs", TONE_TEXT_SM.warn)}>{t("no photo")}</span>}
        {on && <Check className="size-4 text-accent-ink" strokeWidth={3} />}
      </button>
    );
  };

  return (
    <>
      <button ref={ref} type="button" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-accent/50 px-2 text-2xs font-medium text-accent-ink transition-colors hover:bg-accent/10 disabled:opacity-50 pointer-coarse:h-8">
        <Plus className="size-3" />{t("Character")}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={300} className="p-2">
        <label className="mb-1.5 flex items-center gap-2 rounded-lg border border-line bg-raised/60 px-2">
          <Search className="size-3.5 text-dim" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Find or name a new character…")}
            onKeyDown={(e) => { if (e.key === "Enter" && needle && !exact) void create(); }}
            className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none" aria-label={t("Find or name a new character…")} />
        </label>
        <div className="max-h-64 space-y-0.5 overflow-y-auto" role="listbox" aria-multiselectable>
          {projectCast.filter(match).length > 0 && <p className="eyebrow px-2 pb-1 pt-1.5">{t("In this project")}</p>}
          {projectCast.filter(match).map(row)}
          {others.filter(match).length > 0 && <p className="eyebrow px-2 pb-1 pt-2.5">{t("From your library")}</p>}
          {others.filter(match).slice(0, 30).map(row)}
          {!projectCast.length && !others.length && !needle && <p className="px-2 py-3 text-center text-xs text-dim">{t("No characters yet — type a name to make one.")}</p>}
        </div>
        {onCreate && needle && !exact && (
          <div className="mt-2 space-y-1.5 border-t border-line pt-2">
            <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs text-mute hover:bg-hover">
              <ImagePlus className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{photo ? photo.name : t("Add their photo (recommended: the face stays the same)")}</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
            </label>
            <Button size="sm" variant="primary" className="w-full" loading={busy} icon={<Plus className="size-3.5" />} onClick={() => void create()}>
              {t("Create “{name}”", { name: q.trim() })}
            </Button>
          </div>
        )}
      </Popover>
    </>
  );
}

// ── video model ──────────────────────────────────────────────────────────────

const VIA_LABEL: Record<VideoFit["characters"], string> = {
  refs: "photos go to the model", keyframe: "through the keyframe", none: "can't use them",
};

/** Small icons for what a model can use from the shot. */
export function FitChips({ fit, className }: { fit: VideoFit; className?: string }) {
  const t = useT();
  const tone = fit.characters === "none" ? TONE_TEXT_SM.bad : fit.characters === "refs" ? TONE_TEXT_SM.ok : "text-mute";
  return (
    <span className={clsx("inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs", className)}>
      <span className={clsx("mono inline-flex items-center gap-0.5", tone)}
        title={t("Characters: {how}", { how: t(VIA_LABEL[fit.characters]) })}>
        <UserRound className="size-3" />{fit.characters === "refs" ? `${fit.max_refs}` : fit.characters === "keyframe" ? t("via keyframe") : "✕"}
      </span>
      <span className={clsx("inline-flex items-center gap-0.5", fit.location === "none" ? TONE_TEXT_SM.bad : "text-mute")}
        title={t("Location: {how}", { how: t(VIA_LABEL[fit.location]) })}><MapPin className="size-3" />{fit.location === "none" ? "✕" : "✓"}</span>
      <span className={clsx("mono inline-flex items-center gap-0.5", fit.sound ? TONE_TEXT_SM.ok : "text-dim")}
        title={fit.sound ? t("Makes its own sound and speech") : t("Silent — voices are added afterwards")}><Volume2 className="size-3" />{fit.sound ? "✓" : "✕"}</span>
    </span>
  );
}

/** For a model that takes characters registered with BytePlus (Seedance): whether the shot's characters are registered. */
function SeedanceCast({ characters }: { characters: Character[] }) {
  const t = useT();
  if (!characters.length) return null;
  const ready = characters.filter((c) => c.seedance_ready).length;
  if (ready === characters.length) {
    return <SeedanceBadge tip={ready > 1 ? t("Registered with BytePlus: Seedance keeps these characters' looks") : undefined} />;
  }
  const tip = ready ? t("Register the others on their character page (Video character) so Seedance keeps their look")
    : t("Register them on their character page (Video character) so Seedance keeps their look");
  return (
    <Tooltip content={tip}>
      <Badge tone="warn">{t("{n} of {m} characters registered", { n: ready, m: characters.length })}<span className="sr-only">: {tip}</span></Badge>
    </Tooltip>
  );
}

/** Seedance on BytePlus: takes characters registered in the BytePlus asset library as references. */
const takesRegistered = (e: VideoEngine | undefined) => !!e?.capabilities?.asset_refs;

export function engineFor(id: string | undefined, data: VideoEngines | undefined, quality: string): VideoEngine | undefined {
  if (!data) return undefined;
  const want = !id || id === "auto" ? data.auto_first?.[quality] : id;
  return data.engines.find((e) => e.id === want) ?? data.engines.find((e) => e.routes?.some((r) => r.id === want));
}

/** The shot's video model: Auto (team policy, Google first) or one picked by hand, with what each can use. */
export function ModelPicker({ value, data, quality, onChange, disabled, needsCharacters, characters }: {
  value: string; data?: VideoEngines; quality: string; onChange: (id: string) => void; disabled?: boolean; needsCharacters: boolean;
  /** the shot's characters: models that take registered characters (Seedance) show whether they are registered */
  characters?: Character[];
}) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [onlyPick, setOnlyChars] = useState<boolean | null>(null);
  const onlyChars = onlyPick ?? needsCharacters;  // on by default once the shot has characters
  const auto = !value || value === "auto";
  const cur = engineFor(value, data, quality);
  const isPicked = (e: VideoEngine) => !auto && (value === e.id || !!e.routes?.some((r) => r.id === value));
  const list = useMemo(() => (data?.engines ?? []).filter((e) => !onlyChars || e.fit.characters !== "none"), [data, onlyChars]);
  const pick = (id: string) => { onChange(id); setOpen(false); };
  const cast = (e: VideoEngine | undefined) => takesRegistered(e) && characters?.length ? <SeedanceCast characters={characters} /> : undefined;

  return (
    <>
      <div className="min-w-0 max-w-full">
        <button ref={ref} type="button" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg border border-line bg-raised/40 px-2 text-left text-xs transition-colors hover:border-dim/60 disabled:opacity-60 pointer-coarse:h-10">
          {auto ? <Wand2 className="size-3.5 shrink-0 text-mute" /> : <Cpu className="size-3.5 shrink-0 text-accent-ink" />}
          <span className="eyebrow shrink-0">{t("Model")}</span>
          <span className="min-w-0 flex-1 truncate font-medium">{auto ? `${t("Auto")}${cur ? ` · ${cur.display_name}` : ""}` : cur?.display_name ?? value}</span>
          <ChevronDown className="size-3.5 shrink-0 text-dim" />
        </button>
        {cur && <FitChips fit={cur.fit} className="mt-1 px-0.5" />}
      </div>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={380} className="p-2">
        <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
          <span className="text-xs font-semibold">{t("Video model for this shot")}</span>
          <Toggle checked={onlyChars} onChange={setOnlyChars} label={<span className="text-2xs">{t("Only ones that use characters")}</span>} />
        </div>
        <div className="max-h-80 space-y-0.5 overflow-y-auto" role="listbox">
          <ModelRow selected={auto} onClick={() => pick("auto")}
            title={<><b>{t("Auto")}</b>{data?.auto_first?.[quality] && <span className="text-dim"> · {engineFor("auto", data, quality)?.display_name}</span>}</>}
            sub={data?.google_first ? t("Google first; other providers only for what Google can't do") : t("Team order from Model Hub")}
            fit={engineFor("auto", data, quality)?.fit} price={engineFor("auto", data, quality)?.est_8s_usd} extra={cast(engineFor("auto", data, quality))} />
          {list.map((e) => (
            <ModelRow key={e.id} selected={isPicked(e)} onClick={() => pick(e.id)}
              title={<><span className="font-medium">{(e.routes?.length ?? 0) > 1 ? e.display_name.replace(/ \((OpenRouter|BytePlus)\)$/, "") : e.display_name}</span> <span className="rounded border border-line px-1 font-mono text-2xs text-mute">{providerName(e.provider)}</span>
                {(e.routes?.length ?? 0) > 1 && <span className="ml-1 text-2xs text-dim" title={e.routes!.map((r) => providerName(r.provider)).join(" → ")}>{t("+{n} routes", { n: e.routes!.length - 1 })}</span>}
                {e.provider_mode === "mock" && <Badge tone="warn" className="ml-1">{t("mock")}</Badge>}</>}
              sub={`${t("Characters")}: ${t(VIA_LABEL[e.fit.characters])}${e.fit.characters === "refs" ? ` (${t("up to {n}", { n: e.fit.max_refs })})` : ""}${(e.routes?.length ?? 0) > 1 ? ` · ${t("cheapest route first, then {rest}", { rest: e.routes!.slice(1).map((r) => providerName(r.provider)).join(", ") })}` : ""}`}
              fit={e.fit} price={e.est_8s_usd} warn={needsCharacters && e.fit.characters === "none"} extra={cast(e)} />
          ))}
          {data && !list.length && <p className="px-2 py-3 text-center text-xs text-dim">{t("No enabled model fits. Turn more on in Model Hub.")}</p>}
        </div>
        <p className="mt-1.5 flex items-start gap-1 px-1 text-2xs text-dim"><Info className="mt-px size-3 shrink-0" />
          {t("Prices are for an 8-second clip. A model from another provider only runs when you pick it here.")}</p>
      </Popover>
    </>
  );
}

function ModelRow({ selected, onClick, title, sub, fit, price, warn, extra }: {
  selected: boolean; onClick: () => void; title: ReactNode; sub: string; fit?: VideoFit; price?: number | null; warn?: boolean; extra?: ReactNode;
}) {
  return (
    <button type="button" role="option" aria-selected={selected} onClick={onClick}
      className={clsx("flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors", selected ? "bg-accent/10" : "hover:bg-hover")}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{title}</span>
        <span className={clsx("block text-2xs", warn ? TONE_TEXT_SM.bad : "text-dim")}>{sub}</span>
        {fit && <FitChips fit={fit} className="mt-0.5" />}
        {extra && <span className="mt-1 flex">{extra}</span>}
      </span>
      {price != null && <span className="mono shrink-0 text-xs text-money">{price > 0 ? `~${usd(price)}` : "—"}</span>}
      {selected && <Check className="mt-0.5 size-4 shrink-0 text-accent-ink" strokeWidth={3} />}
    </button>
  );
}

/** Warnings under a shot when its model can't use what the shot has (characters, location, references, dialogue). */
export function FitNotes({ engine, auto, characters, hasLocation, refCount, hasLines, alternatives, onSwitch }: {
  engine?: VideoEngine; auto: boolean; characters: Character[]; hasLocation: boolean; refCount: number; hasLines: boolean;
  alternatives: VideoEngine[]; onSwitch: (id: string) => void;
}) {
  const t = useT();
  if (!engine) return null;
  const f = engine.fit;
  const notes: { tone: "bad" | "warn" | "info"; text: string }[] = [];
  const names = characters.map((c) => c.name).join(", ");
  if (characters.length && f.characters === "none") {
    notes.push({ tone: "bad", text: t("{model} can't use character photos — {names} won't look like themselves. Pick a model that supports characters:", { model: engine.display_name, names }) });
  } else if (characters.length && f.characters === "keyframe") {
    notes.push({ tone: "info", text: t("{names}: kept through the keyframe, which is made from their photos.", { names }) });
  }
  const noPhoto = characters.filter((c) => !c.avatar_url).map((c) => c.name);
  if (noPhoto.length) notes.push({ tone: "warn", text: t("No photo or design yet for {names} — add one so the face stays the same in every shot.", { names: noPhoto.join(", ") }) });
  if (hasLocation && f.location === "none") notes.push({ tone: "warn", text: t("{model} can't use the location's images; the place is described in words only.", { model: engine.display_name }) });
  const imgs = characters.length + refCount + (hasLocation ? 1 : 0);
  if (f.characters === "refs" && imgs > f.max_refs) {
    notes.push({ tone: "info", text: t("{model} takes {n} reference images; the rest reach it through the keyframe.", { model: engine.display_name, n: f.max_refs }) });
  }
  if (hasLines && !f.sound) notes.push({ tone: "info", text: t("This model is silent: the lines are voiced afterwards and lip-synced.") });
  const seedance = takesRegistered(engine) && characters.length > 0;
  if (!notes.length && !seedance) return null;
  const fix = characters.length && f.characters === "none" ? alternatives.filter((e) => e.fit.characters !== "none").slice(0, 3) : [];
  return (
    <div className="space-y-1">
      {seedance && <div className="flex px-0.5"><SeedanceCast characters={characters} /></div>}
      {notes.map((n, i) => (
        <p key={i} className={clsx("flex items-start gap-1.5 rounded-md px-2 py-1 text-2xs",
          n.tone === "bad" ? `bg-bad/10 ${TONE_TEXT_SM.bad}` : n.tone === "warn" ? `bg-warn/10 ${TONE_TEXT_SM.warn}` : "bg-raised/60 text-mute")}>
          {n.tone === "info" ? <Images className="mt-px size-3 shrink-0" /> : <AlertTriangle className="mt-px size-3 shrink-0" />}
          <span>{n.text}</span>
        </p>
      ))}
      {fix.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pl-1">
          {!auto && <Button size="sm" variant="outline" onClick={() => onSwitch("auto")}>{t("Use Auto")}</Button>}
          {fix.map((e) => (
            <Button key={e.id} size="sm" variant="outline" onClick={() => onSwitch(e.id)}>
              {e.display_name}{e.est_8s_usd ? ` · ~${usd(e.est_8s_usd)}` : ""}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
