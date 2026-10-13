/**
 * "What's new": the release notes of the installed version — the updater's notes when it has them, else the CHANGELOG
 * section bundled with the screens. Shown once after an update, from Help → What's new and on the Start page.
 */
import { Sparkles } from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Button, Modal, Skeleton } from "../components/ui";
import { desktop } from "../lib/desktop";
import { setOverlay, useShellUi } from "./state";

const bundled = import.meta.glob("../../../CHANGELOG.md", { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;

/** The CHANGELOG section for a version ("## [3.1.0](…)"), else the newest one. */
export function changelogSection(md: string, version: string): string {
  const sections = md.split(/\n(?=## )/).filter((p) => p.startsWith("## "));
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hit = sections.find((s) => new RegExp(`^## \\[?v?${esc}\\]?(\\(|\\s|$)`).test(s)) ?? sections[0];
  return hit ? hit.trim() : "";
}

export interface Notes { version: string; text: string; from: "updater" | "bundled" | "none" }

export async function loadNotes(): Promise<Notes> {
  const d = desktop();
  const version = d?.version ?? "";
  try {
    const r = await d?.app.releaseNotes?.();
    if (r && r.notes) return { version: r.version, text: r.notes, from: r.source };
  } catch { /* older bridge */ }
  const load = Object.values(bundled)[0];
  if (load) {
    try {
      const md = await load();
      const s = changelogSection(md, version);
      if (s) return { version, text: s, from: "bundled" };
    } catch { /* not bundled */ }
  }
  return { version, text: "", from: "none" };
}

// ── the notes as React elements ──────────────────────────────────────────────
// Release notes are Markdown (the CHANGELOG) or HTML (GitHub's, through the updater). Neither is ever put into the
// page as HTML: Markdown is read line by line into elements, and HTML is parsed inert (DOMParser: no scripts run,
// nothing loads) and only its text, structure and link targets are kept. Everything shown is React text.

/** An https link from the notes, else null: only https links are opened. */
export function httpsLink(href: string): string | null {
  try {
    const u = new URL(href);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function NoteLink({ href, children }: { href: string; children: ReactNode }) {
  const url = httpsLink(href);
  if (!url) return <>{children}</>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline-offset-2 hover:underline"
      onClick={(e) => {
        const d = desktop();
        if (!d) return; // the browser opens it in a new tab
        e.preventDefault();
        void d.app.openExternal(url).catch(() => undefined);
      }}>
      {children}
    </a>
  );
}

/** release-please's commit links, "([4bc47c0](https://…/commit/…))", "([4bc47c0])", "(4bc47c0)": noise in the notes, left out. */
const COMMIT_REF = / ?\(\[[0-9a-f]{7,40}\](?:\([^)\s]*\))?\)| ?\([0-9a-f]{7}\)/g;
/** [text](url), **bold**, `code` */
const INLINE = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;

function inline(s: string, key: string): ReactNode[] {
  const src = s.replace(COMMIT_REF, "");
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of src.matchAll(INLINE)) {
    if (m.index > last) out.push(<Fragment key={`${key}-${n++}`}>{src.slice(last, m.index)}</Fragment>);
    const k = `${key}-${n++}`;
    if (m[1] !== undefined) out.push(<NoteLink key={k} href={m[2]}>{m[1]}</NoteLink>);
    else if (m[3] !== undefined) out.push(<strong key={k} className="font-semibold text-ink">{m[3]}</strong>);
    else out.push(<code key={k} className="mono rounded bg-raised px-1 text-2xs">{m[4]}</code>);
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(<Fragment key={`${key}-${n++}`}>{src.slice(last)}</Fragment>);
  return out;
}

/** HTML notes start with a tag; Markdown ones with text, "#" or a bullet. */
const isHtml = (s: string) => /^<[a-z][a-z0-9]*[\s/>]/i.test(s.trimStart());

/**
 * HTML release notes → the Markdown this view reads (headings, lists, paragraphs, links, bold, code). The HTML is
 * parsed by DOMParser into an inert document and walked node by node: only text and link targets come out.
 */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const skip = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "IFRAME", "OBJECT", "SVG"]);
  const linkTarget = (h: string) => h.trim().replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
  const textOf = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
    if (!(node instanceof Element) || skip.has(node.tagName.toUpperCase())) return "";
    if (node.tagName === "BR") return " ";
    const kids = [...node.childNodes].map(textOf).join("");
    if (!kids.trim()) return kids;
    switch (node.tagName) {
      case "A": { const h = node.getAttribute("href"); return h ? `[${kids.trim()}](${linkTarget(h)})` : kids; }
      case "STRONG": case "B": return `**${kids.trim()}**`;
      case "CODE": return `\`${kids.trim()}\``;
      default: return kids;
    }
  };
  const lines: string[] = [];
  const block = (node: Node) => {
    if (!(node instanceof Element)) { const t = textOf(node).trim(); if (t) lines.push(t, ""); return; }
    const tag = node.tagName.toUpperCase();
    if (skip.has(tag)) return;
    if (tag === "H1" || tag === "H2") lines.push("", `## ${textOf(node).trim()}`, "");
    else if (/^H[3-6]$/.test(tag)) lines.push("", `### ${textOf(node).trim()}`, "");
    else if (tag === "UL" || tag === "OL") {
      for (const li of node.children) if (li.tagName === "LI") lines.push(`- ${textOf(li).trim()}`);
      lines.push("");
    } else if (tag === "P" || tag === "LI" || tag === "BLOCKQUOTE" || tag === "PRE") lines.push(textOf(node).trim(), "");
    else for (const c of node.childNodes) block(c); // div, section, details …
  };
  for (const c of doc.body.childNodes) block(c);
  return lines.join("\n");
}

/** The notes as elements: headings, bullets, paragraphs, https links, bold and code. `limit` = at most that many bullets. */
export function NotesView({ text, limit }: { text: string; limit?: number }) {
  const md = isHtml(text) ? htmlToMarkdown(text) : text;
  const lines = md.split(/\r?\n/);
  const out: ReactNode[] = [];
  let bullets: ReactNode[] = [];
  let para: string[] = [];
  const flushPara = (k: number) => { if (para.length) { out.push(<p key={`p${k}`} className="text-sm text-mute">{inline(para.join(" "), `p${k}`)}</p>); para = []; } };
  const flush = (k: number) => { flushPara(k); if (bullets.length) { out.push(<ul key={`ul${k}`} className="ml-4 list-disc space-y-1 text-sm text-mute">{bullets}</ul>); bullets = []; } };
  let count = 0;
  lines.forEach((l, i) => {
    if (limit && count >= limit) return;
    const t = l.trim();
    if (!t) { flush(i); return; }
    if (/^##?\s/.test(t)) { flush(i); out.push(<h3 key={i} className="text-base font-semibold">{inline(t.replace(/^##?\s+/, "").replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, ""), `h${i}`)}</h3>); return; }
    if (/^#{3,6}\s/.test(t)) { flush(i); out.push(<p key={i} className="eyebrow mt-3">{inline(t.replace(/^#{3,6}\s+/, ""), `e${i}`)}</p>); return; }
    if (/^(?:[*-]|\d+[.)])\s/.test(t)) { flushPara(i); count++; bullets.push(<li key={i}>{inline(t.replace(/^(?:[*-]|\d+[.)])\s+/, ""), `l${i}`)}</li>); return; }
    if (bullets.length) flush(i);
    para.push(t); // a paragraph wrapped over several lines reads as one
  });
  flush(lines.length);
  return <div className="space-y-2 leading-relaxed">{out}</div>;
}

export function WhatsNew() {
  const { overlay } = useShellUi();
  const open = overlay === "whatsnew";
  const [notes, setNotes] = useState<Notes | null>(null);
  useEffect(() => { if (open && !notes) void loadNotes().then(setNotes); }, [open, notes]);
  return (
    <Modal open={open} onClose={() => setOverlay(null)} size="lg"
      title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-accent-ink" />What's new in Tatvam Studio {notes?.version ?? ""}</span>}
      footer={<Button variant="primary" onClick={() => setOverlay(null)}>Got it</Button>}>
      <div className="desk-ui max-h-[60vh] overflow-y-auto pr-1">
        {!notes ? <div className="space-y-2"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-4" /><Skeleton className="h-4 w-4/5" /></div>
          : notes.text ? <NotesView text={notes.text} />
            : <p className="text-sm text-mute">The notes for this version aren't on this PC. See the releases on GitHub.</p>}
      </div>
    </Modal>
  );
}
