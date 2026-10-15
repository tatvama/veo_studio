/**
 * A reference-counted cache of values that load asynchronously, keyed by string (demuxed MP4s, frames grabbed for
 * analysis). acquire() loads a key once and counts a user; release() lets go. An entry nobody holds is dropped and
 * its value disposed at once, or, with `keep`, stays as one of the most recently released few (a small LRU) for the
 * next acquire. A load that fails is forgotten, so the next acquire tries again. Pure (no DOM): tested in node.
 */
interface Entry<T> { p: Promise<T>; refs: number }

export class RefCache<T> {
  private m = new Map<string, Entry<T>>();
  /** Released, still cached entries, the oldest first. */
  private idle: string[] = [];
  private loader: (key: string) => Promise<T>;
  private disposer: (v: T) => void;
  private keep: number;

  constructor(load: (key: string) => Promise<T>, dispose: (v: T) => void = () => undefined, keep = 0) {
    this.loader = load; this.disposer = dispose; this.keep = Math.max(0, keep);
  }

  /** The value for `key` (loaded once), counted as held until release(key). */
  acquire(key: string): Promise<T> {
    let e = this.m.get(key);
    if (!e) {
      const p = this.loader(key);
      const entry: Entry<T> = { p, refs: 0 };
      e = entry;
      this.m.set(key, entry);
      p.catch(() => { if (this.m.get(key) === entry) { this.m.delete(key); this.unidle(key); } });
    } else if (e.refs === 0) this.unidle(key);
    e.refs++;
    return e.p;
  }

  /** One user fewer; at zero the entry is kept as one of `keep` idle ones, or disposed. */
  release(key: string): void {
    const e = this.m.get(key);
    if (!e || e.refs <= 0) return;
    if (--e.refs > 0) return;
    if (this.keep > 0) {
      this.idle.push(key);
      while (this.idle.length > this.keep) this.drop(this.idle.shift()!);
    } else this.drop(key);
  }

  /** Current holders of a key (0 when idle or unknown). */
  refs(key: string): number { return this.m.get(key)?.refs ?? 0; }
  has(key: string): boolean { return this.m.has(key); }
  /** Entries cached (held or idle). */
  get size(): number { return this.m.size; }
  /** Idle (released, kept) entries. */
  get idleCount(): number { return this.idle.length; }

  /** Drops every entry (disposing the values once loaded), held ones too. */
  clear(): void {
    for (const k of [...this.m.keys()]) this.drop(k);
    this.idle.length = 0;
  }

  private unidle(key: string) {
    const i = this.idle.indexOf(key);
    if (i >= 0) this.idle.splice(i, 1);
  }

  private drop(key: string) {
    const e = this.m.get(key);
    if (!e) return;
    this.m.delete(key);
    e.p.then((v) => this.disposer(v)).catch(() => undefined);
  }
}
