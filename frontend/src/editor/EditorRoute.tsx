/**
 * /editor/edit?path=<.tatvamedit> (opens the edit through the bridge) and /editor/edit?demo=1 (the in-memory demo,
 * also in a plain browser).
 */
import { Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "../components/ui";
import { editorBridge } from "../lib/desktop";
import { registerCustomSources } from "./demoSources";
import { DesktopOnly } from "./EditorHome";
import { parseProject } from "./model/serialize";
import { loadShaders, resolveLutUrls, resolveUrls } from "./session";
import { loadProject } from "./store";

const EditorApp = lazy(() => import("./EditorApp"));

type State = { kind: "loading" } | { kind: "ready"; key: string } | { kind: "error"; message: string } | { kind: "desktop" };

export default function EditorRoute() {
  const [params] = useSearchParams();
  const path = params.get("path");
  const demo = params.get("demo") === "1";
  const [st, setSt] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    setSt({ kind: "loading" });
    (async () => {
      if (demo) {
        const { makeDemo } = await import("./demo");
        const d = await makeDemo();
        if (!alive) return;
        registerCustomSources(d.sources);
        loadProject(d.project, { path: null, demo: true, urls: d.urls });
        setSt({ kind: "ready", key: "demo" });
        return;
      }
      const b = editorBridge();
      if (!b) { setSt({ kind: "desktop" }); return; }
      if (!path) { setSt({ kind: "error", message: "No edit was given to open." }); return; }
      const r = await b.open(path);
      if (!alive) return;
      if (!r) { setSt({ kind: "error", message: "The edit couldn't be opened." }); return; }
      const { project, warnings } = parseProject(r.project);
      loadProject(project, { path: r.path });
      for (const w of warnings.slice(0, 3)) toast.warning(w);
      void resolveUrls();
      void resolveLutUrls();
      await loadShaders();
      setSt({ kind: "ready", key: r.path });
    })().catch((e) => { if (alive) setSt({ kind: "error", message: (e as Error).message ?? String(e) }); });
    return () => { alive = false; };
  }, [path, demo]);

  if (st.kind === "desktop") return <DesktopOnly />;
  if (st.kind === "error") {
    return (
      <div className="fixed inset-0 grid place-items-center bg-bg p-6 text-center">
        <div className="space-y-3">
          <p className="font-medium">{st.message}</p>
          <Link to="/editor"><Button>Back to the editor home</Button></Link>
        </div>
      </div>
    );
  }
  const spinner = <div className="fixed inset-0 grid place-items-center bg-bg text-mute"><Loader2 className="size-5 animate-spin" /></div>;
  if (st.kind === "loading") return spinner;
  return <Suspense fallback={spinner}><EditorApp key={st.key} /></Suspense>;
}
