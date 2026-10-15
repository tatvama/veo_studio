import { clsx } from "clsx";
import { Loader2, Palette, Plus, Tag, X } from "lucide-react";
import { Fragment, useMemo, useRef, useState, type RefObject } from "react";
import { useT } from "../../lib/i18n";
import type { AgentAttachmentTag } from "../../lib/types";
import { findMentions, useMentionCandidates, type MentionKind } from "../../lib/v3";
import { KIND_ICON } from "../room/MentionPopover";
import { Popover } from "../ui";

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const ATTACH_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** A picture in the composer: a local preview while it uploads, then the server's id. */
export interface DraftAttachment {
  key: string; preview: string; name: string; status: "uploading" | "ready"; id?: number; tag: AgentAttachmentTag | null;
}

/** A picture shown in the conversation (sent, or still sending with its local preview). */
export interface ShownAttachment { key: string | number; src: string; href?: string; name: string; tag?: AgentAttachmentTag | null }

const CAST_KINDS: MentionKind[] = ["character", "location", "prop"];
const NEW_LABEL: Record<MentionKind, string> = { character: "New character “{name}”", location: "New location “{name}”", prop: "New prop “{name}”" };

type T = ReturnType<typeof useT>;

export function tagText(t: T, tag: AgentAttachmentTag | null | undefined, empty = "Tag…"): string {
  if (!tag) return t(empty);
  if (tag.kind === "style") return t("Look reference");
  if (tag.new || !tag.id) return t("New: {name}", { name: tag.name ?? "" });
  return tag.name ?? "";
}

function TagIcon({ tag, className }: { tag: AgentAttachmentTag | null | undefined; className?: string }) {
  const Icon = !tag ? Tag : tag.kind === "style" ? Palette : tag.new || !tag.id ? Plus : KIND_ICON[tag.kind];
  return <Icon aria-hidden className={className} />;
}

/**
 * What a picture is: pick a character, location or prop of the project (or the shared library), type a new name, or
 * mark it as a look / style reference. Uses the same candidate list as the script editor's @mentions.
 */
function TagMenu({ pid, open, anchor, tag, onPick, onClose }: {
  pid: number; open: boolean; anchor: RefObject<HTMLElement | null>; tag: AgentAttachmentTag | null;
  onPick: (tag: AgentAttachmentTag | null) => void; onClose: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const name = q.trim().replace(/\s+/g, " ");
  const { data, isFetching } = useMentionCandidates(open ? pid : 0, name, undefined, 12);
  const rows = data ?? [];
  const exact = rows.some((r) => r.name.toLowerCase() === name.toLowerCase());
  const pick = (next: AgentAttachmentTag | null) => { onPick(next); setQ(""); onClose(); };
  const row = "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-ink transition-colors hover:bg-hover";

  return (
    <Popover open={open} anchor={anchor} onClose={onClose} placement="top-start" width={288} className="overflow-hidden">
      <div className="border-b border-line p-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (rows[0] && (exact || !name)) pick({ kind: rows[0].kind, id: rows[0].id, name: rows[0].name });
              else if (name) pick({ kind: "character", name, new: true });
            }
          }}
          aria-label={t("Who or what is in this picture?")}
          placeholder={t("Search the cast, or type a new name")}
          className="h-8 w-full rounded-md border border-line bg-panel px-2.5 text-sm text-ink outline-none placeholder:text-dim focus:border-ai/60"
        />
      </div>
      <div role="listbox" aria-label={t("Tag the picture")} className="max-h-64 overflow-y-auto p-1">
        {!rows.length && !name && (
          <p className="flex items-center gap-2 px-2.5 py-2 text-xs text-mute">
            {isFetching ? <><Loader2 className="size-3.5 animate-spin" />{t("Searching…")}</> : t("No characters, places or props yet. Type a name to add one.")}
          </p>
        )}
        {rows.map((c) => {
          const Icon = KIND_ICON[c.kind];
          const on = tag?.id === c.id && tag?.kind === c.kind;
          return (
            <button key={`${c.kind}:${c.id}`} type="button" role="option" aria-selected={on} onClick={() => pick({ kind: c.kind, id: c.id, name: c.name })}
              className={clsx(row, on && "bg-hover")}>
              <span className="grid size-5 shrink-0 place-items-center rounded-md bg-raised text-mute"><Icon className="size-3.5" /></span>
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {!c.in_project && <span className="shrink-0 text-2xs text-dim">{t("library")}</span>}
            </button>
          );
        })}
        {name && !exact && CAST_KINDS.map((k) => (
          <button key={`new:${k}`} type="button" role="option" aria-selected={false} onClick={() => pick({ kind: k, name, new: true })} className={row}>
            <span className="grid size-5 shrink-0 place-items-center rounded-md bg-accent/12 text-accent-ink"><Plus className="size-3.5" /></span>
            <span className="min-w-0 flex-1 truncate">{t(NEW_LABEL[k], { name })}</span>
          </button>
        ))}
        <div className="my-1 border-t border-line" />
        <button type="button" role="option" aria-selected={tag?.kind === "style"} onClick={() => pick({ kind: "style" })} className={clsx(row, tag?.kind === "style" && "bg-hover")}>
          <span className="grid size-5 shrink-0 place-items-center rounded-md bg-ai/12 text-ai"><Palette className="size-3.5" /></span>
          <span className="min-w-0 flex-1 truncate">{t("Look / style reference")}</span>
        </button>
        {tag && (
          <button type="button" role="option" aria-selected={false} onClick={() => pick(null)} className={row}>
            <span className="grid size-5 shrink-0 place-items-center rounded-md bg-raised text-mute"><X className="size-3.5" /></span>
            <span className="min-w-0 flex-1 truncate text-mute">{t("No tag")}</span>
          </button>
        )}
      </div>
    </Popover>
  );
}

/** One picture in the composer: thumbnail, remove, and the tag button underneath. */
function AttachmentChip({ a, pid, disabled, onRemove, onTag }: {
  a: DraftAttachment; pid: number; disabled: boolean; onRemove: () => void; onTag: (tag: AgentAttachmentTag | null) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <li className="flex w-28 shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-raised">
      <div className="relative h-16 bg-bg">
        <img src={a.preview} alt={a.name} className="size-full object-cover" draggable={false} />
        {a.status === "uploading" && (
          <span className="absolute inset-0 grid place-items-center bg-bg/60" role="status" aria-label={t("Uploading…")}>
            <Loader2 className="size-4 animate-spin text-ai" />
          </span>
        )}
        <button type="button" onClick={onRemove} disabled={disabled} aria-label={t("Remove {name}", { name: a.name })}
          className="absolute right-1 top-1 grid size-5 place-items-center rounded-md bg-bg/80 text-mute backdrop-blur transition-colors hover:text-bad disabled:opacity-50 pointer-coarse:size-7">
          <X className="size-3" />
        </button>
      </div>
      <button ref={ref} type="button" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open}
        title={t("What is in this picture? The Director uses it for the cast or the look.")}
        className={clsx("flex h-6 items-center gap-1 border-t border-line/60 px-1.5 text-left text-2xs font-medium transition-colors hover:bg-hover disabled:opacity-50 pointer-coarse:h-8",
          a.tag ? "text-ink" : "text-dim")}>
        <TagIcon tag={a.tag} className="size-3 shrink-0 text-accent-ink" />
        <span className="truncate">{tagText(t, a.tag)}</span>
      </button>
      <TagMenu pid={pid} open={open} anchor={ref} tag={a.tag} onPick={onTag} onClose={() => setOpen(false)} />
    </li>
  );
}

/** The composer's row of pictures waiting to be sent. */
export function AttachmentStrip({ items, pid, disabled, onRemove, onTag }: {
  items: DraftAttachment[]; pid: number; disabled: boolean; onRemove: (key: string) => void; onTag: (key: string, tag: AgentAttachmentTag | null) => void;
}) {
  const t = useT();
  if (!items.length) return null;
  return (
    <ul aria-label={t("Attached pictures")} className="no-scrollbar flex gap-1.5 overflow-x-auto border-b border-line/60 px-2 py-2">
      {items.map((a) => (
        <AttachmentChip key={a.key} a={a} pid={pid} disabled={disabled} onRemove={() => onRemove(a.key)} onTag={(tag) => onTag(a.key, tag)} />
      ))}
    </ul>
  );
}

/** Pictures in a sent message: thumbnails (click opens the full picture) with the tag each was sent with. */
export function MessageAttachments({ items, className }: { items: ShownAttachment[]; className?: string }) {
  const t = useT();
  if (!items.length) return null;
  return (
    <ul aria-label={t("Attached pictures")} className={clsx("flex flex-wrap gap-1.5", className)}>
      {items.map((a) => {
        const img = <img src={a.src} alt={a.name} loading="lazy" className="size-full object-cover" draggable={false} />;
        return (
          <li key={a.key} className="w-24 overflow-hidden rounded-md border border-line bg-raised">
            {a.href ? <a href={a.href} target="_blank" rel="noreferrer" title={a.name} className="block h-16 bg-bg">{img}</a>
              : <div title={a.name} className="h-16 bg-bg">{img}</div>}
            <p className="flex h-5 items-center gap-1 px-1.5 text-2xs text-mute">
              <TagIcon tag={a.tag} className="size-3 shrink-0 text-accent-ink" />
              <span className="truncate">{tagText(t, a.tag, "Untagged")}</span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/** Chat text with `@[Name](kind:id)` tokens drawn as inline mention chips. */
export function ChatText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: (string | { name: string; kind: MentionKind; key: string })[] = [];
    let at = 0;
    for (const m of findMentions(text)) {
      if (m.start > at) out.push(text.slice(at, m.start));
      out.push({ name: m.name, kind: m.kind, key: `${m.start}` });
      at = m.end;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }, [text]);
  return (
    <>
      {parts.map((p, i) => typeof p === "string" ? <Fragment key={i}>{p}</Fragment> : (
        <span key={p.key} className="rounded bg-accent/12 px-1 font-medium text-accent-ink" title={p.kind}>@{p.name}</span>
      ))}
    </>
  );
}
