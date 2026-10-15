/**
 * The WebSocket reconnect bookkeeping in live.ts: backoff doubles up to a cap, only one reconnect is ever pending, and
 * stop() cancels a pending one so a torn-down subscription cannot reconnect a socket for the old project.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReconnector } from "../reconnect.ts";

/** Manual timers: `fire()` runs the one pending callback. */
function fakeTimers() {
  const queue = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    timers: {
      set: (fn: () => void, ms: number) => { queue.set(next, { fn, ms }); return next++; },
      clear: (id: unknown) => { queue.delete(id as number); },
    },
    get size() { return queue.size; },
    fire() {
      const [id, t] = [...queue.entries()][0]!;
      queue.delete(id);
      t.fn();
      return t.ms;
    },
  };
}

test("backs off exponentially up to the cap and resets after a good connection", () => {
  const ft = fakeTimers();
  let connects = 0;
  const r = createReconnector(() => { connects++; }, { initial: 1000, max: 15000, timers: ft.timers });
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) { r.schedule(); waits.push(ft.fire()); }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 15000, 15000]);
  assert.equal(connects, 6);
  r.reset();
  assert.equal(r.delay, 1000);
});

test("only one reconnect is pending at a time", () => {
  const ft = fakeTimers();
  let connects = 0;
  const r = createReconnector(() => { connects++; }, { timers: ft.timers });
  r.schedule();
  r.schedule();
  r.schedule();
  assert.equal(ft.size, 1);
  assert.equal(r.pending, true);
  ft.fire();
  assert.equal(connects, 1);
  assert.equal(r.pending, false);
});

test("stop() cancels the pending reconnect and refuses new ones", () => {
  const ft = fakeTimers();
  let connects = 0;
  const r = createReconnector(() => { connects++; }, { timers: ft.timers });
  r.schedule();
  assert.equal(ft.size, 1);
  r.stop();
  assert.equal(ft.size, 0, "the pending timer was cleared");
  assert.equal(r.stopped, true);
  r.schedule();
  assert.equal(ft.size, 0, "nothing is scheduled after stop()");
  assert.equal(connects, 0);
});

test("a reconnect that fires after stop() does not connect", () => {
  const ft = fakeTimers();
  let connects = 0;
  const r = createReconnector(() => { connects++; }, { timers: { set: ft.timers.set, clear: () => { /* leaky clear */ } } });
  r.schedule();
  r.stop();
  ft.fire();
  assert.equal(connects, 0);
});
