import { clsx } from "clsx";
import { AlertTriangle, CheckCircle2, CircleDashed, RotateCcw, ScanFace, ShieldCheck, Speech, XCircle } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { Take } from "../../lib/types";
import { Badge, Meter } from "../ui";
import { engineShort } from "./util";

import "../../styles/console.css";

/** One line of the QC checklist: a boolean check, a scored check, or an unknown. */
export interface QcCheck {
  key: string;
  /** English i18n key. */
  label: string;
  /** true = pass, false = fail, null = not measured. */
  ok: boolean | null;
  score?: number;
  thr?: number;
}

export interface QcSummary {
  checked: boolean; passed: boolean | undefined; face: number | null; faceThr: number; faceSeen: number | null;
  ident: number | null; identThr: number; lip: number | null; lipThr: number; retakes: number; issues: string[];
  notes: string; lipNotes: string; moments: string[]; checks: QcCheck[];
}

/** Normalise a take's QC report (v1: identity_match/passed/notes; v2 adds face, lipsync, thresholds). */
export function qcSummary(take: Take | null | undefined): QcSummary {
  const qc = (take?.qc ?? {}) as Record<string, any>;
  const face = qc.face?.available && qc.face?.similarity != null ? Number(qc.face.similarity) : null;
  const lipRep = qc.lipsync as Record<string, any> | undefined;
  const issues: string[] = [];
  if (qc.extra_people) issues.push("Extra people in frame");
  if (qc.text_artifacts) issues.push("Garbled text in frame");
  if (qc.hand_issues) issues.push("Hand problems");
  if (qc.matches_action === false) issues.push("Action doesn't match the shot");
  if (qc.outfit_match === false) issues.push("Outfit doesn't match");
  if (lipRep?.artifacts) issues.push("Mouth artifacts");
  if (lipRep && lipRep.face_visible === false) issues.push("Face not visible for lip-sync");
  const ident = qc.identity_match != null ? Number(qc.identity_match) : null;
  const identThr = Number(qc.threshold ?? 0.7);
  const faceThr = Number(qc.face_threshold ?? 0.36);
  const lip = lipRep?.sync_score != null ? Number(lipRep.sync_score) : null;
  const lipThr = Number(qc.lipsync_threshold ?? 0.6);

  // checklist rows, in the order a reviewer scans them
  const checks: QcCheck[] = [];
  if (face != null) checks.push({ key: "face", label: "Face match", ok: face >= faceThr, score: face, thr: faceThr });
  if (ident != null) checks.push({ key: "ident", label: "Identity", ok: ident >= identThr, score: ident, thr: identThr });
  if (lip != null) checks.push({ key: "lip", label: "Lip-sync", ok: lip >= lipThr, score: lip, thr: lipThr });
  if (qc.outfit_match !== undefined) checks.push({ key: "outfit", label: "Outfit", ok: qc.outfit_match !== false });
  if (qc.matches_action !== undefined) checks.push({ key: "action", label: "Matches the action", ok: qc.matches_action !== false });
  if (qc.extra_people !== undefined) checks.push({ key: "people", label: "No extra people", ok: !qc.extra_people });
  if (qc.hand_issues !== undefined) checks.push({ key: "hands", label: "Hands", ok: !qc.hand_issues });
  if (qc.text_artifacts !== undefined) checks.push({ key: "text", label: "No garbled text", ok: !qc.text_artifacts });
  if (lipRep?.artifacts !== undefined) checks.push({ key: "mouth", label: "Mouth", ok: !lipRep.artifacts });

  return {
    checked: qc.passed !== undefined || !!qc.checked_at,
    passed: qc.passed,
    face,
    faceThr,
    faceSeen: qc.face?.faces_seen ?? null,
    ident,
    identThr,
    lip,
    lipThr,
    retakes: Number(take?.params?.retake_count || 0),
    issues,
    notes: String(qc.notes || ""),
    lipNotes: String(lipRep?.notes || ""),
    moments: Array.isArray(lipRep?.mismatched_moments) ? lipRep!.mismatched_moments : [],
    checks,
  };
}

/** Compact QC badges: overall, face-match / identity, lip-sync score, auto-retake count. */
export function QcBadges({ take, lipTake, overall = true, className }: {
  take: Take | null | undefined; lipTake?: Take | null; overall?: boolean; className?: string;
}) {
  const t = useT();
  const q = qcSummary(take);
  const lq = lipTake && lipTake !== take ? qcSummary(lipTake) : null;
  const lip = lq?.lip ?? q.lip;
  const lipThr = lq?.lip != null ? lq.lipThr : q.lipThr;
  const retakes = Math.max(q.retakes, lq?.retakes ?? 0);
  if (!q.checked && lip == null && !retakes) return null;
  const passed = lq?.checked ? q.passed !== false && lq.passed !== false : q.passed;
  return (
    <span className={clsx("inline-flex flex-wrap items-center gap-1", className)}>
      {overall && q.checked && passed !== undefined && (
        <Badge tone={passed ? "ok" : "bad"} className="mono" title={[q.notes, ...q.issues.map((i) => t(i))].filter(Boolean).join(" · ") || t("Quality check")}>
          {passed ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}{t("QC")}
        </Badge>
      )}
      {q.face != null ? (
        <Badge tone={q.face >= q.faceThr ? "ok" : "bad"} className="mono" title={t("Face match {v} (pass ≥ {thr})", { v: q.face.toFixed(2), thr: q.faceThr.toFixed(2) })}>
          <ScanFace className="size-3" />{q.face.toFixed(2)}
        </Badge>
      ) : q.ident != null ? (
        <Badge tone={q.ident >= q.identThr ? "ok" : "bad"} className="mono" title={t("Identity match {v} (pass ≥ {thr})", { v: q.ident.toFixed(2), thr: q.identThr.toFixed(2) })}>
          <ScanFace className="size-3" />{q.ident.toFixed(2)}
        </Badge>
      ) : null}
      {lip != null && (
        <Badge tone={lip >= lipThr ? "ok" : "bad"} className="mono" title={t("Lip-sync score {v} (pass ≥ {thr})", { v: lip.toFixed(2), thr: lipThr.toFixed(2) })}>
          <Speech className="size-3" />{lip.toFixed(2)}
        </Badge>
      )}
      {retakes > 0 && (
        <Badge tone="warn" className="mono" title={t("{n} automatic retake(s) after failed QC", { n: retakes })}>
          <RotateCcw className="size-3" />{retakes}
        </Badge>
      )}
    </span>
  );
}

/**
 * One chip for a storyboard card: shield + the headline score (face match, else identity), red when QC failed,
 * plus the number of automatic retakes. The tooltip carries the detail.
 */
export function QcMini({ take, lipTake, threshold = 0.7, className }: {
  take: Take | null | undefined; lipTake?: Take | null; threshold?: number; className?: string;
}) {
  const t = useT();
  const q = qcSummary(take);
  const lq = lipTake && lipTake !== take ? qcSummary(lipTake) : null;
  const retakes = Math.max(q.retakes, lq?.retakes ?? 0);
  const lip = lq?.lip ?? q.lip;
  if (!q.checked && lip == null && !retakes) return null;
  const score = q.face ?? q.ident;
  const failed = take?.qc?.passed === false || lipTake?.qc?.passed === false
    || (q.passed === undefined && score != null && score < (q.face != null ? q.faceThr : threshold));
  const tip = [
    score != null ? (q.face != null ? t("Face match {v} (pass ≥ {thr})", { v: score.toFixed(2), thr: q.faceThr.toFixed(2) }) : t("Identity match {v} (pass ≥ {thr})", { v: score.toFixed(2), thr: q.identThr.toFixed(2) })) : "",
    lip != null ? t("Lip-sync score {v} (pass ≥ {thr})", { v: lip.toFixed(2), thr: (lq?.lip != null ? lq.lipThr : q.lipThr).toFixed(2) }) : "",
    retakes > 0 ? t("{n} automatic retake(s) after failed QC", { n: retakes }) : "",
    q.notes,
    ...q.issues.map((i) => t(i)),
  ].filter(Boolean).join(" · ") || t("Quality check");
  return (
    <span title={tip} className={clsx(
      "mono inline-flex h-[18px] items-center gap-0.5 rounded-md border px-1 text-2xs font-medium",
      failed ? "border-bad/30 bg-bad/12 text-bad" : "border-ok/30 bg-ok/12 text-ok", className)}>
      {failed ? <XCircle className="size-3" /> : <ShieldCheck className="size-3" />}
      {score != null ? score.toFixed(2) : t("QC")}
      {retakes > 0 && <span className="inline-flex items-center gap-0.5 text-warn"><RotateCcw className="size-3" />{retakes}</span>}
    </span>
  );
}

/** A score from 0 to 1 against its pass mark: a bar that fills, with a tick at the threshold. */
function ScoreBar({ label, value, thr }: { label: string; value: number; thr: number }) {
  const ok = value >= thr;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-2xs">
        <span className="eyebrow min-w-0 flex-1 truncate" title={label}>{label}</span>
        <span className={clsx("mono shrink-0 whitespace-nowrap font-medium", ok ? "text-ok" : "text-bad")}>{value.toFixed(2)}<span className="text-dim"> / {thr.toFixed(2)}</span></span>
      </div>
      <div className="relative h-1.5 rounded-full bg-line">
        <div className={clsx("h-full rounded-full transition-[width] duration-500", ok ? "bg-ok" : "bg-bad")} style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
        <div aria-hidden className="absolute -inset-y-0.5 w-px bg-ink/70" style={{ left: `${Math.min(100, thr * 100)}%` }} />
      </div>
    </div>
  );
}

/**
 * Small QC checklist with scores: a pass / fail mark per check, the score where there is one and the pass mark in the
 * tooltip. Used beside the viewer in the shot drawer.
 */
export function QcChecklist({ take, lipTake, className, compact }: { take: Take | null | undefined; lipTake?: Take | null; className?: string; compact?: boolean }) {
  const t = useT();
  const q = qcSummary(take);
  const lq = lipTake && lipTake !== take ? qcSummary(lipTake) : null;
  if (!take && !lipTake) return null;
  // the lip-sync score lives on the lip-sync take: fold it into the same list
  const checks = [...q.checks];
  if (lq?.lip != null && q.lip == null) checks.push({ key: "lip", label: "Lip-sync", ok: lq.lip >= lq.lipThr, score: lq.lip, thr: lq.lipThr });
  if (!q.checked && !checks.length) {
    return (
      <p className={clsx("flex items-center gap-1.5 text-2xs text-dim", className)}>
        <CircleDashed className="size-3.5" />{t("Not checked yet.")}
      </p>
    );
  }
  const passed = lq?.checked ? q.passed !== false && lq.passed !== false : q.passed;
  const fails = checks.filter((c) => c.ok === false).length;
  const retakes = Math.max(q.retakes, lq?.retakes ?? 0);
  return (
    <div className={clsx("cx-block", className)} data-tone={passed === false || fails ? "bad" : undefined}>
      <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-1.5">
        {passed === false || fails ? <XCircle className="size-3.5 text-bad" /> : <ShieldCheck className="size-3.5 text-ok" />}
        <p className="text-xs font-medium">{passed === false || fails ? t("QC needs attention") : t("QC passed")}</p>
        {retakes > 0 && (
          <span className="mono ml-auto inline-flex items-center gap-0.5 text-2xs text-warn" title={t("{n} automatic retake(s) after failed QC", { n: retakes })}>
            <RotateCcw className="size-3" />{retakes}
          </span>
        )}
      </div>
      <ul className={clsx("px-2.5 py-1.5", compact ? "space-y-0.5" : "space-y-1")}>
        {checks.map((c) => (
          <li key={c.key} className="flex items-center gap-2 text-2xs"
            title={c.score != null && c.thr != null ? t("{label}: {v} (pass ≥ {thr})", { label: t(c.label), v: c.score.toFixed(2), thr: c.thr.toFixed(2) }) : undefined}>
            {c.ok === null ? <CircleDashed className="size-3.5 shrink-0 text-dim" />
              : c.ok ? <CheckCircle2 className="size-3.5 shrink-0 text-ok" /> : <XCircle className="size-3.5 shrink-0 text-bad" />}
            <span className={clsx("min-w-0 flex-1 truncate", c.ok === false ? "text-ink" : "text-mute")}>{t(c.label)}</span>
            {c.score != null && <Meter filled={Math.max(0, Math.min(10, Math.round(c.score * 10)))} total={10} tone={c.ok ? "ok" : "bad"} className="w-12 shrink-0" />}
            {c.score != null && <span className={clsx("mono w-9 shrink-0 text-right font-medium", c.ok ? "text-ok" : "text-bad")}>{c.score.toFixed(2)}</span>}
          </li>
        ))}
        {!checks.length && <li className="text-2xs text-dim">{t("No detailed scores were recorded.")}</li>}
      </ul>
      {q.notes && <p className="border-t border-line px-2.5 py-1.5 text-2xs leading-snug text-mute">{q.notes}</p>}
    </div>
  );
}

/** Full QC report for one take: scores vs thresholds, issues, notes, retakes and engine fallbacks. */
export function QcDetails({ take }: { take: Take }) {
  const t = useT();
  const q = qcSummary(take);
  const attempts = (Array.isArray(take.params?.attempts) ? take.params.attempts : []) as { engine?: string; mode?: string; error?: string }[];
  if (!q.checked && !attempts.length && !q.retakes) return <p className="text-2xs text-dim">{t("Not checked yet.")}</p>;
  return (
    <div className="cx-block space-y-2 p-2.5 text-2xs">
      {q.checked && (
        <div className="grid gap-2 sm:grid-cols-2">
          {q.face != null && <ScoreBar label={t("Face match")} value={q.face} thr={q.faceThr} />}
          {q.ident != null && <ScoreBar label={t("Identity (vision check)")} value={q.ident} thr={q.identThr} />}
          {q.lip != null && <ScoreBar label={t("Lip-sync")} value={q.lip} thr={q.lipThr} />}
        </div>
      )}
      {q.face == null && q.faceSeen === 0 && <p className="text-dim">{t("No face detected in sampled frames.")}</p>}
      {q.issues.length > 0 && (
        <ul className="space-y-0.5">
          {q.issues.map((i) => <li key={i} className="flex items-center gap-1.5 text-warn"><AlertTriangle className="size-3 shrink-0" />{t(i)}</li>)}
        </ul>
      )}
      {q.notes && <p className="text-mute">{q.notes}</p>}
      {q.lipNotes && <p className="text-mute">{t("Lip-sync")}: {q.lipNotes}</p>}
      {q.moments.length > 0 && <p className="text-mute">{t("Off moments")}: {q.moments.join(" · ")}</p>}
      {q.retakes > 0 && <p className="flex items-center gap-1.5 text-warn"><RotateCcw className="size-3" />{t("Auto-retake #{n} — an earlier take failed QC", { n: q.retakes })}</p>}
      {attempts.length > 0 && (
        <div className="space-y-0.5 border-t border-line pt-1.5">
          <p className="text-dim">{t("Engines that failed before this one")}:</p>
          {attempts.map((a, i) => (
            <p key={i} className="truncate text-dim" title={a.error}>
              <span className="text-mute">{engineShort(a.engine)}</span>{a.mode ? ` · ${a.mode}` : ""} — {a.error}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
