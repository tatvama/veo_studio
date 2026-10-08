import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, Languages, Sparkles, Wand2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { LANG_NAMES, LANG_SHORT } from "../../lib/format";
import { tr, useT } from "../../lib/i18n";
import type { Episode } from "../../lib/types";
import { useProjectCtx } from "../../pages/project/context";
import { Badge, Button, Progress } from "../ui";
import { PanelHead, RoomEmpty } from "./kit";

/** Translation status per language + Translate (adapt) and Native polish (a native-speaker pass over dubbed lines). */
export function LanguagesPanel({ ep }: { ep: Episode }) {
  const t = useT();
  const qc = useQueryClient();
  const { project, canEdit, lang: working } = useProjectCtx();
  const [busy, setBusy] = useState("");
  const primary = project.primary_language;
  const others = project.languages.filter((l) => l !== primary);
  const shots = (ep.shots ?? []).filter((s) => s.include);
  const withLines = shots.filter((s) => (s.dialogue?.[primary]?.length ?? 0) > 0 || !!s.narration?.[primary]);

  const status = (l: string) => {
    const done = withLines.filter((s) => (s.dialogue?.[l]?.length ?? 0) > 0 || !!s.narration?.[l]).length;
    return { done, total: withLines.length };
  };

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ["episode", ep.id] }),
    qc.invalidateQueries({ queryKey: ["shot"] }),
  ]);

  const translate = async (l: string) => {
    setBusy(`tr:${l}`);
    try {
      const r = await api.post<{ translated: number }>(`/api/episodes/${ep.id}/localize`, { language: l, overwrite: false });
      await refresh();
      toast.success(r.translated ? tr("{n} lines translated into {lang}", { n: r.translated, lang: LANG_NAMES[l] ?? l })
        : tr("{lang} is already up to date", { lang: LANG_NAMES[l] ?? l }));
    } catch { /* api toasts */ } finally { setBusy(""); }
  };

  const polish = async (l: string) => {
    setBusy(`po:${l}`);
    try {
      const r = await api.post<{ polished: number }>(`/api/episodes/${ep.id}/polish`, { language: l });
      await refresh();
      toast.success(r.polished ? tr("Native polish: {n} lines improved in {lang}", { n: r.polished, lang: LANG_NAMES[l] ?? l })
        : tr("Nothing to polish in {lang}", { lang: LANG_NAMES[l] ?? l }));
    } catch { /* api toasts */ } finally { setBusy(""); }
  };

  return (
    <div>
      <PanelHead title={t("Localization")}
        description={t("Lines are adapted per shot from {lang}. Native polish then rewrites them the way a native speaker would say them.", { lang: LANG_NAMES[primary] ?? primary })} />
      {!others.length ? (
        <RoomEmpty icon={<Languages className="size-7" />} title={t("One language so far")} sub={t("Only one language in this project. Add languages in the Brief to dub.")} />
      ) : !withLines.length ? (
        <RoomEmpty icon={<Languages className="size-7" />} title={t("Nothing to translate yet")} sub={t("Plan shots first — translation works on each shot's dialogue.")} />
      ) : (
        <ul className="space-y-2">
          {others.map((l) => {
            const st = status(l);
            const pct = st.total ? st.done / st.total : 0;
            const complete = st.total > 0 && st.done >= st.total;
            return (
              <li key={l} className={clsx("grid items-center gap-x-4 gap-y-3 rounded-xl border p-3 @2xl:grid-cols-[10rem_minmax(0,1fr)_auto]",
                l === working ? "border-accent/40 bg-accent/5" : "border-line bg-bg/40")}>
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className={clsx("grid size-9 shrink-0 place-items-center rounded-lg text-xs font-semibold", complete ? "bg-ok/15 text-green-300" : "bg-raised text-mute")}>
                    {complete ? <Check className="size-4" strokeWidth={2.75} /> : LANG_SHORT[l] ?? l.toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{LANG_NAMES[l] ?? l}</p>
                    {l === working && <Badge tone="accent" className="mt-0.5">{t("working")}</Badge>}
                  </div>
                </div>
                <div className="min-w-0">
                  <Progress value={pct} tone={complete ? "ok" : "accent"} />
                  <p className="mt-1.5 text-2xs tabular-nums text-dim">{t("{done}/{total} shots translated", { done: st.done, total: st.total })}</p>
                </div>
                {canEdit && (
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" loading={busy === `tr:${l}`} disabled={!!busy || st.done >= st.total} icon={<Wand2 className="size-3.5" />}
                      onClick={() => translate(l)}>{st.done ? t("Translate missing") : t("Translate")}</Button>
                    <Button size="sm" variant="outline" loading={busy === `po:${l}`} disabled={!!busy || !st.done} icon={<Sparkles className="size-3.5" />}
                      title={t("A native-speaker pass so lines sound natural, not translated")} onClick={() => polish(l)}>{t("Native polish")}</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
