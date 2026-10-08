import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Rocket, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { usd } from "../lib/format";
import { tr, useT } from "../lib/i18n";
import { useAgentMessages, useAuthStatus, useEpisode } from "../lib/queries";
import { useUI } from "../lib/store";
import type { Project } from "../lib/types";
import { useProjectCtx } from "../pages/project/context";
import { Composer } from "./director/Composer";
import { Conversation } from "./director/Conversation";
import { ModeSwitch, type AgentMode } from "./director/ModeSwitch";
import type { Decision } from "./director/Proposal";
import { DirectorMark, useSuggestions } from "./director/shared";
import { DIRECTOR_MAX, DIRECTOR_MIN, useResizableWidth } from "./director/useResizable";
import { Button, IconButton } from "./ui";

/** Unsent text per project: survives closing and re-opening the panel. */
const drafts = new Map<number, string>();

/**
 * The project's AI co-pilot. ProjectLayout docks it on wide screens and floats it over the page on narrow ones;
 * this component owns its own width (drag the left edge, double-click to reset) and the whole conversation.
 */
export default function AgentPanel() {
  const t = useT();
  const suggestions = useSuggestions();
  const { project, eid, lang, canEdit } = useProjectCtx();
  const qc = useQueryClient();
  const setAgentOpen = useUI((s) => s.setAgentOpen);
  const selectedShot = useUI((s) => s.selectedShot);
  const { data: auth } = useAuthStatus();
  const { data: messages, isLoading, isError, refetch } = useAgentMessages(project.id);
  const { data: episode } = useEpisode(eid, lang);

  const [text, setText] = useState(() => drafts.get(project.id) ?? "");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<{ text: string; baseId: number } | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [busy, setBusy] = useState<Record<string, "approve" | "reject">>({});
  const [confirmBusy, setConfirmBusy] = useState<Record<string, "yes" | "no">>({});
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);

  const aside = useRef<HTMLElement>(null);
  const { width, dragging, handleProps } = useResizableWidth(aside);

  const showEmpty = !isLoading && !!messages && messages.length === 0 && !pending && !sending;
  const selectedCode = episode?.shots?.find((s) => s.id === selectedShot)?.code;
  const mode: AgentMode = project.agent_mode === "autopilot" ? "autopilot" : "copilot";
  const ap = project.autopilot || {};
  const apRunning = ap.status === "running";

  const edit = (v: string) => { setText(v); drafts.set(project.id, v); };

  const send = async (msg?: string) => {
    const m = (msg ?? text).trim();
    if (!m || sending) return;
    const baseId = messages?.[messages.length - 1]?.id ?? 0;
    edit("");
    setPending({ text: m, baseId });
    setSending(true);
    try {
      await api.post(`/api/projects/${project.id}/agent/chat`, {
        message: m, episode_id: eid, selection: selectedCode ? { shot: selectedCode, language: lang } : { language: lang },
      });
      await qc.invalidateQueries({ queryKey: ["agent", project.id] });
      qc.invalidateQueries({ queryKey: ["episode"] });
      qc.invalidateQueries({ queryKey: ["project", project.id] });
    } catch {
      // api() already showed the reason; give the text back so nothing is lost
      setText((cur) => { const next = cur || m; drafts.set(project.id, next); return next; });
    } finally {
      setSending(false);
      setPending(null);
    }
  };

  /** Answer a "this would replace your work" card. The action runs on the server (it may take a moment). */
  const answer = async (messageId: number, id: string, approve: boolean) => {
    if (confirmBusy[id]) return;
    setConfirmBusy((b) => ({ ...b, [id]: approve ? "yes" : "no" }));
    try {
      const r = await api.post<{ status: string; result?: string }>(`/api/projects/${project.id}/agent/messages/${messageId}/confirm`, { id, approve });
      if (r.status === "done") toast.success(r.result || tr("Done"));
      else if (r.status === "failed") toast.error(r.result || tr("That didn't work"));
      await qc.invalidateQueries({ queryKey: ["agent", project.id] });
      qc.invalidateQueries({ queryKey: ["episode"] });
      qc.invalidateQueries({ queryKey: ["board"] });
      qc.invalidateQueries({ queryKey: ["project", project.id] });
      qc.invalidateQueries({ queryKey: ["characters"] });
    } catch {
      /* api() already showed the reason; the card keeps its buttons */
    } finally {
      setConfirmBusy(({ [id]: _done, ...rest }) => rest);
    }
  };

  const decide = async (batch: string, kind: "approve" | "reject") => {
    if (busy[batch]) return;
    setBusy((b) => ({ ...b, [batch]: kind }));
    try {
      if (kind === "approve") {
        const r = await api.post<{ status: string; total_usd: number; reason?: string }>(`/api/batches/${batch}/confirm`);
        if (r.status === "awaiting_approval") {
          toast.warning(tr("Sent to a producer for approval"), { description: r.reason });
          setDecisions((d) => ({ ...d, [batch]: "escalated" }));
        } else {
          toast.success(tr("Approved · {usd}", { usd: usd(r.total_usd) }));
          setDecisions((d) => ({ ...d, [batch]: "approved" }));
        }
      } else {
        await api.post(`/api/batches/${batch}/cancel`);
        setDecisions((d) => ({ ...d, [batch]: "rejected" }));
      }
      await qc.invalidateQueries({ queryKey: ["agent", project.id] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch {
      /* api() already showed the reason; the card keeps its buttons */
    } finally {
      setBusy(({ [batch]: _done, ...rest }) => rest);
    }
  };

  const applyMode = async (next: AgentMode) => {
    setConfirmAuto(false);
    setModeBusy(true);
    const key = ["project", project.id];
    const before = qc.getQueryData<Project>(key);
    qc.setQueryData<Project>(key, (p) => (p ? { ...p, agent_mode: next } : p));
    try {
      const saved = await api.patch<Project>(`/api/projects/${project.id}`, { agent_mode: next });
      qc.setQueryData(key, saved);
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success(next === "autopilot" ? tr("Auto-approve is on — the Director starts paid steps within budget") : tr("Ask me first is on — the Director shows the cost and waits for your OK"));
    } catch {
      if (before) qc.setQueryData(key, before); // api() already showed the reason
    } finally {
      setModeBusy(false);
    }
  };

  const onMode = (next: AgentMode) => {
    if (next === "autopilot") setConfirmAuto(true); // spending without asking deserves one deliberate click
    else void applyMode(next);
  };

  return (
    <motion.aside
      ref={aside}
      aria-label={t("Director")}
      initial={{ x: 32, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 32, opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      style={{ "--agent-w": `${width}px` } as CSSProperties}
      className="relative flex min-h-0 w-[min(var(--agent-w),100vw)] max-w-full shrink-0 flex-col border-l border-line bg-panel max-sm:w-screen"
    >
      {/* drag handle on the left edge */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("Resize the Director panel")}
        aria-valuemin={DIRECTOR_MIN}
        aria-valuemax={DIRECTOR_MAX}
        aria-valuenow={width}
        tabIndex={0}
        {...handleProps}
        className="group absolute inset-y-0 -left-1.5 z-20 hidden w-3 cursor-col-resize touch-none select-none outline-none sm:block"
      >
        <span aria-hidden className={clsx("absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-accent transition-opacity duration-150",
          dragging ? "opacity-90" : "opacity-0 group-hover:opacity-60 group-focus-visible:opacity-90")} />
        <span aria-hidden className={clsx("absolute left-1/2 top-1/2 h-9 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-150",
          dragging ? "bg-accent" : "bg-line group-hover:bg-accent/70 group-focus-visible:bg-accent")} />
      </div>

      <header className="relative shrink-0 border-b border-line px-3 pb-2.5 pt-3">
        <div className="flex items-center gap-2.5">
          <DirectorMark size={34} square working={sending || apRunning} />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold leading-tight tracking-tight">{t("Director")}</h2>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs leading-snug text-mute">
              {apRunning ? (
                <>
                  <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-info" />
                  <span className="truncate text-info">{t("Autopilot is running: {stage}", { stage: String(ap.stage ?? "") })}</span>
                </>
              ) : ap.status === "paused" ? (
                <span className="truncate text-warn">{t("Autopilot is waiting for your review (Brief tab)")}</span>
              ) : (
                <span className="truncate">{mode === "autopilot" ? t("Starts paid steps within budget") : t("Shows the cost and waits for your OK")}</span>
              )}
            </p>
          </div>
          <IconButton title={t("Close")} tipSide="bottom" onClick={() => setAgentOpen(false)}><X className="size-4" /></IconButton>
        </div>
        <div className="mt-2.5">
          <ModeSwitch mode={mode} onChange={onMode} disabled={!canEdit || modeBusy} />
        </div>
        <AnimatePresence initial={false}>
          {confirmAuto && (
            <motion.div
              key="confirm"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setConfirmAuto(false); } }}
            >
              <div className="mt-2.5 rounded-xl border border-warn/30 bg-warn/8 p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-ink"><Rocket className="size-3.5 text-warn" />{t("Auto-approve paid steps?")}</p>
                <p className="mt-1 text-xs leading-relaxed text-mute">
                  {t("When you ask the Director for something paid, it will start right away, without waiting for your OK. It still stays inside the project budget and your team's limits.")}
                </p>
                <div className="mt-2.5 flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => void applyMode("autopilot")} autoFocus>{t("Auto-approve")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmAuto(false)}>{t("Keep asking me")}</Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      <Conversation
        messages={messages}
        loading={isLoading}
        failed={isError}
        onRetry={() => void refetch()}
        pending={pending}
        sending={sending}
        me={auth?.user}
        canEdit={canEdit}
        suggestions={suggestions}
        onPick={(order) => void send(order)}
        decisions={decisions}
        busy={busy}
        onDecide={(b, k) => void decide(b, k)}
        confirmBusy={confirmBusy}
        onConfirm={(mid, id, yes) => void answer(mid, id, yes)}
      />

      <Composer
        value={text}
        onChange={edit}
        onSend={() => void send()}
        onPick={(order) => void send(order)}
        sending={sending}
        canEdit={canEdit}
        selectedCode={selectedCode}
        suggestions={suggestions}
        chips={!showEmpty}
      />
    </motion.aside>
  );
}
