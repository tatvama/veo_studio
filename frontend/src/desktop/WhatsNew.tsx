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

/** A small, safe Markdown view (headings, bullets, bold, links shown as text): no HTML from the notes is rendered. */
export function NotesView({ text, limit }: { text: string; limit?: number }) {
  const plain = text.replace(/<[^>]+>/g, "");
  const lines = plain.split(/\r?\n/);
  const out: ReactNode[] = [];
  const inline = (s: string, key: string) => {
    const parts = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\(\[[0-9a-f]{7}\]\)|\([0-9a-f]{7}\)/g, "").split(/(\*\*[^*]+\*\*|`[^`]+`)/);
    return parts.map((p, i) => p.startsWith("**") ? <strong key={`${key}-${i}`} className="font-semibold text-ink">{p.slice(2, -2)}</strong>
      : p.startsWith("`") ? <code key={`${key}-${i}`} className="mono rounded bg-raised px-1 text-2xs">{p.slice(1, -1)}</code> : <Fragment key={`${key}-${i}`}>{p}</Fragment>);
  };
  let bullets: ReactNode[] = [];
  let para: string[] = [];
  const flushPara = (k: number) => { if (para.length) { out.push(<p key={`p${k}`} className="text-sm text-mute">{inline(para.join(" "), `p${k}`)}</p>); para = []; } };
  const flush = (k: number) => { flushPara(k); if (bullets.length) { out.push(<ul key={`ul${k}`} className="ml-4 list-disc space-y-1 text-sm text-mute">{bullets}</ul>); bullets = []; } };
  let count = 0;
  lines.forEach((l, i) => {
    if (limit && count >= limit) return;
    const t = l.trim();
    if (!t) { flush(i); return; }
    if (/^##\s/.test(t)) { flush(i); out.push(<h3 key={i} className="text-base font-semibold">{inline(t.replace(/^##\s+/, "").replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, ""), `h${i}`)}</h3>); return; }
    if (/^###\s/.test(t)) { flush(i); out.push(<p key={i} className="eyebrow mt-3">{t.replace(/^###\s+/, "")}</p>); return; }
    if (/^[*-]\s/.test(t)) { flushPara(i); count++; bullets.push(<li key={i}>{inline(t.replace(/^[*-]\s+/, ""), `l${i}`)}</li>); return; }
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
