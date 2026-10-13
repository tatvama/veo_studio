/**
 * The News Room's full-window tools, mounted once in EditorApp (docs/EDITOR.md §16.8). Owner: lead. Each loads lazily.
 */
import { lazy, Suspense } from "react";

const DesignerOverlay = lazy(() => import("./designer/DesignerOverlay"));
const WipeDesignerOverlay = lazy(() => import("./wipes/WipeDesignerOverlay"));

export function NewsroomOverlays() {
  return (
    <Suspense fallback={null}>
      <DesignerOverlay />
      <WipeDesignerOverlay />
    </Suspense>
  );
}
