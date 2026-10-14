/**
 * News Room: the Template Designer, a full-window overlay opened with openDesigner() (newsroom/events.ts, docs/EDITOR.md
 * §16.8). Owner: nr-designer. This part is tiny and always mounted: it waits for the `nr:designer` event and loads the
 * Designer itself (designer/Designer.tsx) only when asked. In development builds `?nrDesigner=<template id>` (or
 * "sample" / "new") opens it on load, for checking by eye.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import type { OpenDesigner } from "../events";

const Designer = lazy(() => import("./Designer"));

export default function DesignerOverlay() {
  const [req, setReq] = useState<OpenDesigner | null>(null);
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent<OpenDesigner>).detail; if (d?.template) setReq({ ...d }); };
    window.addEventListener("nr:designer", h);
    let timer = 0;
    if (import.meta.env.DEV) {
      const id = new URLSearchParams(window.location.search).get("nrDesigner");
      if (id) timer = window.setTimeout(() => setReq({ template: id }), 600);
    }
    return () => { window.removeEventListener("nr:designer", h); window.clearTimeout(timer); };
  }, []);
  if (!req) return null;
  return (
    <Suspense fallback={<div className="fixed inset-0 z-[60] grid place-items-center bg-bg text-xs text-dim">Opening the Designer…</div>}>
      <Designer request={req} onClose={() => setReq(null)} />
    </Suspense>
  );
}
