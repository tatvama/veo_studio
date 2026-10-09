/** Poster Studio API client, queries and the AI job watcher. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import type { SubmitResult } from "../../lib/types";
import { getExporter } from "./canvas/exporter";
import { newPendingImage, uid } from "./doc";
import { useEditor } from "./store";
import type { AiKind, Design, DesignDoc, ImageLayer, Role } from "./types";

export interface DesignExport { id: number; design_id: number; kind: string; url: string; width: number; height: number; bytes: number; created_at: string }
export interface DesignVersionRow { id: number; note: string; width: number; height: number; thumb_url: string; created_at: string; created_by: number | null }
export interface UploadResult { asset: string; src: string; width: number; height: number; name: string }
export interface JobStatus { id: number; status: string; progress: number; message: string; error: string; label: string;
  result: { asset?: string; src?: string; width?: number; height?: number; layer_id?: string; kind?: AiKind; engine?: string;
    face_match?: number | null; prompt?: string; cutout?: boolean } }
export interface AiImageBody {
  kind: AiKind; prompt?: string; style?: string; layer_id?: string; character_id?: number | null; outfit?: string; pose?: string;
  cutout?: boolean; source_asset?: string; ref_assets?: string[]; aspect?: string; width?: number; height?: number; count?: number;
}
export interface BriefPlan { template: string; title: string; tagline: string; credits: string; cta: string; badge: string;
  background_prompt: string; palette: string[]; style: string }

export const designKeys = {
  list: (projectId?: number | null, q = "", archived = false) => ["designs", projectId ?? "all", q, archived] as const,
  one: (id: number) => ["design", id] as const,
};

export const useDesigns = (projectId?: number | null, q = "", archived = false) => useQuery({
  queryKey: designKeys.list(projectId, q, archived),
  queryFn: () => api.get<Design[]>(`/api/designs?${new URLSearchParams({
    ...(projectId ? { project_id: String(projectId) } : {}), ...(q ? { q } : {}), ...(archived ? { archived: "true" } : {}) })}`),
});

export const useDesign = (id: number) => useQuery({
  queryKey: designKeys.one(id), queryFn: () => api.get<Design>(`/api/designs/${id}`), enabled: !!id, staleTime: Infinity, refetchOnWindowFocus: false,
});

export const useExports = (id: number) => useQuery({ queryKey: ["design-exports", id], queryFn: () => api.get<DesignExport[]>(`/api/designs/${id}/exports`), enabled: !!id });
export const useVersions = (id: number) => useQuery({ queryKey: ["design-versions", id], queryFn: () => api.get<DesignVersionRow[]>(`/api/designs/${id}/versions`), enabled: !!id });

const blobFile = (b: Blob, name: string) => new File([b], name, { type: b.type || "image/png" });

export const designsApi = {
  create: (body: { title?: string; format: string; width: number; height: number; project_id?: number | null; template?: string;
    brand_kit_id?: number | null; doc?: DesignDoc }) => api.post<Design>("/api/designs", body),
  save: (id: number, patch: Partial<Pick<Design, "title" | "format" | "width" | "height" | "status" | "project_id" | "brand_kit_id">> & {
    doc?: DesignDoc; base_revision?: number; force?: boolean }) =>
    api.put<{ id: number; revision: number; updated_at: string }>(`/api/designs/${id}`, patch, { silent: true }),
  duplicate: (id: number) => api.post<Design>(`/api/designs/${id}/duplicate`),
  archive: (id: number, restore = false) => api.del<{ ok: boolean }>(`/api/designs/${id}${restore ? "?restore=true" : ""}`),
  upload: (id: number, file: File) => api.upload<UploadResult>(`/api/designs/${id}/upload`, file),
  thumbnail: (id: number, blob: Blob) => api.upload<{ thumb_url: string }>(`/api/designs/${id}/thumbnail`, blobFile(blob, "thumb.png")),
  exportFile: (id: number, blob: Blob, kind: "png" | "jpg" | "webp" | "pdf") => {
    const fd = new FormData();
    fd.append("file", blobFile(blob, "render.png"));
    fd.append("kind", kind);
    return api.post<DesignExport>(`/api/designs/${id}/export`, fd);
  },
  saveVersion: (id: number, note: string) => api.post<{ id: number; note: string }>(`/api/designs/${id}/versions`, { note }),
  restore: (id: number, vid: number) => api.post<Design>(`/api/designs/${id}/versions/${vid}/restore`),
  aiImage: (id: number, body: AiImageBody) => api.post<SubmitResult>(`/api/designs/${id}/ai/image`, body),
  jobStatus: (ids: number[]) => api.get<JobStatus[]>(`/api/designs/jobs/status?ids=${ids.join(",")}`, { silent: true }),
  aiCopy: (body: { kind: string; context?: string; project_id?: number | null; language?: string; tone?: string; n?: number }) =>
    api.post<{ suggestions: string[] }>("/api/designs/ai/copy", body),
  aiBrief: (body: { brief: string; format: string; project_id?: number | null; language?: string }) =>
    api.post<BriefPlan>("/api/designs/ai/brief", body),
};

/** Poll the AI jobs the editor is waiting for and drop their images into the right layers. Mount once in the editor. */
export function useJobWatcher() {
  const jobs = useEditor((s) => s.jobs);
  const qc = useQueryClient();
  const ids = Object.keys(jobs).map(Number);
  const key = ids.sort().join(",");
  useEffect(() => {
    if (!ids.length) return;
    let stop = false;
    const tick = async () => {
      try {
        const rows = await designsApi.jobStatus(ids);
        const st = useEditor.getState();
        for (const j of rows) {
          if (j.status === "succeeded" && j.result.src && j.result.asset) {
            st.applyJobResult(j.id, { src: j.result.src, asset: j.result.asset, width: j.result.width ?? 1024, height: j.result.height ?? 1024,
              engine: j.result.engine, face_match: j.result.face_match, prompt: j.result.prompt });
            if (j.result.face_match != null && j.result.face_match < 0.45) toast.warning("The face doesn't match the character closely. Try another take.");
          } else if (["failed", "cancelled"].includes(j.status)) {
            st.failJob(j.id, j.error);
            if (j.status === "failed") toast.error(`AI image failed: ${j.error || "unknown error"}`);
          } else if (j.status === "awaiting_approval") {
            /* stays pending until a producer approves; the shimmer keeps showing */
          }
        }
        qc.invalidateQueries({ queryKey: ["jobs"] });
      } catch { /* network blip: try again next tick */ }
      if (!stop) timer = window.setTimeout(tick, 2000);
    };
    let timer = window.setTimeout(tick, 1500);
    return () => { stop = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/**
 * Start an AI image for a layer. With no `layerId`, a new placeholder layer is added (backgrounds go to the bottom and
 * cover the page; characters, products and elements go in the middle). Returns false when the request was refused.
 */
export async function runAi(designId: number, body: AiImageBody & { layerId?: string; role?: Role; name?: string }): Promise<boolean> {
  const st = useEditor.getState();
  let layerId = body.layerId;
  const W = st.width, H = st.height;
  if (!layerId) {
    const role: Role = body.role ?? (body.kind === "background" ? "background" : body.kind === "character" ? "character"
      : body.kind === "product" ? "product" : "decor");
    const rect = role === "background" ? { x: 0, y: 0, width: W, height: H }
      : role === "character" ? { x: Math.round(W * 0.2), y: Math.round(H * 0.22), width: Math.round(W * 0.6), height: Math.round(H * 0.72) }
      : { x: Math.round(W * 0.3), y: Math.round(H * 0.3), width: Math.round(W * 0.4), height: Math.round(H * 0.4) };
    const layer = newPendingImage(body.kind, rect, role, body.name ?? (role === "background" ? "AI background" : role === "character" ? "AI character" : "AI image"));
    layer.id = uid("i");
    layer.ai = { kind: body.kind, prompt: body.prompt ?? "", style: body.style, characterId: body.character_id ?? null, outfit: body.outfit, pose: body.pose };
    st.addLayers([layer], { index: role === "background" ? 0 : undefined });
    layerId = layer.id;
  } else {
    const l = st.doc.layers.find((x) => x.id === layerId) as ImageLayer | undefined;
    if (l) st.patchLayer(layerId, { ai: { kind: body.kind, prompt: body.prompt ?? "", style: body.style, characterId: body.character_id ?? null,
      outfit: body.outfit, pose: body.pose } } as Partial<ImageLayer>);
  }
  const layer = useEditor.getState().doc.layers.find((x) => x.id === layerId)!;
  try {
    const res = await designsApi.aiImage(designId, { ...body, layer_id: layerId, width: body.width ?? layer.width, height: body.height ?? layer.height });
    const jobIds = res.jobs.map((j) => j.id);
    if (!jobIds.length) throw new Error("nothing was queued");
    useEditor.getState().trackJobs(jobIds, layerId, body.kind);
    if (res.status === "awaiting_approval") toast.info("Waiting for a producer to approve the spend", { description: res.reason });
    return true;
  } catch {
    // remove an empty placeholder we created for nothing
    const l = useEditor.getState().doc.layers.find((x) => x.id === layerId) as ImageLayer | undefined;
    if (l && !l.src && !body.layerId) useEditor.getState().removeLayers([layerId]);
    return false;
  }
}

/**
 * Relight the whole poster with AI: render everything except text, send it as the source image, and put the result
 * in as a new full-page background (the merged image layers are hidden, not deleted, so undo and comparison work).
 */
export async function harmonize(designId: number, prompt = "", style = ""): Promise<boolean> {
  const exporter = getExporter();
  if (!exporter) return false;
  const st = useEditor.getState();
  const blob = await exporter.render({ hideTypes: ["text"], maxSide: 2048, mime: "image/png" });
  const up = await designsApi.upload(designId, blobFile(blob, "relight-source.png"));
  const merged = st.doc.layers.filter((l) => l.type !== "text" && l.visible && !(l.type === "effect" && l.effect === "grain")).map((l) => l.id);
  const ok = await runAi(designId, { kind: "harmonize", prompt, style, source_asset: up.asset, role: "background", name: "Relit composite",
    width: st.width, height: st.height });
  if (ok) {
    const s = useEditor.getState();
    const added = s.doc.layers.find((l) => l.type === "image" && l.name === "Relit composite" && l.pending);
    const patches: Record<string, { visible: boolean }> = {};
    merged.forEach((id) => { patches[id] = { visible: false }; });
    s.patchLayers(patches);
    // keep the relit image above the hidden originals but under the lettering
    if (added) {
      const firstText = s.doc.layers.findIndex((l) => l.type === "text");
      const from = s.doc.layers.findIndex((l) => l.id === added.id);
      if (firstText > 0) s.reorder(from, Math.max(0, firstText - 1));
    }
  }
  return ok;
}
