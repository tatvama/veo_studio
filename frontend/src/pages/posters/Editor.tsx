/** Poster Studio editor page (/posters/:id): toolbar, left panel, canvas with its bottom bar, right panel. */
import { useQueryClient } from "@tanstack/react-query";
import { FileQuestion, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button, Empty, Skeleton, useDocumentTitle } from "../../components/ui";
import { ApiError, api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { useAuthStatus } from "../../lib/queries";
import { ROLE_RANK } from "../../lib/types";
import "../../styles/posters.css";
import { designKeys, useDesign, useJobWatcher } from "./api";
import { BottomBar } from "./canvas/editor/BottomBar";
import { Toolbar } from "./canvas/editor/Toolbar";
import { useAutosave } from "./canvas/editor/useAutosave";
import { EditorCanvas } from "./canvas/Stage";
import LeftPanel from "./panels/LeftPanel";
import RightPanel from "./panels/RightPanel";
import { useEditor } from "./store";
import type { Design } from "./types";

export default function PosterEditor() {
  const t = useT();
  const { id } = useParams();
  const designId = Number(id) || 0;
  const q = useDesign(designId);
  const loaded = useEditor((s) => s.design?.id === designId);
  const title = useEditor((s) => (s.design?.id === designId ? s.design.title : ""));
  useDocumentTitle(title || t("Poster"));

  useEffect(() => {
    if (q.data && q.data.id === designId && useEditor.getState().design?.id !== designId) useEditor.getState().load(q.data);
  }, [q.data, designId, loaded]);

  if (!designId || (q.isError && q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400))) {
    return (
      <div className="grid h-full place-items-center p-6">
        <Empty icon={<FileQuestion className="size-6" />} title={t("Design not found")} sub={t("It may have been archived, or the link is wrong.")}
          action={<Link to="/posters"><Button variant="primary">{t("Back to posters")}</Button></Link>} />
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="grid h-full place-items-center p-6">
        <Empty icon={<TriangleAlert className="size-6" />} title={t("Couldn't open this design")} sub={q.error instanceof Error ? q.error.message : undefined}
          action={<Button icon={<RefreshCw className="size-4" />} onClick={() => void q.refetch()}>{t("Try again")}</Button>} />
      </div>
    );
  }
  if (!q.data || !loaded) return <EditorSkeleton />;
  return <EditorBody designId={designId} />;
}

function useMedia(q: string): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(q); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia(q).matches,
    () => false,
  );
}

function EditorSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy="true">
      <div className="flex h-12 items-center gap-3 border-b border-line bg-panel px-3">
        <Skeleton className="size-8" /><Skeleton className="h-5 w-48" /><div className="flex-1" /><Skeleton className="h-7 w-40" /><Skeleton className="h-7 w-24" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-80 shrink-0 space-y-3 border-r border-line bg-panel p-3 max-lg:hidden">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-20" />)}
        </div>
        <div className="pst-workspace grid min-w-0 flex-1 place-items-center"><Skeleton className="aspect-[4/5] h-[70%] rounded-sm" /></div>
        <div className="w-80 shrink-0 space-y-3 border-l border-line bg-panel p-3 max-xl:hidden">
          {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14" />)}
        </div>
      </div>
    </div>
  );
}

function EditorBody({ designId }: { designId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const auth = useAuthStatus();
  const role = auth.data?.user?.role ?? "viewer";
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.creator;
  const canApprove = ROLE_RANK[role] >= ROLE_RANK.producer;
  const projectId = useEditor((s) => s.design?.project_id ?? null);
  const save = useEditor((s) => s.save);
  const { saveNow, flushOnLeave, thumbnail } = useAutosave(designId);
  const [resolving, setResolving] = useState<"theirs" | "mine" | null>(null);
  // narrow screens: the tools float over the canvas and the properties open as a drawer
  const narrow = useMedia("(max-width: 1099px)");
  const [propsOpen, setPropsOpen] = useState(false);
  useEffect(() => { if (!narrow) setPropsOpen(false); }, [narrow]);

  useJobWatcher();

  // leaving: save what's pending, then clear the editor
  const leave = useRef(flushOnLeave);
  leave.current = flushOnLeave;
  useEffect(() => () => { leave.current(); useEditor.getState().reset(); }, [designId]);

  // designs that never had a thumbnail get one shortly after opening
  useEffect(() => {
    if (useEditor.getState().design?.thumb_url || !canEdit) return;
    thumbnail();
  }, [designId, canEdit, thumbnail]);

  // Ctrl/⌘+S saves now, from anywhere in the editor
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        const s = useEditor.getState().save;
        if (s === "conflict") { toast.warning(t("Resolve the conflict first: load their version or keep yours.")); return; }
        if (s === "saved" || s === "idle") { toast.success(t("All changes saved"), { duration: 1400 }); return; }
        void saveNow(s === "error").then((ok) => { if (ok) toast.success(t("Saved"), { duration: 1200 }); });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [saveNow, t]);

  const loadTheirs = useCallback(async () => {
    setResolving("theirs");
    try {
      const fresh = await api.get<Design>(`/api/designs/${designId}`);
      qc.setQueryData(designKeys.one(designId), fresh);
      useEditor.getState().load(fresh);
      toast.success(t("Loaded the latest version"));
    } catch { /* shown by the API layer */ } finally { setResolving(null); }
  }, [designId, qc, t]);

  const keepMine = useCallback(async () => {
    setResolving("mine");
    try {
      if (await saveNow(true)) toast.success(t("Your version was saved"));
    } finally { setResolving(null); }
  }, [saveNow, t]);

  const backTo = projectId ? `/p/${projectId}/posters` : "/posters";

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <Toolbar designId={designId} backTo={backTo} saveNow={saveNow} canEdit={canEdit} canApprove={canApprove}
        propsToggle={narrow ? { open: propsOpen, toggle: () => setPropsOpen((v) => !v) } : undefined} />
      {save === "conflict" && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-warn/30 bg-warn/10 px-4 py-2 text-sm">
          <TriangleAlert className="size-4 shrink-0 text-warn" />
          <p className="min-w-0 flex-1">
            <span className="font-medium">{t("Someone else saved this design while you were editing.")}</span>{" "}
            <span className="text-mute">{t("Choose which version to keep.")}</span>
          </p>
          <Button size="sm" variant="secondary" loading={resolving === "theirs"} onClick={() => void loadTheirs()}>{t("Load their version")}</Button>
          <Button size="sm" variant="primary" loading={resolving === "mine"} onClick={() => void keepMine()}>{t("Keep mine")}</Button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        {narrow ? (
          <div className="absolute inset-y-0 left-0 z-30 flex shadow-pop"><LeftPanel designId={designId} projectId={projectId} /></div>
        ) : <LeftPanel designId={designId} projectId={projectId} />}
        <div className={cn("flex min-w-0 flex-1 flex-col", narrow && "pl-14")}>
          <EditorCanvas designId={designId} />
          <BottomBar />
        </div>
        {!narrow && <RightPanel designId={designId} />}
        {narrow && propsOpen && (
          <div className="absolute inset-y-0 right-0 z-30 flex max-w-[calc(100%-3.5rem)] shadow-pop"><RightPanel designId={designId} /></div>
        )}
      </div>
    </div>
  );
}
