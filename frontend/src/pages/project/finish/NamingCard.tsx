import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FileType, RotateCcw, Save, Wand } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SectionCard } from "../../../components/room/kit";
import { Badge, Button, Input, Skeleton, Tooltip } from "../../../components/ui";
import { dcall, useDesktopQuery, useDesktopSettings } from "../../../lib/desktop";
import { useT } from "../../../lib/i18n";
import { Quiet, Sub } from "./parts";

/** docs/DESKTOP.md §3.1 (the app's own defaults win when it reports them). */
export const DEFAULT_TEMPLATES: Record<string, string> = {
  Takes: "{project}_S{season:02}E{episode:02}_{cut:03}_SC{scene:02}_SH{shot:03}_{kind}{_lang}_T{take:02}",
  Audio: "{project}_S{season:02}E{episode:02}_{cut:03}_SH{shot:03}_{kind}{_lang}_T{take:02}",
  Music: "{project}_S{season:02}E{episode:02}_music_{seq:02}",
  Renders: "{project}_S{season:02}E{episode:02}_{lang}_{preset}_v{version:03}",
  Captions: "{project}_S{season:02}E{episode:02}_{lang}_v{version:03}",
  Bible: "{project}_{kind}_{label}_{seq:02}",
  Imports: "IMP_{seq:04}_{label}",
};
const FALLBACK_TOKENS = ["project", "season", "episode", "scene", "shot", "cut", "code", "kind", "lang", "take", "version", "preset", "date", "seq", "id", "label"]
  .map((token) => ({ token: `{${token}}`, help: "" }));
const PREVIEW_SHOWN = 60;

/** Series file names: a template per folder, the tokens, and the rename plan they produce for this project. */
export function NamingCard({ pid, className }: { pid: number; className?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const saved = useDesktopQuery(["naming"], (d) => d.naming.get());
  const tokens = useDesktopQuery(["naming-tokens"], (d) => d.naming.tokens(), { staleTime: Infinity });
  const preview = useDesktopQuery(["naming-preview", pid], (d) => d.naming.preview(pid));
  const { data: settings } = useDesktopSettings();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const focused = useRef<{ key: string; el: HTMLInputElement } | null>(null);

  const base = useMemo(() => ({ ...DEFAULT_TEMPLATES, ...(saved.data ?? {}) }), [saved.data]);
  useEffect(() => { if (saved.data) setDraft(base); }, [saved.data]);
  const dirty = Object.keys(base).some((k) => (draft[k] ?? base[k]) !== base[k]);
  const plan = preview.data ?? [];
  const changes = plan.filter((p) => p.from !== p.to);

  const insert = (token: string) => {
    const f = focused.current;
    if (!f) { toast.message(t("Click into a template first, then pick a token")); return; }
    const el = f.el;
    const v = draft[f.key] ?? "";
    const a = el.selectionStart ?? v.length, b = el.selectionEnd ?? v.length;
    const next = v.slice(0, a) + token + v.slice(b);
    setDraft((d) => ({ ...d, [f.key]: next }));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + token.length, a + token.length); });
  };
  const save = async () => {
    setBusy("save");
    const ok = await dcall(t("File names"), (d) => d.naming.set(draft).then(() => true));
    setBusy(null);
    if (ok) {
      toast.success(t("Templates saved"));
      qc.invalidateQueries({ queryKey: ["desktop", "naming"] });
      qc.invalidateQueries({ queryKey: ["desktop", "naming-preview", pid] });
    }
  };
  const rename = async () => {
    setBusy("rename");
    const ok = await dcall(t("Rename"), (d) => d.sync.start(pid, { scope: settings?.pullScope ?? "approved" }).then(() => true));
    setBusy(null);
    if (ok) toast.success(t("Renaming in series — the folder follows the cut"));
    qc.invalidateQueries({ queryKey: ["desktop", "naming-preview", pid] });
  };
  const tokenList = tokens.data?.length ? tokens.data : FALLBACK_TOKENS;

  return (
    <SectionCard className={className} icon={<FileType />} title={t("File names")}
      description={t("Every file is named from a template, so the folder lists in cut order. Reorder shots or re-pick a take and the names follow.")}>
      <div className="space-y-4">
        <Sub title={t("Templates")} actions={<>
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setDraft({ ...base, ...DEFAULT_TEMPLATES })}>{t("Defaults")}</Button>
          <Button size="sm" variant={dirty ? "primary" : "outline"} disabled={!dirty} loading={busy === "save"} icon={<Save className="size-3.5" />} onClick={save}>{t("Save")}</Button>
        </>}>
          {saved.isLoading ? <Skeleton className="h-40" /> : (
            <div className="space-y-1.5">
              {Object.keys(base).map((k) => (
                <label key={k} className="flex items-center gap-2">
                  <span className="w-16 shrink-0 text-xs text-mute">{t(k)}</span>
                  <Input value={draft[k] ?? base[k]} spellCheck={false} aria-label={t("{folder} template", { folder: t(k) })}
                    onFocus={(e) => { focused.current = { key: k, el: e.currentTarget }; }}
                    onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} className="mono !h-8 min-w-0 flex-1 text-xs" />
                </label>
              ))}
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap gap-1">
            {tokenList.map((tk) => (
              <Tooltip key={tk.token} content={tk.help || t("Insert {token}", { token: tk.token })}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(tk.token)}
                  className="mono rounded-md border border-line bg-raised px-1.5 py-0.5 text-2xs text-mute transition-colors hover:border-accent/40 hover:text-ink">{tk.token}</button>
              </Tooltip>
            ))}
          </div>
          <p className="mt-2 text-2xs leading-relaxed text-dim">{t("{name:03} pads to 3 digits. {_lang} adds an underscore only when there is a language. Names are made safe for Windows.")}</p>
        </Sub>

        <Sub title={t("Rename plan")} actions={<>
          {plan.length > 0 && <Badge tone={changes.length ? "warn" : "ok"}>{changes.length ? t("{n} to rename", { n: changes.length }) : t("All in series")}</Badge>}
          <Button size="sm" variant="primary" icon={<Wand className="size-3.5" />} loading={busy === "rename"} disabled={dirty} onClick={rename}>{t("Rename now")}</Button>
        </>}>
          {dirty && <p className="mb-2 text-2xs text-warn">{t("Save the templates to preview and apply them.")}</p>}
          {preview.isLoading ? <Skeleton className="h-28" /> : !plan.length ? (
            <Quiet>{t("Nothing synced yet, so nothing to name. Sync the folder first.")}</Quiet>
          ) : (
            <>
              <ul className="max-h-72 divide-y divide-line/60 overflow-y-auto rounded-lg border border-line">
                {(all ? plan : (changes.length ? changes : plan).slice(0, PREVIEW_SHOWN)).map((p, i) => (
                  <li key={`${p.from}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-2.5 py-1.5">
                    <span className="mono truncate text-2xs text-dim" title={p.from}>{p.from}</span>
                    <ArrowRight className={p.from === p.to ? "size-3 text-line" : "size-3 text-accent-ink"} />
                    <span className={p.from === p.to ? "mono truncate text-2xs text-mute" : "mono truncate text-2xs text-ink"} title={p.to}>{p.to}</span>
                  </li>
                ))}
              </ul>
              {plan.length > PREVIEW_SHOWN && (
                <button type="button" onClick={() => setAll((a) => !a)} className="mt-2 text-xs font-medium text-accent-ink hover:underline">
                  {all ? t("Show fewer") : t("Show all {n}", { n: plan.length })}
                </button>
              )}
            </>
          )}
        </Sub>
      </div>
    </SectionCard>
  );
}
