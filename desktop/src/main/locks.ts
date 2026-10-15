/**
 * The cuts this app has checked out (docs/DESKTOP.md §2.1), seen through the gateway: a 2xx to
 * `POST /api/episodes/{eid}/checkout` (or its heartbeat) means the page holds that cut, a 2xx to
 * `DELETE /api/episodes/{eid}/checkout` or `POST /api/episodes/{eid}/checkin` frees it. A lock never expires on its own, so
 * when the app quits the ones still held are released (best effort, within a few seconds), after checking that each is
 * still ours and from this machine. Electron-free; unit test: test/locks.test.ts.
 */
import type { Upstream } from "./upstream.ts";

const LOCK_PATH = /^\/api\/episodes\/(\d+)\/(checkout|checkin)(\/heartbeat)?\/?$/;

interface LockOut { lock: { mine?: boolean; machine?: string; client?: string } | null }

export class HeldLocks {
  private held = new Set<number>();

  /** Called for every answer the gateway forwards from `/api`. */
  observe(method: string, pathname: string, status: number): void {
    if (status < 200 || status >= 300) return;
    const m = LOCK_PATH.exec(pathname);
    if (!m) return;
    const eid = Number(m[1]);
    const verb = method.toUpperCase();
    const heartbeat = Boolean(m[3]);
    if (m[2] === "checkout" && verb === "POST") this.held.add(eid); // a checkout, or a heartbeat (a lock taken before this run)
    else if (m[2] === "checkout" && verb === "DELETE" && !heartbeat) this.held.delete(eid);
    else if (m[2] === "checkin" && verb === "POST") this.held.delete(eid);
  }

  list(): number[] {
    return [...this.held].sort((a, b) => a - b);
  }

  /**
   * Release every lock this app still holds: for each, GET the lock and DELETE it only when it is ours (`mine`) and from
   * this `machine` (another desktop of the same user keeps its own). Everything within `timeoutMs`; errors are logged, never
   * thrown. Returns how many were released.
   */
  async releaseAll(up: Upstream, machine: string, timeoutMs = 2500, log?: (m: string) => void): Promise<number> {
    const ids = this.list();
    if (!ids.length) return 0;
    const deadline = AbortSignal.timeout(timeoutMs);
    let released = 0;
    await Promise.all(ids.map(async (eid) => {
      try {
        const st = await up.json<LockOut>(`/api/episodes/${eid}/checkout`, { signal: deadline });
        const lk = st.lock;
        if (!lk?.mine) { this.held.delete(eid); return; } // someone else has it now (or nobody): nothing to release
        if (lk.machine && machine && lk.machine.toLowerCase() !== machine.toLowerCase()) return; // this user's other PC holds it
        const r = await up.fetch(`/api/episodes/${eid}/checkout`, { method: "DELETE", signal: deadline });
        if (r.ok) {
          released++;
          this.held.delete(eid);
          log?.(`checkout: released the cut of episode ${eid} on quit`);
        } else log?.(`checkout: episode ${eid} not released on quit (HTTP ${r.status})`);
      } catch (e) {
        log?.(`checkout: episode ${eid} not released on quit: ${(e as Error).message}`);
      }
    }));
    return released;
  }
}
