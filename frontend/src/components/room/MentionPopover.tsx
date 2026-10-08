import { clsx } from "clsx";
import { Loader2, MapPin, Package, Plus, User } from "lucide-react";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useT } from "../../lib/i18n";
import type { MentionCandidate, MentionKind } from "../../lib/v3";
import { Popover } from "../ui";

/** One row of the @mention list: an existing entity, or "create <name>" as a given kind. */
export type MentionItem =
  | { type: "pick"; key: string; cand: MentionCandidate }
  | { type: "create"; key: string; kind: MentionKind; name: string };

export const KIND_ICON = { character: User, location: MapPin, prop: Package } as const;
/** t() keys */
export const KIND_LABEL: Record<MentionKind, string> = { character: "Character", location: "Location", prop: "Prop" };
const KIND_PLURAL: Record<MentionKind, string> = { character: "Characters", location: "Locations", prop: "Props" };
const KIND_CREATE: Record<MentionKind, string> = { character: "Create character “{name}”", location: "Create location “{name}”", prop: "Create prop “{name}”" };

/**
 * The autocomplete list under a script field. Keyboard handling lives in the field (useMentionField) so the caret never
 * leaves the text; this only draws the rows and keeps the highlighted one in view.
 */
export function MentionPopover({ open, anchor, listId, items, cursor, loading, busy, onCursor, onPick, onClose }: {
  open: boolean; anchor: RefObject<HTMLElement | null>; listId: string; items: MentionItem[]; cursor: number; loading?: boolean; busy?: boolean;
  onCursor: (i: number) => void; onPick: (it: MentionItem) => void; onClose: () => void;
}) {
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  // characters, then locations, then props, then the create rows — with the index into `items` kept for the cursor
  const groups = useMemo(() => {
    const by = new Map<string, { label: string; rows: { it: MentionItem; i: number }[] }>();
    items.forEach((it, i) => {
      const key = it.type === "create" ? "create" : it.cand.kind;
      const label = it.type === "create" ? "Not found — create" : KIND_PLURAL[it.cand.kind];
      if (!by.has(key)) by.set(key, { label, rows: [] });
      by.get(key)!.rows.push({ it, i });
    });
    return [...by.values()];
  }, [items]);

  return (
    <Popover open={open} anchor={anchor} onClose={onClose} placement="bottom-start" width={300} className="overflow-hidden">
      {/* mousedown is swallowed so the field keeps focus (and its caret) while a row is clicked */}
      <div ref={list} id={listId} role="listbox" aria-label={t("Mention")} className="max-h-72 overflow-y-auto p-1" onMouseDown={(e) => e.preventDefault()}>
        {!items.length && (
          <p className="flex items-center gap-2 px-2.5 py-2 text-xs text-mute">
            {loading ? <><Loader2 className="size-3.5 animate-spin" />{t("Searching…")}</> : t("Type a name to mention a character, location or prop.")}
          </p>
        )}
        {groups.map((g) => (
          <div key={g.label} role="group" aria-label={t(g.label)}>
            <p className="px-2.5 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-dim">{t(g.label)}</p>
            {g.rows.map(({ it, i }) => {
              const Icon = it.type === "pick" ? KIND_ICON[it.cand.kind] : Plus;
              const on = i === cursor;
              return (
                <button key={it.key} type="button" role="option" id={`${listId}-${i}`} data-i={i} aria-selected={on} disabled={busy}
                  onMouseEnter={() => onCursor(i)} onClick={() => onPick(it)}
                  className={clsx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors disabled:opacity-50", on ? "bg-hover text-ink" : "text-ink")}>
                  <span className={clsx("grid size-5 shrink-0 place-items-center rounded-md", it.type === "create" ? "bg-accent/12 text-accent-ink" : "bg-raised text-mute")}>
                    <Icon className="size-3.5" />
                  </span>
                  {it.type === "pick" ? (
                    <>
                      <span className="min-w-0 flex-1 truncate">{it.cand.name}</span>
                      {!it.cand.in_project && <span className="shrink-0 text-2xs text-dim">{t("library")}</span>}
                    </>
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{t(KIND_CREATE[it.kind], { name: it.name })}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <p className="border-t border-line bg-panel/60 px-2.5 py-1 text-2xs text-dim">
        <kbd className="font-sans">↑↓</kbd> {t("move")} · <kbd className="font-sans">↵</kbd> {t("insert")} · <kbd className="font-sans">Esc</kbd> {t("dismiss")}
      </p>
    </Popover>
  );
}
