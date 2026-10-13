/**
 * News Room: the Wipe Designer, a full-window overlay opened with openWipeDesigner() (newsroom/events.ts, docs/EDITOR.md
 * §16.8). Owner: nr-wipes. This part is tiny and always mounted: it renders nothing until the `nr:wipe-designer` event
 * arrives, then loads the window itself (wipes/WipeDesigner.tsx). In development builds `?nrWipes=<stinger id>` (or
 * "new") opens it on load, for checking by eye.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import type { OpenWipeDesigner } from "../events";

const WipeDesigner = lazy(() => import("./WipeDesigner"));

export default function WipeDesignerOverlay() {
  const [req, setReq] = useState<OpenWipeDesigner | null>(null);
  useEffect(() => {
    const h = (e: Event) => setReq({ ...((e as CustomEvent<OpenWipeDesigner>).detail ?? {}) });
    window.addEventListener("nr:wipe-designer", h);
    let timer = 0;
    if (import.meta.env.DEV) {
      const id = new URLSearchParams(window.location.search).get("nrWipes");
      if (id) timer = window.setTimeout(() => setReq(id === "new" ? {} : { template: id }), 600);
    }
    return () => { window.removeEventListener("nr:wipe-designer", h); window.clearTimeout(timer); };
  }, []);
  if (!req) return null;
  return (
    <Suspense fallback={<div className="fixed inset-0 z-[60] grid place-items-center bg-bg text-xs text-dim">Opening the Wipe Designer…</div>}>
      <WipeDesigner request={req} onClose={() => setReq(null)} />
    </Suspense>
  );
}
