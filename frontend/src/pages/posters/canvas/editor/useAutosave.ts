/**
 * Autosave for the poster editor: every document change bumps `store.rev`; ~1.5 s after the last one the design is
 * saved with the revision it started from, so a teammate's newer save comes back as a 409 conflict instead of being
 * overwritten. Saves run one at a time. After a save, a thumbnail is rendered and uploaded (at most every 15 s).
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { ApiError } from "../../../../lib/api";
import { designKeys, designsApi } from "../../api";
import { useEditor } from "../../store";
import type { Design } from "../../types";
import { effectiveFormat } from "../commands";
import { getExporter } from "../exporter";

const DEBOUNCE = 1500;
const THUMB_EVERY = 15_000;

export function useAutosave(designId: number) {
  const qc = useQueryClient();
  const rev = useEditor((s) => s.rev);
  const save = useEditor((s) => s.save);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef(0);
  const thumbTimer = useRef(0);
  const lastThumb = useRef(0);
  const alive = useRef(true);

  /** Keep the cached design in step with what the server now holds, so reopening the editor starts from it. */
  const syncCache = useCallback((revision: number) => {
    const st = useEditor.getState();
    if (!st.design) return;
    const d = st.design;
    qc.setQueryData<Design>(designKeys.one(designId), (old) => ({ ...(old ?? d), ...d, revision, width: st.width, height: st.height, doc: st.doc }));
  }, [qc, designId]);

  const thumbnail = useCallback(() => {
    if (thumbTimer.current) return;
    const wait = Math.max(1500, lastThumb.current + THUMB_EVERY - Date.now());
    thumbTimer.current = window.setTimeout(async () => {
      thumbTimer.current = 0;
      const ex = getExporter();
      if (!ex || !alive.current) return;
      lastThumb.current = Date.now();
      try {
        const blob = await ex.render({ maxSide: 720, mime: "image/jpeg", quality: 0.86 });
        const r = await designsApi.thumbnail(designId, blob);
        qc.setQueryData<Design>(designKeys.one(designId), (old) => (old ? { ...old, thumb_url: r.thumb_url } : old));
        void qc.invalidateQueries({ queryKey: ["designs"] });
      } catch { /* a thumbnail is a nicety; the next save tries again */ }
    }, wait);
  }, [qc, designId]);

  const doSave = useCallback(async (force: boolean): Promise<boolean> => {
    const st = useEditor.getState();
    const d = st.design;
    if (!d || d.id !== designId) return true;
    if (!force && st.save !== "dirty" && st.save !== "error") return st.save !== "conflict";
    const rev0 = st.rev;
    st.setSave("saving");
    try {
      const r = await designsApi.save(designId, {
        title: d.title, format: effectiveFormat(d.format, st.width, st.height).key, width: st.width, height: st.height, status: d.status, template: d.template, brand_kit_id: d.brand_kit_id, doc: st.doc,
        base_revision: d.revision, ...(force ? { force: true } : {}),
      });
      const now = useEditor.getState();
      if (now.design?.id !== designId) return true;
      now.markSaved(r.revision);
      syncCache(r.revision);
      if (now.rev !== rev0) {
        now.setSave("dirty");
        schedule(DEBOUNCE);
      }
      thumbnail();
      return true;
    } catch (e) {
      const now = useEditor.getState();
      if (now.design?.id !== designId) return false;
      if (e instanceof ApiError && e.status === 409) now.setSave("conflict", e.message);
      else {
        now.setSave("error", e instanceof Error ? e.message : String(e));
        schedule(10_000);
      }
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designId, syncCache, thumbnail]);

  /** Save now (Ctrl+S, before saving a version, "Keep mine"). Resolves true when the server has the latest. */
  const saveNow = useCallback((force = false): Promise<boolean> => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    const next = queue.current.then(() => doSave(force), () => doSave(force));
    queue.current = next.catch(() => false);
    return next;
  }, [doSave]);

  function schedule(ms: number) {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = 0; void saveNow(); }, ms);
  }

  useEffect(() => {
    if (rev > 0 && (save === "dirty")) schedule(DEBOUNCE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  // leaving the page: warn while changes are unsaved, and try a last save as the tab closes
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      const s = useEditor.getState().save;
      if (s === "dirty" || s === "saving" || s === "error" || s === "conflict") { e.preventDefault(); e.returnValue = ""; }
    };
    const hide = () => {
      const st = useEditor.getState();
      if (!st.design || st.design.id !== designId || (st.save !== "dirty" && st.save !== "error")) return;
      const body = JSON.stringify({ title: st.design.title, format: effectiveFormat(st.design.format, st.width, st.height).key, width: st.width, height: st.height, status: st.design.status,
        doc: st.doc, base_revision: st.design.revision });
      if (body.length > 60_000) return;
      try {
        void fetch(`/api/designs/${designId}`, { method: "PUT", body, keepalive: true, credentials: "include",
          headers: { "Content-Type": "application/json", "X-Requested-With": "veo-studio" } }).catch(() => {});
      } catch { /* ignore */ }
    };
    window.addEventListener("beforeunload", before);
    window.addEventListener("pagehide", hide);
    return () => { window.removeEventListener("beforeunload", before); window.removeEventListener("pagehide", hide); };
  }, [designId]);

  /** Called as the editor unmounts: save what's pending with the state captured right now. */
  const flushOnLeave = useCallback(() => {
    alive.current = false;
    window.clearTimeout(timer.current);
    window.clearTimeout(thumbTimer.current);
    const st = useEditor.getState();
    const d = st.design;
    if (!d || d.id !== designId || (st.save !== "dirty" && st.save !== "error")) return;
    const payload = { title: d.title, format: effectiveFormat(d.format, st.width, st.height).key, width: st.width, height: st.height, status: d.status, template: d.template, brand_kit_id: d.brand_kit_id, doc: st.doc, base_revision: d.revision };
    designsApi.save(designId, payload)
      .then((r) => {
        qc.setQueryData<Design>(designKeys.one(designId), (old) => ({ ...(old ?? d), ...d, revision: r.revision, width: payload.width, height: payload.height, doc: payload.doc }));
        void qc.invalidateQueries({ queryKey: ["designs"] });
      })
      .catch(() => { void qc.invalidateQueries({ queryKey: designKeys.one(designId) }); });
  }, [qc, designId]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  return { saveNow, flushOnLeave, thumbnail };
}
