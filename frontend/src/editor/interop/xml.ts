/**
 * A small, tolerant XML reader and an indenting writer for the interchange files (docs/EDITOR.md §12). The reader
 * runs the same in the browser, in the desktop's main process and in Node tests (no DOMParser): elements, attributes,
 * text, CDATA and the five named entities plus numeric ones. It skips the prolog, comments, processing instructions
 * and the DOCTYPE (with an internal subset), closes what was left open at the end and recovers from a stray end tag.
 * It never fetches anything (no external entities). Pure.
 */

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** The element's own text (its text and CDATA children, joined; whitespace kept). */
  text: string;
}

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e] ?? m;
  });
}

export class XmlError extends Error {}

/** Parses a document; returns a synthetic root ("#document") whose children are the top-level elements. */
export function parseXml(src: string): XNode {
  const root: XNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XNode[] = [root];
  const top = () => stack[stack.length - 1];
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = src.length;
  let elements = 0;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { top().text += decodeEntities(src.slice(i)); break; }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const e = src.indexOf("-->", lt + 4);
      i = e < 0 ? n : e + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const e = src.indexOf("]]>", lt + 9);
      top().text += src.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
    } else if (src.startsWith("<?", lt)) {
      const e = src.indexOf("?>", lt + 2);
      i = e < 0 ? n : e + 2;
    } else if (src.startsWith("<!", lt)) {
      // <!DOCTYPE …> with an optional [internal subset]
      let j = lt + 2, depth = 0;
      for (; j < n; j++) {
        const c = src[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      i = j + 1;
    } else if (src[lt + 1] === "/") {
      const e = src.indexOf(">", lt + 2);
      const name = src.slice(lt + 2, e < 0 ? n : e).trim();
      i = e < 0 ? n : e + 1;
      // pop to the matching open element; a stray end tag with no match is ignored
      let k = stack.length - 1;
      while (k > 0 && stack[k].name !== name) k--;
      if (k > 0) stack.length = k;
    } else {
      // a start tag: name, then attributes, then > or />
      let j = lt + 1;
      while (j < n && !/[\s/>]/.test(src[j])) j++;
      const name = src.slice(lt + 1, j);
      if (!name) { top().text += "<"; i = lt + 1; continue; }
      const attrs: Record<string, string> = {};
      let selfClose = false;
      for (;;) {
        while (j < n && /\s/.test(src[j])) j++;
        if (j >= n) break;
        if (src[j] === ">") { j++; break; }
        if (src[j] === "/" && src[j + 1] === ">") { selfClose = true; j += 2; break; }
        if (src[j] === "/") { j++; continue; }
        let k = j;
        while (k < n && !/[\s=/>]/.test(src[k])) k++;
        const an = src.slice(j, k);
        j = k;
        while (j < n && /\s/.test(src[j])) j++;
        let av = "";
        if (src[j] === "=") {
          j++;
          while (j < n && /\s/.test(src[j])) j++;
          const q = src[j];
          if (q === "\"" || q === "'") {
            const e = src.indexOf(q, j + 1);
            av = src.slice(j + 1, e < 0 ? n : e);
            j = e < 0 ? n : e + 1;
          } else {
            let e = j;
            while (e < n && !/[\s>]/.test(src[e])) e++;
            av = src.slice(j, e);
            j = e;
          }
        }
        if (an) attrs[an] = decodeEntities(av);
        if (k === j && !an) j++; // no progress: skip a junk character
      }
      const el: XNode = { name, attrs, children: [], text: "" };
      top().children.push(el);
      if (++elements > 2_000_000) throw new XmlError("The XML file is too large");
      if (!selfClose) stack.push(el);
      i = j;
    }
  }
  return root;
}

// ── reading helpers ──────────────────────────────────────────────────────────

export const kids = (n: XNode | undefined, name: string): XNode[] => (n ? n.children.filter((c) => c.name === name) : []);
export const kid = (n: XNode | undefined, name: string): XNode | undefined => n?.children.find((c) => c.name === name);
/** Trimmed text of a child element ("" when missing). */
export const txt = (n: XNode | undefined, name: string): string => (kid(n, name)?.text ?? "").trim();
/** A child element's number, or `d` when missing / not a number. */
export function numOf(n: XNode | undefined, name: string, d: number): number {
  const s = txt(n, name);
  const v = s === "" ? NaN : Number(s);
  return Number.isFinite(v) ? v : d;
}
export const boolOf = (n: XNode | undefined, name: string, d: boolean): boolean => {
  const s = txt(n, name).toUpperCase();
  return s === "TRUE" || s === "1" || s === "YES" ? true : s === "FALSE" || s === "0" || s === "NO" ? false : d;
};
/** Child at a path: path(n, "media", "video", "format"). */
export function path(n: XNode | undefined, ...names: string[]): XNode | undefined {
  let c = n;
  for (const nm of names) c = kid(c, nm);
  return c;
}
/** Every descendant element with that name (document order). */
export function descendants(n: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

// ── writing ──────────────────────────────────────────────────────────────────

export const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  // characters XML 1.0 forbids (controls other than tab / newline / CR)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

type AttrVal = string | number | boolean | undefined | null;
const attrStr = (a?: Record<string, AttrVal>) =>
  a ? Object.entries(a).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => ` ${k}="${escXml(String(v))}"`).join("") : "";

/** An indenting XML writer (two spaces, LF). */
export class XmlWriter {
  private lines: string[] = [];
  private open: string[] = [];
  constructor(prolog = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>") { if (prolog) this.lines.push(prolog); }
  private pad() { return "  ".repeat(this.open.length); }
  raw(line: string) { this.lines.push(this.pad() + line); return this; }
  start(name: string, attrs?: Record<string, AttrVal>) { this.lines.push(`${this.pad()}<${name}${attrStr(attrs)}>`); this.open.push(name); return this; }
  end() { const n = this.open.pop(); if (n) this.lines.push(`${this.pad()}</${n}>`); return this; }
  /** <name>value</name> (nothing when value is undefined). */
  leaf(name: string, value: string | number | boolean | undefined, attrs?: Record<string, AttrVal>) {
    if (value === undefined) return this;
    const v = typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
    this.lines.push(`${this.pad()}<${name}${attrStr(attrs)}>${escXml(v)}</${name}>`);
    return this;
  }
  empty(name: string, attrs?: Record<string, AttrVal>) { this.lines.push(`${this.pad()}<${name}${attrStr(attrs)}/>`); return this; }
  toString() { while (this.open.length) this.end(); return this.lines.join("\n") + "\n"; }
}
