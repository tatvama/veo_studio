import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { X } from "lucide-react";
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ChangeEvent, type KeyboardEvent, type RefObject, type TextareaHTMLAttributes,
} from "react";
import { useT } from "../../lib/i18n";
import { createMention, findMentions, useMentionCandidates, type MentionCandidate, type MentionKind } from "../../lib/v3";
import { AutoText } from "./kit";
import { KIND_ICON, KIND_LABEL, MentionPopover, type MentionItem } from "./MentionPopover";

type Field = HTMLInputElement | HTMLTextAreaElement;
export const ALL_KINDS: MentionKind[] = ["character", "location", "prop"];
const CHARACTER_ONLY: MentionKind[] = ["character"];

/**
 * `@query` just before the caret: `@` at the start or after a space / bracket / quote, then a name (one space allowed,
 * so "Oil lamp" works). An existing token `@[Name](kind:id)` never matches because `[` is not a name character.
 */
const TRIGGER_RE = /(?:^|[\s(["'“‘,;:!?-])@([\p{L}\p{M}\p{N}'’.-]*(?: [\p{L}\p{M}\p{N}'’.-]*)?)$/u;
export function detectMention(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = TRIGGER_RE.exec(before);
  return m ? { start: before.length - m[1].length - 1, query: m[1] } : null;
}

/**
 * Turns a plain <input>/<textarea> into an @mention field: typing `@` opens a candidate list anchored to the field,
 * ↑/↓/Enter/Esc work without leaving the caret, and picking a row replaces the typed `@query` with the full token.
 * Spread `fieldProps` on the element, render `popover` next to it.
 */
export function useMentionField({ pid, value, onChange, ref, enabled = true, pad = true, kinds = ALL_KINDS }: {
  pid: number; value: string; onChange: (v: string) => void; ref: RefObject<Field | null>;
  enabled?: boolean; /** add a space after the inserted token (off for the speaker field) */ pad?: boolean; kinds?: MentionKind[];
}) {
  const qc = useQueryClient();
  const listId = useId();
  const [trig, setTrig] = useState<{ start: number; query: string } | null>(null);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const dismissed = useRef<number | null>(null);   // the `@` the user pressed Esc on: stays closed until a new `@` is typed
  const caretAfter = useRef<number | null>(null);  // where the caret goes once the parent has applied an insert
  const last = useRef<MentionCandidate[]>([]);     // last list, shown while the next query is in flight

  const q = trig?.query.trim().replace(/\s+/g, " ") ?? "";
  const { data, isFetching } = useMentionCandidates(trig && enabled ? pid : 0, q);
  useEffect(() => { if (data) last.current = data; }, [data]);

  const items = useMemo<MentionItem[]>(() => {
    if (!trig) return [];
    const low = q.toLowerCase();
    const rank = (c: MentionCandidate) => kinds.indexOf(c.kind) * 2 + (c.in_project ? 0 : 1);
    const list = (data ?? last.current).filter((c) => kinds.includes(c.kind) && (!low || c.name.toLowerCase().includes(low))).sort((a, b) => rank(a) - rank(b));
    const out: MentionItem[] = list.map((c) => ({ type: "pick", key: `${c.kind}:${c.id}`, cand: c }));
    if (q && !list.length) for (const kind of kinds) out.push({ type: "create", key: `new:${kind}`, kind, name: q });
    return out;
  }, [trig, q, data, kinds]);
  const itemsKey = items.map((i) => i.key).join("|");
  useEffect(() => { setCursor(0); }, [itemsKey]);

  // Read the field (not `value`): during a change event the DOM already holds the new text and caret.
  const sync = useCallback(() => {
    const el = ref.current;
    if (!el || !enabled) { setTrig(null); return; }
    const d = detectMention(el.value, el.selectionStart ?? el.value.length);
    if (!d) { dismissed.current = null; setTrig(null); return; }
    if (dismissed.current === d.start) { setTrig(null); return; }
    setTrig((cur) => (cur && cur.start === d.start && cur.query === d.query ? cur : d));
  }, [ref, enabled]);

  const close = useCallback(() => setTrig(null), []);

  const insert = useCallback((token: string) => {
    const el = ref.current;
    if (!el || !trig) return;
    const caret = el.selectionStart ?? el.value.length;
    const text = pad ? `${token} ` : token;
    caretAfter.current = trig.start + text.length;
    dismissed.current = null;
    setTrig(null);
    onChange(el.value.slice(0, trig.start) + text + el.value.slice(caret));
  }, [ref, trig, pad, onChange]);

  // Put the caret right after the token once the controlled value has caught up.
  useLayoutEffect(() => {
    const pos = caretAfter.current;
    if (pos === null) return;
    caretAfter.current = null;
    const el = ref.current;  // gone when the field swapped to a chip (speaker): the owner focuses the chip instead
    if (!el) return;
    el.focus();
    el.setSelectionRange(pos, pos);
  }, [value, ref]);

  const choose = useCallback(async (it: MentionItem) => {
    if (it.type === "pick") return insert(it.cand.token);
    setBusy(true);
    try {
      const made = await createMention(it.kind, it.name, pid);
      insert(made.token);
      qc.invalidateQueries({ queryKey: ["mentions", pid] });
      qc.invalidateQueries({ queryKey: [it.kind === "character" ? "characters" : it.kind === "prop" ? "props" : "locations"] });
      qc.invalidateQueries({ queryKey: ["project", pid] });
    } catch { /* api toasts */ } finally { setBusy(false); }
  }, [insert, pid, qc]);

  const onKeyDown = (e: KeyboardEvent<Field>) => {
    if (!trig) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      setCursor((c) => (c + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    } else if ((e.key === "Enter" || e.key === "Tab") && items[cursor] && !busy) {
      e.preventDefault();
      void choose(items[cursor]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissed.current = trig.start;
      setTrig(null);
    }
  };

  const open = !!trig && enabled;
  const fieldProps = {
    onChange: (e: ChangeEvent<Field>) => {
      if ((e.nativeEvent as InputEvent).data === "@") dismissed.current = null;  // a fresh `@` may reopen a dismissed spot
      onChange(e.target.value);
      sync();
    },
    onKeyDown,
    onSelect: sync,     // caret moves (clicks, arrows) open or close the list too
    onBlur: close,
    "aria-autocomplete": "list" as const,
    "aria-activedescendant": open && items[cursor] ? `${listId}-${cursor}` : undefined,
  };
  const popover = open ? (
    <MentionPopover open anchor={ref} listId={listId} items={items} cursor={cursor} loading={isFetching && !data} busy={busy}
      onCursor={setCursor} onPick={(it) => void choose(it)} onClose={close} />
  ) : null;

  return { open, fieldProps, popover };
}

/** One readable chip per token in `value` (icon per kind + name). The × turns that token back into the plain name. */
export function MentionChips({ value, onChange, className }: { value: string; onChange?: (v: string) => void; className?: string }) {
  const t = useT();
  const found = findMentions(value);
  if (!found.length) return null;
  const unlink = (k: number) => {
    const m = found[k];
    onChange?.(value.slice(0, m.start) + m.name + value.slice(m.end));
  };
  return (
    <ul className={clsx("flex flex-wrap gap-1", className)} aria-label={t("Mentions")}>
      {found.map((m, k) => {
        const Icon = KIND_ICON[m.kind];
        return (
          <li key={`${m.start}-${m.kind}-${m.id}`} className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-line bg-raised pl-1.5 pr-0.5 text-2xs font-medium text-ink"
            title={t(KIND_LABEL[m.kind])}>
            <Icon aria-hidden className="size-3 shrink-0 text-accent-ink" />
            <span className="truncate">{m.name}</span>
            {onChange ? (
              <button type="button" onClick={() => unlink(k)} aria-label={t("Unlink {name} (keep the plain name)", { name: m.name })}
                className="grid size-5 place-items-center rounded text-mute transition-colors hover:bg-hover hover:text-bad">
                <X className="size-3" />
              </button>
            ) : <span className="w-1" />}
          </li>
        );
      })}
    </ul>
  );
}

/** Growing textarea with @mention autocomplete and the chip strip under it. Same props as AutoText, but `onChange` gets the string. */
export function MentionText({ pid, value, onChange, readOnly, chipsClassName, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  pid: number; value: string; onChange: (v: string) => void; chipsClassName?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const m = useMentionField({ pid, value, onChange, ref, enabled: !readOnly });
  return (
    <div className="min-w-0">
      <AutoText ref={ref} value={value} readOnly={readOnly} {...rest} {...m.fieldProps} />
      {m.popover}
      <MentionChips value={value} onChange={readOnly ? undefined : onChange} className={clsx("mt-1 px-1.5", chipsClassName)} />
    </div>
  );
}

export { CHARACTER_ONLY };
