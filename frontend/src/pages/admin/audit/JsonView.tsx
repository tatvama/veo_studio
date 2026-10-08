import type { ReactNode } from "react";

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Pretty-printed JSON with light colouring (keys, strings, numbers, true/false/null). Built from text nodes, never raw HTML. */
export function JsonView({ value, className }: { value: unknown; className?: string }) {
  const text = JSON.stringify(value ?? {}, null, 2);
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [full, str, colon, word, num] = m;
    if (str !== undefined) {
      out.push(colon
        ? <span key={i++}><span className="text-sky-300">{str}</span><span className="text-dim">{colon}</span></span>
        : <span key={i++} className="text-green-300">{str}</span>);
    } else if (word) out.push(<span key={i++} className="text-amber-300">{word}</span>);
    else if (num) out.push(<span key={i++} className="text-accent-ink">{num}</span>);
    else out.push(full);
    last = at + full.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <pre className={className}>{out}</pre>;
}

/** A flat, readable list of the simple fields of a detail object (nested values are left to the JSON view). */
export function flatEntries(detail: Record<string, unknown> | null | undefined): [string, string][] {
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(detail ?? {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") rows.push([k, String(v)]);
    else if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) rows.push([k, v.join(", ")]);
  }
  return rows;
}
