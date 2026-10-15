import { useRef, useState } from "react";
import { createBusyLatch, type BusyLatch } from "./busy";

/**
 * Guards paid or otherwise non-repeatable actions against double clicks and double effects:
 *
 *     const { busy, run } = useBusyAction();
 *     <Button loading={busy === "render"} disabled={!!busy} onClick={() => run("render", () => generate(...))} />
 *
 * `run` ignores calls while another action is in flight (the latch lives in a ref, so two clicks in the same tick are
 * still one run) and swallows rejections, because the api layer has already toasted them.
 */
export function useBusyAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const latch = useRef<BusyLatch | null>(null);
  if (!latch.current) latch.current = createBusyLatch(setBusy);
  return { busy, run: latch.current.run };
}
