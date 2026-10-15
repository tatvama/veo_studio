/**
 * The render-target pool's bookkeeping (pure, no GL: the WebGL2 backend allocates and deletes through callbacks):
 * free targets by size key, every target alive, and the ones handed out since the last tick (a frame). A frame that
 * throws half-way (a shader that fails to compile, an incomplete framebuffer) leaves its targets unreleased; the
 * renderer then calls reclaim() with the targets it keeps on purpose (histories, mattes) and the rest go back to the
 * free lists instead of leaking once per failed frame.
 */
export interface Pooled { readonly key: string; used: number }

export class TargetPool<T extends Pooled> {
  private free = new Map<string, T[]>();
  private alive = new Set<T>();
  private lent = new Set<T>();
  private tickNo = 0;

  /** The current frame number. */
  get tick(): number { return this.tickNo; }
  /** Every target alive (free or handed out). */
  get size(): number { return this.alive.size; }
  /** Targets waiting in the free lists. */
  get freeCount(): number { let n = 0; for (const l of this.free.values()) n += l.length; return n; }
  /** Targets handed out since the last tick and not released. */
  get lentCount(): number { return this.lent.size; }

  /** A free target of this key, marked as used this frame (null: allocate one and add() it). */
  take(key: string): T | null {
    const list = this.free.get(key);
    if (!list?.length) return null;
    const t = list.pop()!;
    t.used = this.tickNo;
    this.lent.add(t);
    return t;
  }

  /** A freshly allocated target, handed out now. */
  add(t: T): T {
    t.used = this.tickNo;
    this.alive.add(t);
    this.lent.add(t);
    return t;
  }

  /** Back to the free list (false: not one of ours, or already free). */
  release(t: T | null | undefined): boolean {
    if (!t || !this.alive.has(t)) return false;
    this.lent.delete(t);
    const list = this.free.get(t.key) ?? [];
    if (list.includes(t)) return false;
    list.push(t);
    this.free.set(t.key, list);
    return true;
  }

  /** A new frame: what was handed out before is the previous frame's business. */
  nextTick(): void { this.tickNo++; this.lent.clear(); }

  /** Releases what was handed out since the last tick and not released, except what `keep` holds. Returns how many. */
  reclaim(keep?: Iterable<T | null | undefined>): number {
    const kept = new Set<T>();
    if (keep) for (const k of keep) if (k) kept.add(k);
    let n = 0;
    for (const t of [...this.lent]) { if (kept.has(t)) continue; if (this.release(t)) n++; }
    return n;
  }

  /** Frees pooled targets not handed out in the last `age` ticks (sizes that came and went). */
  trimOld(age: number, del: (t: T) => void): void {
    for (const [k, list] of this.free) {
      const keep = list.filter((t) => this.tickNo - t.used <= age);
      for (const t of list) if (!keep.includes(t)) { del(t); this.alive.delete(t); }
      if (keep.length) this.free.set(k, keep); else this.free.delete(k);
    }
  }

  /** Frees every pooled target nobody holds. */
  trimFree(del: (t: T) => void): void {
    for (const list of this.free.values()) for (const t of list) { del(t); this.alive.delete(t); }
    this.free.clear();
  }

  /** Forgets everything (deleting each alive target through `del` when given; a lost context has none to delete). */
  clear(del?: (t: T) => void): void {
    if (del) for (const t of this.alive) del(t);
    this.alive.clear(); this.free.clear(); this.lent.clear();
  }
}
