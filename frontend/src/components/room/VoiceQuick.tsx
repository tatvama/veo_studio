import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Wand2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { quote, useQuote } from "../../lib/estimates";
import { LANG_NAMES, LANG_SHORT } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import type { Character, SubmitResult, VoiceProfile } from "../../lib/types";
import { useGenerate } from "../Generate";
import { PriceSuffix } from "../kit/Price";
import { Button } from "../ui";
import { AudioButton } from "./AudioButton";
import { useCharScope } from "./scope";
import { useActiveJobs } from "./util";
import { Voices } from "./Voices";
import { PanelChromeProvider } from "./workspace";

/**
 * The voice at a glance, one row per project language: the voice, play its sample, and "Design voice · price". The full
 * choice (prebuilt voices, providers, a cloned real voice) folds open under "More voice choices".
 */
export function VoiceQuick({ character }: { character: Character }) {
  const t = useT();
  const scope = useCharScope();
  const [more, setMore] = useState(false);
  const voices = ((character.voices ?? []) as VoiceProfile[]).filter((v) => typeof v === "object" && v.language);
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {scope.languages.map((lang) => <VoiceRow key={lang} character={character} lang={lang} vp={voices.find((v) => v.language === lang)} />)}
      </ul>
      <button type="button" aria-expanded={more} onClick={() => setMore((m) => !m)}
        className="inline-flex h-8 items-center gap-1 rounded-md text-xs font-medium text-mute transition-colors hover:text-ink max-sm:h-10">
        {t("More voice choices")}<ChevronDown aria-hidden className={cn("size-3.5 transition-transform", more && "rotate-180")} />
      </button>
      {more && <PanelChromeProvider chrome="bare"><Voices character={character} /></PanelChromeProvider>}
    </div>
  );
}

function VoiceRow({ character, lang, vp }: { character: Character; lang: string; vp?: VoiceProfile }) {
  const t = useT();
  const qc = useQueryClient();
  const scope = useCharScope();
  const { priced } = useGenerate();
  const { data: settings } = useSettings();
  const editable = scope.canEdit && (!character.locked || scope.canProduce);
  const provider = vp?.provider || settings?.settings.tts_provider_by_language?.[lang] || "gemini";
  const body = { language: lang, provider, description: character.voice_description, project_id: scope.projectId ?? null };
  const { data: est } = useQuote(editable ? { action: "voice_design", character_id: character.id, ...body } : null);
  const designing = useActiveJobs(scope.projectId, (j) => j.type === "voice_design" && Number(j.payload?.character_id) === character.id
    && (j.payload?.language ?? scope.primary) === lang);
  const [busy, setBusy] = useState(false);

  const design = async () => {
    setBusy(true);
    try {
      await priced({
        quote: () => quote({ action: "voice_design", character_id: character.id, ...body }),
        run: () => api.post<SubmitResult>(`/api/characters/${character.id}/voices/design`, body),
        what: tr("{name} {lang} voice", { name: character.name, lang: LANG_SHORT[lang] ?? lang }),
      });
      qc.invalidateQueries({ queryKey: ["character", character.id] });
    } finally { setBusy(false); }
  };
  const sample = () => vp && void priced({ quote: () => quote({ action: "voice_preview", voice_id: vp.id }),
    run: () => api.post<SubmitResult>(`/api/voices/${vp.id}/preview`, {}), what: tr("Voice preview") });

  return (
    <li className={cn("rounded-lg border p-2.5", vp ? "border-line bg-bg/30" : "border-dashed border-line")}>
      <div className="flex items-center gap-2.5">
        <span className={cn("mono grid h-7 min-w-9 shrink-0 place-items-center rounded-md border px-1.5 text-xs font-semibold",
          vp ? "border-ok/30 bg-ok/10 text-ink" : "border-dashed border-line text-dim")} title={LANG_NAMES[lang] ?? lang}>{LANG_SHORT[lang] ?? lang.toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={vp ? vp.voice_name || vp.voice_id : undefined}>{vp ? vp.voice_name || vp.voice_id : t("No voice yet")}</p>
          <p className="truncate text-2xs text-dim">{vp ? vp.provider : t("A default voice is used until you design one")}</p>
        </div>
        {vp?.sample_url ? <AudioButton src={vp.sample_url} size={32} label={t("Play the sample")} />
          : vp && editable ? <Button size="sm" variant="ghost" className="max-sm:h-10" onClick={sample}>{t("Hear it")}</Button> : null}
      </div>
      {editable && (
        <Button size="sm" variant="secondary" className="mt-2 w-full max-sm:h-10" icon={<Wand2 className="size-3.5" />}
          loading={busy || designing.length > 0} onClick={() => void design()}>
          {vp ? t("Design a new voice") : t("Design voice")}<PriceSuffix usd={est?.total_usd} />
        </Button>
      )}
    </li>
  );
}
