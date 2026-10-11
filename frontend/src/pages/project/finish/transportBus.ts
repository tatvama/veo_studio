/**
 * Ties a timeline transport (production/timeline/transport.ts) to the cross-window bus (lib/bus.ts):
 * - publishes the playhead (~10 per second, plus every play / pause) and the selected shot,
 * - follows `seek` messages, and the playhead of another window while this one isn't the one playing,
 * - picks up a seek sent just before it mounted (a review note clicked on another page).
 *
 * `follow: "seek"` (the timeline) moves the playhead along with the other window; `follow: "play"` (the program monitor)
 * plays along with it, correcting drift. The returned `user` transport is what the window's own controls should use:
 * any action there makes this window the active transport again.
 */
import { useEffect, useMemo, useRef } from "react";
import { lastOf, publish, throttle, useBus, useBusSource } from "../../../lib/bus";
import type { Transport } from "../production/timeline/transport";

export function useTransportBus(eid: number, tp: Transport, opts: { sel?: number | null; total: number; follow?: "seek" | "play" }) {
  const src = useBusSource();
  const playing = useRef(tp.playing);
  playing.current = tp.playing;
  /** The last time we moved to because another window said so (not news to send back). */
  const remoteT = useRef<number | null>(null);
  /** Playing because another window is playing (follow: "play"). */
  const following = useRef(false);
  /** The next play/pause change was caused by following: don't announce it. */
  const quiet = useRef(false);
  const mounted = useRef(false);
  const tpRef = useRef(tp);
  tpRef.current = tp;

  // playhead out
  useEffect(() => {
    if (!eid) return;
    const send = throttle((t: number) => publish({ type: "playhead", eid, t, playing: playing.current }, src), 100);
    let last = -1;
    return tp.clock.subscribe(() => {
      const t = tp.clock.get();
      if (Math.abs(t - last) < 1e-4) return;
      last = t;
      if (following.current) return;
      if (remoteT.current !== null && Math.abs(t - remoteT.current) < 1e-3) return;
      send(t);
    });
  }, [eid, tp.clock, src]);
  useEffect(() => {
    if (!mounted.current || !eid) return;
    if (quiet.current) { quiet.current = false; return; }
    if (following.current) return;
    publish({ type: "playhead", eid, t: tp.clock.get(), playing: tp.playing }, src);
  }, [tp.playing]);

  // selection out (not on mount: a window opening shouldn't clear the others' selection)
  useEffect(() => {
    if (!mounted.current || !eid || opts.sel === undefined) return;
    publish({ type: "select", eid, shotId: opts.sel }, src);
  }, [opts.sel]);
  useEffect(() => { mounted.current = true; }, []);

  // seek in
  useBus("seek", (m) => {
    remoteT.current = null;
    tpRef.current.seek(m.t);
  }, { eid, self: src });

  // another window's playhead
  const lastFollow = useRef(0);
  useBus("playhead", (m) => {
    const p = tpRef.current;
    if (p.playing && !following.current) return;  // this window is the active transport
    if (opts.follow === "play") {
      if (m.playing) {
        if (!p.playing) { following.current = true; quiet.current = true; p.play(); }
        if (Math.abs(p.clock.get() - m.t) > 0.3) { remoteT.current = m.t; p.seek(m.t); }
      } else {
        if (p.playing) { quiet.current = true; p.pause(); }
        following.current = false;
        remoteT.current = m.t;
        p.seek(m.t);
      }
      return;
    }
    // "seek": move the playhead along (at most 4 times a second while the other window plays)
    const now = Date.now();
    if (m.playing && now - lastFollow.current < 250) return;
    lastFollow.current = now;
    remoteT.current = m.t;
    p.seek(m.t);
  }, { eid, self: src });

  // a seek that arrived just before this transport mounted
  const pending = useRef(eid ? lastOf("seek", eid, 8000) : null);
  useEffect(() => {
    if (pending.current && opts.total > 0) {
      remoteT.current = null;
      tpRef.current.seek(pending.current.t);
      pending.current = null;
    }
  }, [opts.total]);

  /** The transport for this window's own controls: using it takes over from whichever window was leading. */
  const user = useMemo((): Transport => {
    const take = () => { following.current = false; remoteT.current = null; quiet.current = false; };
    return {
      ...tp,
      seek: (t) => { take(); tp.seek(t); },
      play: () => { take(); tp.play(); },
      pause: () => { take(); tp.pause(); },
      toggle: () => { const wasFollowing = following.current; take(); if (wasFollowing) tp.pause(); else tp.toggle(); },
      shuttle: (d) => { take(); tp.shuttle(d); },
      step: (f) => { take(); tp.step(f); },
      jump: (d) => { take(); tp.jump(d); },
    };
  }, [tp]);

  return { src, user, following };
}
