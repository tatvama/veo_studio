import { clsx } from "clsx";
import { Fragment, memo, type ReactNode } from "react";

/**
 * A tiny, safe formatter for the Director's replies (no HTML is ever injected):
 * paragraphs and line breaks, "-" / "1." lists, `code`, ```fences```, **bold**, *italic*, links and shot codes (E01-SH03).
 */
type Block =
  | { k: "p"; lines: string[] }
  | { k: "ul"; items: string[] }
  | { k: "ol"; items: string[]; start: number }
  | { k: "code"; text: string }
  | { k: "h"; text: string };

const UL = /^\s*[-*•]\s+(.*)$/;
const OL = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const HEAD = /^\s*#{1,4}\s+(.*)$/;
const FENCE = /^\s*```/;

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  const startsBlock = (l: string) => UL.test(l) || OL.test(l) || HEAD.test(l) || FENCE.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (FENCE.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push({ k: "code", text: buf.join("\n") });
      continue;
    }
    const head = HEAD.exec(line);
    if (head) { out.push({ k: "h", text: head[1] }); i++; continue; }
    if (UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL.test(lines[i])) items.push(UL.exec(lines[i])![1]), i++;
      out.push({ k: "ul", items });
      continue;
    }
    const ol = OL.exec(line);
    if (ol) {
      const items: string[] = [];
      while (i < lines.length && OL.test(lines[i])) items.push(OL.exec(lines[i])![2]), i++;
      out.push({ k: "ol", items, start: Number(ol[1]) || 1 });
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !(buf.length && startsBlock(lines[i]))) buf.push(lines[i++]);
    out.push({ k: "p", lines: buf });
  }
  return out;
}

// 1 `code` · 2 **bold** · 3 *italic* · 4 link · 5 shot code
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\*(?=\S)([^*\n]*?\S)\*|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|\b(E\d{2}-SH\d{2})\b/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = m.index;
    if (m[1] !== undefined) out.push(<code key={key} className="rounded border border-line bg-raised px-1 py-px font-mono text-[0.92em] text-ink">{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={key} className="font-semibold text-ink">{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<em key={key}>{m[3]}</em>);
    else if (m[4] !== undefined) {
      out.push(
        <a key={key} href={m[4]} target="_blank" rel="noopener noreferrer"
          className="text-accent-ink underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent">{m[4]}</a>,
      );
    } else if (m[5] !== undefined) {
      out.push(<span key={key} className="whitespace-nowrap rounded-md border border-accent/25 bg-accent/10 px-1 py-px font-mono text-[0.92em] font-medium text-accent-ink">{m[5]}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const Line = ({ text }: { text: string }) => (
  text.startsWith("⚠") ? <span className="text-warn">{inline(text)}</span> : <>{inline(text)}</>
);

/** The dev "mock agent" banner is shown as a quiet note above the real reply. */
export function splitNote(content: string): { note: string | null; body: string } {
  const m = /^\((Mock agent[^)\n]*)\)\s*\n?/.exec(content);
  return m ? { note: m[1], body: content.slice(m[0].length) } : { note: null, body: content };
}

export const RichText = memo(function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = parse(text);
  return (
    <div className={clsx("space-y-2 break-words [overflow-wrap:anywhere]", className)}>
      {blocks.map((b, bi) => {
        switch (b.k) {
          case "h":
            return <p key={bi} className="font-semibold text-ink">{inline(b.text)}</p>;
          case "ul":
            return (
              <ul key={bi} className="list-disc space-y-1 pl-5 marker:text-dim">
                {b.items.map((it, i) => <li key={i}>{inline(it)}</li>)}
              </ul>
            );
          case "ol":
            return (
              <ol key={bi} start={b.start} className="list-decimal space-y-1 pl-5 marker:text-dim marker:tabular-nums">
                {b.items.map((it, i) => <li key={i} className="pl-0.5">{inline(it)}</li>)}
              </ol>
            );
          case "code":
            return <pre key={bi} className="overflow-x-auto rounded-lg border border-line bg-raised p-2.5 font-mono text-xs leading-relaxed text-ink">{b.text}</pre>;
          default:
            return (
              <p key={bi}>
                {b.lines.map((l, i) => <Fragment key={i}>{i > 0 && <br />}<Line text={l} /></Fragment>)}
              </p>
            );
        }
      })}
    </div>
  );
});
