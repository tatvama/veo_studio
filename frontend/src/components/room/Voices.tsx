import { useQueryClient } from "@tanstack/react-query";
import { AudioLines, Mic, Play, ShieldCheck, Wand2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { LANG_NAMES, LANG_SHORT } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/queries";
import type { Character, SubmitResult, VoiceProfile } from "../../lib/types";
import { useGenerate } from "../Generate";
import { Badge, Button, Input, Meter, Select, Skeleton } from "../ui";
import { AudioButton } from "./AudioButton";
import { scaleMeter } from "./cast";
import { CloneVoiceModal } from "./CloneVoice";
import { RField } from "./kit";
import { useCharScope } from "./scope";
import { useActiveJobs } from "./util";
import { WorkPanel } from "./workspace";

/** One voice per project language: pick a prebuilt voice or design one from the description, then audition it. */
export function Voices({ character, index, n }: { character: Character; index?: number; n?: number }) {
  const t = useT();
  const scope = useCharScope();
  const { canEdit, canProduce, projectId } = scope;
  // a locked character's voice can only be changed by a producer (the server refuses everyone else)
  const editable = canEdit && (!character.locked || canProduce);
  const { submit } = useGenerate();
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const voices = (character.voices || []) as VoiceProfile[];
  const defaults = settings?.settings.tts_provider_by_language || {};
  const [provider, setProvider] = useState<Record<string, string>>({});
  const [desc, setDesc] = useState(character.voice_description);
  const [cloning, setCloning] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["character", character.id] });
  const set = voices.filter((v) => typeof v === "object").length;
  const cloned = voices.some((v) => v.provider === "elevenlabs" && (v.voice_name || "").includes("cloned"));
  const designing = useActiveJobs(projectId, (j) => j.type === "voice_design" && Number(j.payload?.character_id) === character.id);

  const pickPrebuilt = async (lang: string, voiceId: string, prov: string) => {
    try {
      await api.post(`/api/characters/${character.id}/voices`, { language: lang, provider: prov, voice_id: voiceId });
      refresh();
      toast.success(tr("Voice set"));
    } catch { /* api toasts */ }
  };

  const covered = Math.min(set, scope.languages.length);
  const m = scaleMeter(covered, scope.languages.length, 8);

  return (
    <WorkPanel id="sec-voices" index={index} n={n} kicker={t("Audio")} icon={<Mic />} title={t("Voice — one locked voice per language")}
      description={t("Design a custom voice from the description, or pick a prebuilt voice. Voice Lock (keep Veo's acting, swap the voice) needs an ElevenLabs voice and works for {langs}.",
        { langs: settings?.catalog.sts_languages.map((l) => LANG_NAMES[l]).join(", ") ?? "" })}
      actions={scope.languages.length > 0 && (
        <span className="flex items-center gap-2.5">
          <Meter filled={m.filled} total={m.total} tone={covered === scope.languages.length ? "ok" : "accent"} className="w-14" />
          <span className="mono text-xs text-dim">{t("{a}/{n} languages", { a: covered, n: scope.languages.length })}</span>
        </span>
      )}>
      <div className="space-y-4">
        {editable && (
          <div className={cn("flex flex-wrap items-center gap-3 rounded-lg border p-3", cloned ? "border-ok/30 bg-ok/5" : "border-line bg-raised/40")}>
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-accent/25 bg-accent/10 text-accent-ink"><AudioLines className="size-4" /></span>
            <div className="min-w-0 flex-1 basis-60">
              <p className="text-sm font-medium">{cloned ? t("Speaking with a cloned real voice") : t("Use a real person's voice")}</p>
              <p className="text-xs text-mute">{t("Upload short recordings of the actor or speaker; ElevenLabs makes an instant clone and it becomes this character's voice. Their permission is recorded.")}</p>
            </div>
            <Button size="sm" variant={cloned ? "secondary" : "primary"} icon={<AudioLines className="size-3.5" />} disabled={!canProduce} className="max-sm:h-10"
              title={canProduce ? undefined : t("A producer or admin can clone voices")} onClick={() => setCloning(true)}>
              {cloned ? t("Re-clone") : t("Clone a real voice")}
            </Button>
          </div>
        )}
        <CloneVoiceModal open={cloning} onClose={() => setCloning(false)} character={character} languages={scope.languages} />
        <RField label={t("Voice description")} htmlFor={`vd-${character.id}`}>
          <Input id={`vd-${character.id}`} value={desc} onChange={(e) => setDesc(e.target.value)} disabled={!editable} placeholder={t("warm, deep male voice, mid-50s, calm, slight Kannada accent")} />
        </RField>

        {/* one row per project language */}
        <div>
          <div className="mb-2 flex items-center gap-2.5">
            <p className="eyebrow">{t("Languages")}</p>
            <span aria-hidden className="rm-rule h-px flex-1" />
          </div>
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {scope.languages.map((lang) => {
              const vp = voices.find((v) => v.language === lang);
              const prov = provider[lang] || vp?.provider || defaults[lang] || "gemini";
              return (
                <li key={lang} className={cn("relative px-3 py-2.5", vp ? "bg-bg/30" : "bg-bg/10")}>
                  <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", vp ? "bg-ok/70" : "bg-transparent")} />
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pl-1">
                    <div className="flex w-36 shrink-0 items-center gap-2.5">
                      <span className={cn("mono grid h-7 min-w-9 place-items-center rounded-md border px-1.5 text-xs font-semibold", vp ? "border-ok/30 bg-ok/10 text-ink" : "border-dashed border-line text-dim")}>
                        {LANG_SHORT[lang] ?? lang.toUpperCase()}
                      </span>
                      <span className="min-w-0 truncate text-sm font-medium" title={LANG_NAMES[lang]}>{LANG_NAMES[lang] ?? lang}</span>
                    </div>
                    <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
                      {vp ? (
                        <>
                          <Badge tone="ok"><ShieldCheck className="size-3" />{vp.provider}</Badge>
                          <span className="mono min-w-0 truncate text-xs font-medium" title={vp.voice_id}>{vp.voice_name || vp.voice_id}</span>
                          {vp.sample_url && <AudioButton src={vp.sample_url} label={t("Play sample")} />}
                        </>
                      ) : <span className="text-xs text-dim">{t("No voice yet — a default {provider} voice will be used", { provider: prov })}</span>}
                    </div>
                  </div>
                  {editable && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-dashed border-line pt-2.5 pl-1">
                      <Select value={prov} onChange={(e) => setProvider({ ...provider, [lang]: e.target.value })} className="h-10! w-36! text-xs! sm:h-8!" aria-label={`${LANG_NAMES[lang]}: ${t("Provider")}`}>
                        <option value="gemini">Gemini TTS</option><option value="elevenlabs">ElevenLabs</option><option value="sarvam">Sarvam</option>
                      </Select>
                      {prov === "gemini" && (!settings ? <Skeleton className="h-8 w-40" /> : (
                        <Select className="h-10! w-44! text-xs! sm:h-8!" value="" aria-label={`${LANG_NAMES[lang]}: ${t("Prebuilt voice")}`} onChange={(e) => e.target.value && pickPrebuilt(lang, e.target.value, "gemini")}>
                          <option value="">{t("Prebuilt…")}</option>
                          {settings.catalog.gemini_voices.map(([n, d]) => <option key={n} value={n}>{n} · {d}</option>)}
                        </Select>
                      ))}
                      {prov === "sarvam" && (!settings ? <Skeleton className="h-8 w-40" /> : (
                        <Select className="h-10! w-40! text-xs! sm:h-8!" value="" aria-label={`${LANG_NAMES[lang]}: ${t("Speaker")}`} onChange={(e) => e.target.value && pickPrebuilt(lang, e.target.value, "sarvam")}>
                          <option value="">{t("Speaker…")}</option>
                          {Object.entries(settings.catalog.sarvam_speakers ?? {}).flatMap(([g, l]) => l.map((s) => <option key={s} value={s}>{s} ({g})</option>))}
                        </Select>
                      ))}
                      <div className="ml-auto flex flex-wrap gap-1.5">
                        <Button size="sm" className="max-sm:h-10" icon={<Wand2 className="size-3.5" />} loading={designing.some((j) => (j.payload?.language ?? scope.primary) === lang)} onClick={async () => {
                          if (desc !== character.voice_description) {
                            try { await api.patch(`/api/characters/${character.id}`, { voice_description: desc }); } catch { return; }
                          }
                          submit(() => api.post<SubmitResult>(`/api/characters/${character.id}/voices/design`, { language: lang, provider: prov, description: desc, project_id: projectId ?? null }),
                            tr("{name} {lang} voice", { name: character.name, lang: LANG_SHORT[lang] }));
                        }}>{prov === "sarvam" ? t("Pick") : t("Design")}</Button>
                        {vp && <Button size="sm" variant="ghost" className="max-sm:h-10" title={t("Speak a sample line")} aria-label={t("Speak a sample line")} icon={<Play className="size-3.5" />}
                          onClick={() => submit(() => api.post<SubmitResult>(`/api/voices/${vp.id}/preview`, {}), tr("Voice preview"))}>{t("Sample")}</Button>}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </WorkPanel>
  );
}
