/**
 * Where preview thumbnails are kept (preview-polish): a memory LRU of ImageBitmaps with a byte budget (evicted ones
 * are closed), and IndexedDB ("tatvam-preview", WebP blobs written in idle time) so the next visit and the next
 * session show cards at once. Every IndexedDB step is wrapped and timed out: a blocked, slow or private store just
 * means no disk cache (a card then renders), never a card that waits.
 */

const BUDGET = 64 * 1024 * 1024;

export class BitmapLru {
  private m = new Map<string, ImageBitmap>();
  private used = 0;
  private budget: number;
  constructor(budget = BUDGET) { this.budget = budget; }
  get(key: string): ImageBitmap | undefined {
    const b = this.m.get(key);
    if (b) { this.m.delete(key); this.m.set(key, b); }
    return b;
  }
  has(key: string) { return this.m.has(key); }
  set(key: string, b: ImageBitmap) {
    const old = this.m.get(key);
    if (old === b) return;
    if (old) { this.used -= old.width * old.height * 4; this.m.delete(key); }
    this.m.set(key, b);
    this.used += b.width * b.height * 4;
    for (const [k, v] of this.m) {
      if (this.used <= this.budget || this.m.size <= 1) break;
      this.m.delete(k); this.used -= v.width * v.height * 4;
      // a card that drew it has its own copy; a later request reads the disk cache again
      setTimeout(() => { try { v.close(); } catch { /* closed */ } }, 2000);
    }
  }
  get bytes() { return this.used; }
  get size() { return this.m.size; }
}

export const memory = new BitmapLru();

// ── IndexedDB ───────────────────────────────────────────────────────────────────────────────────────────

const DB = "tatvam-preview", STORE = "thumbs", MAX_ROWS = 3000;
let dbP: Promise<IDBDatabase | null> | null = null;
/** `p`, or `fallback` after `ms`. */
const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
function db(): Promise<IDBDatabase | null> {
  if (dbP) return dbP;
  const open = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") { resolve(null); return; }
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { try { const s = r.result.createObjectStore(STORE); s.createIndex("at", "at"); } catch { /* exists */ } };
      r.onsuccess = () => {
        const d = r.result;
        // another window upgrading or deleting the store: let it, and open again next time
        d.onversionchange = () => { try { d.close(); } catch { /* closed */ } dbP = null; };
        resolve(d);
      };
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  // an open that hangs (a pending delete elsewhere) means no disk cache for now; try again in a while
  dbP = within(open, 1500, null).then((d) => { if (!d) setTimeout(() => { dbP = null; }, 15000); return d; });
  return dbP;
}

interface Row { blob: Blob; at: number }

/** The stored picture for a key, decoded (null when there's none or the store is unavailable). */
export function diskGet(key: string): Promise<ImageBitmap | null> {
  return within(diskRead(key), 1200, null);
}
async function diskRead(key: string): Promise<ImageBitmap | null> {
  try {
    const d = await db();
    if (!d) return null;
    const row = await new Promise<Row | undefined>((resolve) => {
      try {
        const q = d.transaction(STORE, "readonly").objectStore(STORE).get(key);
        q.onsuccess = () => resolve(q.result as Row | undefined);
        q.onerror = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
    if (!row?.blob) return null;
    return await createImageBitmap(row.blob);
  } catch { return null; }
}

const writes: { key: string; bmp: ImageBitmap }[] = [];
let writing = false;
let puts = 0;

/** Stores a picture (encoded in idle time, a few at a time). */
export function diskPut(key: string, bmp: ImageBitmap) {
  if (writes.length > 200) writes.shift();
  writes.push({ key, bmp });
  if (!writing) { writing = true; idle(flush); }
}

const idle = (cb: () => void) => {
  const g = globalThis as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (typeof g.requestIdleCallback === "function") g.requestIdleCallback(cb, { timeout: 3000 }); else setTimeout(cb, 200);
};

async function encode(bmp: ImageBitmap): Promise<Blob | null> {
  try {
    if (typeof OffscreenCanvas === "undefined") return null;
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    return await c.convertToBlob({ type: "image/webp", quality: 0.86 });
  } catch { return null; }
}

async function flush() {
  try {
    const d = await db();
    if (!d) { writes.length = 0; return; }
    for (let i = 0; i < 4 && writes.length; i++) {
      const w = writes.shift()!;
      const blob = await encode(w.bmp);
      if (!blob) continue;
      try { d.transaction(STORE, "readwrite").objectStore(STORE).put({ blob, at: Date.now() } satisfies Row, w.key); } catch { /* quota, closed */ }
      if (++puts % 200 === 0) void prune(d);
    }
  } finally {
    if (writes.length) idle(flush); else writing = false;
  }
}

/** Keeps the newest MAX_ROWS pictures. */
async function prune(d: IDBDatabase) {
  try {
    const st = d.transaction(STORE, "readwrite").objectStore(STORE);
    const count = await new Promise<number>((r) => { const q = st.count(); q.onsuccess = () => r(q.result); q.onerror = () => r(0); });
    let extra = count - MAX_ROWS;
    if (extra <= 0) return;
    const cur = st.index("at").openCursor();
    cur.onsuccess = () => { const c = cur.result; if (!c || extra-- <= 0) return; c.delete(); c.continue(); };
  } catch { /* fine */ }
}
