import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";
import { Button, IconButton, Input } from "../ui";

export interface PronRow { term: string; say: string }

/** project.pronunciations ({term: how to say it}) ⇄ editable rows */
export const toPronRows = (d: Record<string, string> | null | undefined): PronRow[] => Object.entries(d ?? {}).map(([term, say]) => ({ term, say: String(say ?? "") }));
export const toPronDict = (rows: PronRow[]): Record<string, string> =>
  Object.fromEntries(rows.filter((r) => r.term.trim()).map((r) => [r.term.trim(), r.say.trim()]));

/** Small editable table: term → how to say it. Rows are kept in the parent (saved with the Brief). */
export function PronunciationTable({ rows, onChange, disabled }: { rows: PronRow[]; onChange: (rows: PronRow[]) => void; disabled?: boolean }) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const set = (i: number, patch: Partial<PronRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const add = () => { focusLast.current = true; onChange([...rows, { term: "", say: "" }]); };
  const remove = (i: number) => onChange(rows.filter((_, k) => k !== i));
  useEffect(() => {
    if (!focusLast.current) return;
    focusLast.current = false;
    root.current?.querySelector<HTMLInputElement>(`[data-term="${rows.length - 1}"]`)?.focus();
  }, [rows.length]);

  return (
    <div ref={root} className="space-y-2">
      {rows.length ? (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-raised text-2xs uppercase tracking-wider text-dim">
              <tr>
                <th scope="col" className="px-3 py-1.5 text-left font-semibold">{t("Term")}</th>
                <th scope="col" className="px-3 py-1.5 text-left font-semibold">{t("Say it as")}</th>
                {!disabled && <th scope="col" className="w-10"><span className="sr-only">{t("Remove")}</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="p-1.5">
                    <Input value={r.term} data-term={i} aria-label={t("Term")} placeholder={t("Sri Rama")} className="h-8" disabled={disabled}
                      onChange={(e) => set(i, { term: e.target.value })} />
                  </td>
                  <td className="p-1.5">
                    <Input value={r.say} aria-label={t("Say it as")} placeholder={t("Shree Raa-ma")} className="h-8" disabled={disabled}
                      onChange={(e) => set(i, { say: e.target.value })}
                      onKeyDown={(e) => { if (e.key === "Enter" && !disabled && i === rows.length - 1 && r.term.trim()) { e.preventDefault(); add(); } }} />
                  </td>
                  {!disabled && (
                    <td className="p-1.5 text-right">
                      <IconButton title={t("Remove")} onClick={() => remove(i)} className="size-7 hover:text-bad"><Trash2 className="size-3.5" /></IconButton>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-line px-4 py-4 text-center text-xs text-mute">
          {t("No pronunciations yet. Add the names and words the voices keep getting wrong.")}
        </p>
      )}
      {!disabled && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={add}>{t("Add term")}</Button>}
    </div>
  );
}
