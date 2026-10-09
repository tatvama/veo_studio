import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Check, Copy, MessageSquare, RotateCcw, Scissors, Send, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar, Button, IconButton, SkeletonText, Textarea } from "../../../components/ui";
import { api } from "../../../lib/api";
import { ago } from "../../../lib/format";
import { tr, useT } from "../../../lib/i18n";
import { useComments } from "../../../lib/queries";
import { useProjectCtx } from "../context";

function PromptBlock({ title, text, refsLabel, refs, empty }: { title: string; text: string; refsLabel: string; refs: string[]; empty: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(tr("Copied"), { id: "copied" });
      window.setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked */ }
  };
  return (
    <section className="hud relative overflow-hidden rounded-xl border border-line bg-panel/70">
      <header className="flex items-center gap-2 px-3 py-2">
        <h4 className="eyebrow flex-1 !text-ink">{title}</h4>
        <span className="mono text-2xs tabular-nums text-dim">{t("{n} characters", { n: text.length.toLocaleString() })}</span>
        <IconButton title={copied ? t("Copied") : t("Copy prompt")} onClick={copy} className="!size-7">
          {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
        </IconButton>
      </header>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-line/70 bg-bg/60 p-3 font-mono text-xs leading-relaxed text-mute selection:bg-accent/30">{text}</pre>
      <p className="border-t border-line/70 px-3 py-2 text-2xs text-dim">
        {refsLabel}: {refs.length ? <span className="text-mute">{refs.join(" · ")}</span> : empty}
      </p>
    </section>
  );
}

export function PromptView({ shotId, lang }: { shotId: number; lang: string }) {
  const t = useT();
  const { data } = useQuery({
    queryKey: ["shot-prompt", shotId, lang],
    queryFn: () => api.get<{ video_prompt: string; keyframe_prompt: string; video_refs: string[]; keyframe_refs: string[] }>(`/api/shots/${shotId}/prompt?lang=${lang}`),
  });
  if (!data) return <div className="space-y-4"><SkeletonText lines={2} /><div className="skeleton h-40 rounded-xl" /><div className="skeleton h-32 rounded-xl" /></div>;
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 rounded-lg border border-accent/20 bg-accent/8 px-3 py-2 text-xs leading-relaxed text-mute">
        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent-ink" />
        {t("Compiled automatically from the Bible + this shot. Character DNA is pasted word for word so faces don't drift.")}
      </p>
      <PromptBlock title={t("Video prompt")} text={data.video_prompt} refsLabel={t("Reference images (Balanced/Hero)")} refs={data.video_refs} empty={t("none yet — generate the character sheet")} />
      <PromptBlock title={t("Keyframe prompt")} text={data.keyframe_prompt} refsLabel={t("References")} refs={data.keyframe_refs} empty={t("none")} />
    </div>
  );
}

export function Comments({ projectId, shotId, targetType = "shot" }: { projectId: number; shotId: number; targetType?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { canReview } = useProjectCtx();
  const { data } = useComments(projectId, targetType, shotId);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (!body.trim() || sending) return;
    setSending(true);
    try {
      await api.post("/api/comments", { project_id: projectId, target_type: targetType, target_id: shotId, body });
      setBody("");
      qc.invalidateQueries({ queryKey: ["comments", projectId] });
      toast.success(tr("Comment posted"));
    } catch { /* api() showed the error */ } finally { setSending(false); }
  };
  const resolve = async (id: number, resolved: boolean) => {
    try {
      await api.post(`/api/comments/${id}/resolve`);
      qc.invalidateQueries({ queryKey: ["comments", projectId] });
      toast.success(resolved ? tr("Comment reopened") : tr("Comment resolved"));
    } catch { /* api() showed the error */ }
  };
  return (
    <div className="space-y-3">
      {!data?.length && (
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-line px-4 py-5">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-raised text-mute"><MessageSquare className="size-4" /></span>
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("No comments yet")}</p>
            <p className="text-xs text-mute">{t("No comments. Use @name to notify a teammate.")}</p>
          </div>
        </div>
      )}
      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {data?.map((c) => (
            <motion.li key={c.id} layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
              className={clsx("flex gap-2.5 rounded-xl border p-3 text-sm", c.resolved ? "border-line/60 opacity-60" : "border-line bg-raised/50")}>
              <Avatar name={c.user?.name ?? "?"} size={28} />
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-center gap-2 text-xs">
                  <span className="font-semibold">{c.user?.name}</span>
                  <span className="mono text-2xs text-dim">{ago(c.created_at)}</span>
                  {c.resolved && <span className="inline-flex items-center gap-0.5 text-2xs text-ok"><Check className="size-3" />{t("Resolved")}</span>}
                  <div className="flex-1" />
                  {canReview && (
                    <button type="button" className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium text-mute transition-colors hover:bg-hover hover:text-ink" onClick={() => resolve(c.id, c.resolved)}>
                      {c.resolved ? <RotateCcw className="size-3" /> : <Check className="size-3" />}{c.resolved ? t("Reopen") : t("Resolve")}
                    </button>
                  )}
                </div>
                <p className="whitespace-pre-wrap break-words leading-relaxed">{c.body}</p>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {canReview && (
        <div className="flex items-end gap-2">
          <Textarea value={body} rows={2} onChange={(e) => setBody(e.target.value)} placeholder={t("Comment… (@Priya please check lip-sync)")} aria-label={t("Comment")}
            className="!min-h-[44px] flex-1 resize-none"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <Button variant="primary" onClick={send} loading={sending} disabled={!body.trim()} icon={<Send className="size-4" />} aria-label={t("Send comment")} className="!h-[44px] !w-11 !px-0" />
        </div>
      )}
      <p className="flex items-center gap-1 text-2xs text-dim"><Scissors className="size-3" />{t("Comments stay with the shot across all takes.")}</p>
    </div>
  );
}
