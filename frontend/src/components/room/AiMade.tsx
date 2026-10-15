import { useQueryClient } from "@tanstack/react-query";
import { Sparkles, UserRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { tr, useT } from "../../lib/i18n";
import type { Character, CharacterAsset } from "../../lib/types";
import { ConfirmDialog } from "../../pages/admin/shared/ConfirmDialog";
import { Badge, Button } from "../ui";

export const AI_MADE_TEXT = "This image is AI-generated — not a photo of a real person";
export const AI_MADE_HELP = "Only AI-made characters can be registered with BytePlus. Real people verify themselves in the BytePlus console.";
/** The label an upload gets by default (the server swaps it when the attestation changes). */
const DEFAULT_LABELS = ["your photo", "AI-made", ""];

/** Upload one image the user brings for a character; `aiMade` is their attestation that it isn't a real person's photo. */
export const uploadCharacterImage = <T = Character>(cid: number, file: File, aiMade: boolean) =>
  api.upload<T>(`/api/characters/${cid}/upload`, file, aiMade ? { ai_made: true } : undefined);

/** What an uploaded image is called: its own label, or "AI-made" / "your photo" by the attestation. */
export function uploadLabel(a: Pick<CharacterAsset, "label" | "ai_made">): string {
  if (a.label && !DEFAULT_LABELS.includes(a.label)) return a.label;
  return a.ai_made ? tr("AI-made") : tr("your photo");
}

/** The attestation checkbox that goes with every character-image upload. `compact` leaves out the help line (show it once nearby). */
export function AiMadeCheck({ checked, onChange, compact, disabled, className }: {
  checked: boolean; onChange: (v: boolean) => void; compact?: boolean; disabled?: boolean; className?: string;
}) {
  const t = useT();
  return (
    <label className={cn("flex items-start gap-2.5 text-left pointer-coarse:min-h-10", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer", className)}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-ink">{t(AI_MADE_TEXT)}</span>
        {!compact && <span className="block text-2xs leading-snug text-dim">{t(AI_MADE_HELP)}</span>}
      </span>
    </label>
  );
}

/** The one help line under compact checkboxes. */
export function AiMadeHelp({ className }: { className?: string }) {
  const t = useT();
  return <p className={cn("text-2xs leading-snug text-dim", className)}>{t(AI_MADE_HELP)}</p>;
}

type SetResult = { asset: CharacterAsset; byteplus: { removed: number; error: string } | null; character: Character };

/**
 * The character's uploads with what each one is: AI-made (may go to BytePlus) or a real person's photo (never sent; needs a likeness
 * consent). The team can change it later, after a confirm. Marking an upload as a real person's photo takes a BytePlus registration back.
 */
export function UploadAttestations({ character: c, uploads, canAttest, canUnattest }: {
  character: Character; uploads: CharacterAsset[]; canAttest: boolean; canUnattest: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<CharacterAsset | null>(null);
  const [busy, setBusy] = useState(false);
  if (!uploads.length) return null;
  const registered = !!c.provider_assets?.byteplus;

  const apply = async () => {
    if (!confirm) return;
    const to = !confirm.ai_made;
    setBusy(true);
    try {
      const r = await api.put<SetResult>(`/api/character-assets/${confirm.id}/ai-made`, { ai_made: to });
      qc.setQueryData(["character", c.id], r.character);
      qc.invalidateQueries({ queryKey: ["character", c.id] });
      qc.invalidateQueries({ queryKey: ["characters"] });
      qc.invalidateQueries({ queryKey: ["byteplus-plan", c.id] });
      if (r.byteplus?.error) {
        toast.error(tr("Marked as a real person's photo, but removing {name} from BytePlus failed: {error}. Press Remove from BytePlus to try again.",
          { name: c.name, error: r.byteplus.error }), { duration: 12000 });
      } else if (r.byteplus) {
        toast.success(tr("Marked as a real person's photo — {name} was removed from BytePlus", { name: c.name }));
      } else {
        toast.success(to ? tr("Marked as AI-generated") : tr("Marked as a real person's photo"));
      }
      setConfirm(null);
    } catch { /* api toasts */ } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-line bg-bg/40 p-3">
      <p className="eyebrow mb-2">{t("Your uploads")}</p>
      <ul className="divide-y divide-line">
        {uploads.map((a) => {
          const can = a.ai_made ? canUnattest : canAttest;
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-2 first:pt-0 last:pb-0">
              <img src={a.url} alt="" className="h-12 w-9 shrink-0 rounded border border-line object-cover" loading="lazy" />
              <span className="min-w-0 flex-1 basis-40">
                <span className="block truncate text-sm font-medium">{uploadLabel(a)}</span>
                <span className="block text-2xs text-dim">
                  {a.ai_made ? t("AI-generated: can be registered with BytePlus") : t("A real person's photo: never sent to BytePlus, needs a likeness consent")}
                  {a.archived && !a.ai_made && ` · ${t("archived, still blocks BytePlus (views made from it show this person)")}`}
                </span>
              </span>
              {a.ai_made
                ? <Badge tone="ai"><Sparkles className="size-3" />{t("AI-made")}</Badge>
                : <Badge tone="warn"><UserRound className="size-3" />{t("Real person")}</Badge>}
              {can && (
                <Button size="sm" variant="ghost" className="max-sm:h-10" onClick={() => setConfirm(a)}>
                  {a.ai_made ? t("Mark as a real person") : t("Mark as AI-generated")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <ConfirmDialog open={!!confirm} onClose={() => !busy && setConfirm(null)} busy={busy} danger={!!confirm?.ai_made && registered}
        title={confirm?.ai_made ? t("Mark as a real person's photo?") : t("Mark as AI-generated?")}
        confirmLabel={confirm?.ai_made ? (registered ? t("Mark and remove from BytePlus") : t("Mark as a real person")) : t("Yes, it's AI-generated")}
        icon={confirm?.ai_made ? <UserRound className="size-4" /> : <Sparkles className="size-4" />} onConfirm={apply}>
        {confirm?.ai_made ? (
          <>
            {t("It will never be sent to BytePlus, and {name} counts as made from a photo of a real person (a likeness consent is needed).", { name: c.name })}
            {registered && <> <span className="font-medium text-ink">{t("{name} is registered with BytePlus, so it is removed from your BytePlus asset library right away: the face may already be there.", { name: c.name })}</span></>}
            {" "}{t("A real person verifies themselves in the BytePlus console instead.")}
          </>
        ) : (
          <>{t("You confirm this image is AI-generated and doesn't show a real person. It can then be registered with BytePlus. Your answer is recorded in the audit log.")}</>
        )}
      </ConfirmDialog>
    </div>
  );
}
