/**
 * A least-recently-used cache capped by bytes rather than by count (rendered generator sounds: a 600 s mono buffer at
 * 48 kHz is 115 MB, so sixteen of them were far too many). get() marks an entry as just used; set() evicts the oldest
 * until the total fits, keeping at least the entry just added. Pure: tested in node.
 */
export class ByteLru<V> {
  private m = new Map<string, { v: V; bytes: number }>();
  private used = 0;
  private budget: number;
  private sizeOf: (v: V) => number;
  private onEvict: ((v: V, key: string) => void) | null;

  constructor(budget: number, sizeOf: (v: V) => number, onEvict: ((v: V, key: string) => void) | null = null) {
    this.budget = Math.max(0, budget); this.sizeOf = sizeOf; this.onEvict = onEvict;
  }

  get(key: string): V | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    this.m.delete(key); this.m.set(key, e);
    return e.v;
  }
  has(key: string): boolean { return this.m.has(key); }

  set(key: string, v: V): void {
    const old = this.m.get(key);
    if (old) { this.used -= old.bytes; this.m.delete(key); if (old.v !== v) this.onEvict?.(old.v, key); }
    const bytes = Math.max(0, this.sizeOf(v));
    this.m.set(key, { v, bytes });
    this.used += bytes;
    for (const [k, e] of this.m) {
      if (this.used <= this.budget || this.m.size <= 1) break;
      if (k === key) continue;
      this.m.delete(k); this.used -= e.bytes;
      this.onEvict?.(e.v, k);
    }
  }

  delete(key: string): boolean {
    const e = this.m.get(key);
    if (!e) return false;
    this.m.delete(key); this.used -= e.bytes;
    this.onEvict?.(e.v, key);
    return true;
  }

  clear(): void {
    for (const [k, e] of this.m) this.onEvict?.(e.v, k);
    this.m.clear(); this.used = 0;
  }

  get bytes(): number { return this.used; }
  get size(): number { return this.m.size; }
}
