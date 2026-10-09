import { Images, Sparkles, Timer, Trophy, Volume2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import type { AIModel } from "../../lib/types";
import { Badge, StatusDot } from "../ui";
import { MODE_LABELS, durationsText, isFresh } from "./util";

const PROVIDER_NAMES: Record<string, string> = {
  fal: "fal", google: "Google", gemini: "Gemini", sync: "Sync", elevenlabs: "ElevenLabs", replicate: "Replicate", openai: "OpenAI",
  sarvam: "Sarvam", runway: "Runway", luma: "Luma", kling: "Kling", minimax: "MiniMax", bytedance: "ByteDance",
  openrouter: "OpenRouter", byteplus: "BytePlus",
};

/** Brand names aren't translated: just tidy the provider id. */
export function providerName(p: string): string {
  return PROVIDER_NAMES[p.toLowerCase()] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : "");
}

/** Where an engine runs (fal, Google …) as a mono tag with a state dot; "mock" when that provider isn't connected for real. */
export function ProviderBadge({ model, className }: { model: Pick<AIModel, "provider" | "provider_mode">; className?: string }) {
  const t = useT();
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className="mono inline-flex items-center gap-1.5 rounded-md border border-line bg-raised/60 px-1.5 py-0.5 text-2xs uppercase leading-none tracking-wider text-mute"
        title={t("Runs on {provider}", { provider: providerName(model.provider) })}>
        <StatusDot tone={model.provider_mode === "live" ? "ok" : model.provider_mode === "mock" ? "warn" : "bad"} />
        {providerName(model.provider)}
      </span>
      {model.provider_mode === "mock" && <Badge tone="warn" title={t("Provider is in mock mode — no real generation")} className="mono uppercase tracking-wider">{t("mock")}</Badge>}
    </span>
  );
}

/** "New" marker for recently added catalog entries. */
export function NewTag({ model }: { model: Pick<AIModel, "first_seen" | "builtin" | "status"> }) {
  const t = useT();
  if (!isFresh(model)) return null;
  return <Badge tone="accent" title={t("Recently added to the catalog")} className="mono uppercase tracking-wider"><Sparkles className="size-3" />{t("new")}</Badge>;
}

/** What an engine can do, in the order people pick on: sound, references, length, input modes, track record. */
export function CapChips({ model, maxModes = 3, className }: { model: AIModel; maxModes?: number; className?: string }) {
  const t = useT();
  const cap = model.capabilities ?? {};
  const modes = cap.modes ?? [];
  const dur = durationsText(cap.durations);
  return (
    <span className={cn("mono inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-mute", className)}>
      {cap.native_audio && <span className="inline-flex items-center gap-0.5 text-accent-ink" title={t("Generates its own sound")}><Volume2 className="size-3.5" />{t("audio")}</span>}
      {(cap.max_refs ?? 0) > 0 && (
        <span className="inline-flex items-center gap-0.5" title={t("Uses up to {n} reference images", { n: cap.max_refs ?? 0 })}><Images className="size-3.5" />{cap.max_refs}</span>
      )}
      {dur && <span className="inline-flex items-center gap-0.5" title={t("Clip length")}><Timer className="size-3.5" />{dur}</span>}
      {model.wins > 0 && <span className="inline-flex items-center gap-0.5 text-accent-ink" title={t("{n} wins", { n: model.wins })}><Trophy className="size-3.5" />{model.wins}</span>}
      {modes.slice(0, maxModes).map((m) => (
        <span key={m} title={t(MODE_LABELS[m] ?? m)} className="rounded-md border border-line bg-raised/60 px-1.5 py-0.5 leading-none text-dim">{m}</span>
      ))}
    </span>
  );
}
