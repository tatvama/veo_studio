/**
 * News Room data (docs/EDITOR.md §16.10): RSS 2.0, RSS 1.0 (RDF) and Atom feeds. A small tolerant XML reader (no DOM,
 * so it runs in Node and in the page alike): CDATA, comments, entities (XML, numeric and the common HTML ones),
 * unclosed HTML void tags, stray closing tags and namespaces are all taken in stride. Items give a title, link, date
 * (ISO when it can be read), a plain-text summary, a category and an image. Pure.
 */

export interface XNode { name: string; attrs: Record<string, string>; children: XNode[]; /** Text and child elements in source order. */ parts: (string | XNode)[] }

const NAMED: Record<string, string> = {
  lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: "\u00a0", rsquo: "’", lsquo: "‘", rdquo: "”",
  ldquo: "“", ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·", copy: "©",
  reg: "®", trade: "™", euro: "€", pound: "£", rupee: "₹", deg: "°", times: "×", laquo: "«", raquo: "»",
};

/** Decodes XML / HTML character references; unknown names are left as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const VOID = new Set(["br", "img", "hr", "meta", "input", "source", "wbr", "col", "area", "embed", "param", "track"]);

/** A tolerant XML reader: returns a "#document" node. Never throws. */
export function parseXml(src: string): XNode {
  const doc: XNode = { name: "#document", attrs: {}, children: [], parts: [] };
  const stack: XNode[] = [doc];
  const top = () => stack[stack.length - 1];
  const s = src.replace(/^\uFEFF/, "");
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { top().parts.push(decodeEntities(s.slice(i))); break; }
    if (lt > i) top().parts.push(decodeEntities(s.slice(i, lt)));
    if (s.startsWith("<!--", lt)) { const e = s.indexOf("-->", lt + 4); i = e < 0 ? s.length : e + 3; continue; }
    if (s.startsWith("<![CDATA[", lt)) { const e = s.indexOf("]]>", lt + 9); top().parts.push(s.slice(lt + 9, e < 0 ? s.length : e)); i = e < 0 ? s.length : e + 3; continue; }
    if (s.startsWith("<?", lt)) { const e = s.indexOf("?>", lt + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (s.startsWith("<!", lt)) {
      const br = s.indexOf("[", lt), gt = s.indexOf(">", lt);
      const e = br >= 0 && br < gt ? s.indexOf("]>", br) : gt;
      i = e < 0 ? s.length : e + (br >= 0 && br < gt ? 2 : 1);
      continue;
    }
    // a tag: find its end outside quotes
    let j = lt + 1, q = "";
    for (; j < s.length; j++) { const c = s[j]; if (q) { if (c === q) q = ""; } else if (c === '"' || c === "'") q = c; else if (c === ">") break; }
    const raw = s.slice(lt + 1, j);
    i = j + 1;
    if (!/^\/?[A-Za-z_]/.test(raw)) { top().parts.push(decodeEntities(`<${raw}${j < s.length ? ">" : ""}`)); continue; }
    if (raw[0] === "/") {
      const name = raw.slice(1).trim().toLowerCase();
      const at = stack.map((n) => n.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    const selfClose = /\/\s*$/.test(raw);
    const body = selfClose ? raw.replace(/\/\s*$/, "") : raw;
    const name = (body.match(/^[^\s/>]+/)?.[0] ?? "").toLowerCase();
    const attrs: Record<string, string> = {};
    for (const m of body.slice(name.length).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    }
    const node: XNode = { name, attrs, children: [], parts: [] };
    top().children.push(node);
    top().parts.push(node);
    if (!selfClose && !VOID.has(name)) stack.push(node);
  }
  return doc;
}

/** Everything written inside a node (its text and its children's), in order. */
export function textOf(n: XNode): string {
  return n.parts.map((x) => (typeof x === "string" ? x : textOf(x))).join("");
}
const local = (name: string) => name.slice(name.indexOf(":") + 1);
/** The first child with this name ("title"), or with this local name when `anyNs` ("dc:date" for "date"). */
export function child(n: XNode, name: string, anyNs = false): XNode | undefined {
  return n.children.find((c) => c.name === name) ?? (anyNs ? n.children.find((c) => local(c.name) === name) : undefined);
}
export const childrenNamed = (n: XNode, name: string) => n.children.filter((c) => c.name === name || local(c.name) === name);

const BLOCK = /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|blockquote|section|article|header|footer|figure|figcaption|hr)\b[^>]*>/gi;
/** Plain text from text that may hold HTML (block tags become spaces, inline tags vanish, entities decoded, spaces collapsed). */
export function plainText(s: string): string {
  // removed until nothing is left to remove (a tag split around another one, "<scr<b>ipt>", comes back together)
  let t = s, prev: string;
  do {
    prev = t;
    t = t.replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, " ").replace(BLOCK, " ").replace(/<\/?[a-z][^>]*>/gi, "");
  } while (t !== prev);
  return decodeEntities(t).replace(/\s+/g, " ").trim();
}

/** RFC 822 / ISO dates → ISO text (the written text when it can't be read). */
export function feedDate(s: string | undefined): string | undefined {
  const t = s?.trim();
  if (!t) return undefined;
  const ms = Date.parse(t.replace(/\s(IST)$/i, " +0530"));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : t;
}

export interface FeedItem { title: string; link?: string; date?: string; summary?: string; category?: string; image?: string }
export interface Feed { kind: "rss" | "atom" | "rdf"; title?: string; items: FeedItem[] }

const clean = (o: FeedItem): FeedItem => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as unknown as FeedItem;

function rssItem(it: XNode): FeedItem {
  const t = (name: string, anyNs = false) => { const c = child(it, name, anyNs); return c ? textOf(c).trim() : undefined; };
  const atomLink = it.children.find((c) => local(c.name) === "link" && c.attrs.href)?.attrs.href;
  const img = it.children.find((c) => c.name === "enclosure" && /^image\//.test(c.attrs.type ?? "") && c.attrs.url)?.attrs.url
    ?? it.children.find((c) => (c.name === "media:content" || c.name === "media:thumbnail") && c.attrs.url)?.attrs.url
    ?? childrenNamed(it, "group").flatMap((g) => g.children).find((c) => c.attrs.url)?.attrs.url;
  const desc = t("description") ?? t("encoded", true) ?? t("summary", true);
  return clean({
    title: plainText(t("title") ?? t("title", true) ?? ""),
    link: (t("link") || atomLink || (child(it, "guid")?.attrs.ispermalink !== "false" ? t("guid") : undefined))?.trim(),
    date: feedDate(t("pubdate") ?? t("date", true) ?? t("updated", true) ?? t("published", true)),
    summary: desc ? plainText(desc) : undefined,
    category: t("category") ? plainText(t("category")!) : undefined,
    image: img,
  });
}

function atomEntry(e: XNode): FeedItem {
  const t = (name: string) => { const c = child(e, name, true); return c ? textOf(c).trim() : undefined; };
  const links = childrenNamed(e, "link");
  const link = (links.find((l) => !l.attrs.rel || l.attrs.rel === "alternate") ?? links[0])?.attrs.href;
  const img = links.find((l) => l.attrs.rel === "enclosure" && /^image\//.test(l.attrs.type ?? ""))?.attrs.href
    ?? e.children.find((c) => (c.name === "media:thumbnail" || c.name === "media:content") && c.attrs.url)?.attrs.url;
  const sum = t("summary") ?? t("content");
  const cat = childrenNamed(e, "category")[0];
  return clean({
    title: plainText(t("title") ?? ""), link, date: feedDate(t("updated") ?? t("published")),
    summary: sum ? plainText(sum) : undefined, category: cat ? cat.attrs.label || cat.attrs.term || textOf(cat).trim() : undefined, image: img,
  });
}

/** A feed's items (null when the text isn't RSS or Atom). */
export function parseFeed(xml: string): Feed | null {
  const doc = parseXml(xml);
  const root = doc.children.find((c) => c.name === "rss" || c.name === "feed" || local(c.name) === "rdf" || c.name === "channel");
  if (!root) return null;
  if (root.name === "feed" || local(root.name) === "feed") {
    const t = child(root, "title", true);
    return { kind: "atom", title: t ? plainText(textOf(t)) : undefined, items: childrenNamed(root, "entry").map(atomEntry).filter((x) => x.title || x.link) };
  }
  if (local(root.name) === "rdf") {
    const ch = child(root, "channel", true);
    const t = ch && child(ch, "title", true);
    return { kind: "rdf", title: t ? plainText(textOf(t)) : undefined, items: childrenNamed(root, "item").map(rssItem).filter((x) => x.title || x.link) };
  }
  const ch = root.name === "channel" ? root : child(root, "channel") ?? root;
  const t = child(ch, "title");
  // some feeds put items next to the channel instead of inside it
  const its = [...childrenNamed(ch, "item"), ...(ch !== root ? childrenNamed(root, "item") : [])];
  return { kind: "rss", title: t ? plainText(textOf(t)) : undefined, items: its.map(rssItem).filter((x) => x.title || x.link) };
}
