/**
 * Review comments (docs/EDITOR.md §10): notes pinned to frames of the sequence. With the edit's studio project they
 * are the studio's comments (target_type "edit", sequence_id and frame), shared with the team and mirrored as comment
 * markers on the timeline; without one they live in the edit itself as comment markers (Marker.kind "comment").
 * Click a comment to go to its frame; resolve, reply in a new comment, or delete a local one.
 */
import { clsx } from "clsx";
import { CheckCircle2, Circle, CloudUpload, Loader2, MapPin, MessageSquarePlus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, Textarea } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { useEditorHost } from "../host";
import { useVisible } from "../moods/ui";
import { uid } from "../model/ids";
import { toTimecode, framesToSeconds } from "../model/time";
import type { Marker } from "../model/types";
import { program, useFrame } from "../playback/transport";
import { setFocus, useProject, useSequence } from "../store";

const OPEN = "#fb7185", DONE = "#34d399";
const SYNC_PREFIX = "cm_";
interface ServerComment { id: number; body: string; frame?: number | null; timecode?: number | null; sequence_id?: string | null; resolved: boolean; created_at?: string; user?: { name?: string; email?: string } }
interface Row { key: string; frame: number; body: string; author: string; resolved: boolean; at?: string; server?: number; markerId?: string }

const isComment = (m: Marker) => m.kind === "comment";

export default function CommentsPanel() {
  const host = useEditorHost();
  const s = useSequence();
  const p = useProject();
  const pid = p.studioProjectId ?? null;
  const root = useRef<HTMLDivElement>(null);
  const visible = useVisible(root);
  const frame = useFrame(program);
  const [server, setServer] = useState<ServerComment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDone, setShowDone] = useState(true);

  const load = async () => {
    if (!pid) { setServer(null); return; }
    try {
      const list = await api.get<ServerComment[]>(`/api/comments?target_type=edit&target_id=${pid}&sequence_id=${encodeURIComponent(s.id)}`, { silent: true });
      setServer(list.filter((c) => !c.sequence_id || c.sequence_id === s.id));
      setErr(null);
    } catch (e) { setServer(null); setErr(e instanceof ApiError ? e.message : String(e)); }
  };
  useEffect(() => { void load(); }, [pid, s.id]);
  useEffect(() => { if (!visible || !pid) return; const id = window.setInterval(() => void load(), 20000); return () => window.clearInterval(id); }, [visible, pid, s.id]);

  const online = !!pid && server !== null;
  const rows: Row[] = useMemo(() => {
    const local = s.markers.filter((m) => isComment(m) && !m.id.startsWith(SYNC_PREFIX)).map((m): Row => ({
      key: m.id, frame: m.frame, body: m.comment ?? "", author: m.name.replace(/^Comment( · )?/, "") || "You", resolved: m.color === DONE, markerId: m.id }));
    const remote = (server ?? []).map((c): Row => ({
      key: `s${c.id}`, frame: c.frame ?? Math.round((c.timecode ?? 0) * s.fps), body: c.body, author: c.user?.name || c.user?.email || "Studio", resolved: c.resolved, at: c.created_at, server: c.id }));
    return [...remote, ...local].sort((a, b) => a.frame - b.frame || a.key.localeCompare(b.key));
  }, [s.markers, server, s.fps]);
  const shown = rows.filter((r) => showDone || !r.resolved);

  /** Mirrors the studio comments as comment markers (one command; markers of comments that are gone go too). */
  const syncMarkers = (list: ServerComment[] | null = server) => {
    if (!list) return;
    host.apply("Sync comment markers", (d) => {
      const sq = d.sequences.find((x) => x.id === d.activeSequenceId)!;
      const keep = sq.markers.filter((m) => !m.id.startsWith(SYNC_PREFIX));
      const add: Marker[] = list.map((c) => ({ id: `${SYNC_PREFIX}${c.id}`, frame: c.frame ?? Math.round((c.timecode ?? 0) * sq.fps), duration: 0,
        name: `Comment · ${c.user?.name || c.user?.email || "Studio"}`, color: c.resolved ? DONE : OPEN, comment: c.body.slice(0, 500), kind: "comment" }));
      sq.markers = [...keep, ...add].sort((a, b) => a.frame - b.frame);
    });
  };

  const add = async () => {
    const body = text.trim();
    if (!body) return;
    const f = program.frame;
    setBusy(true);
    try {
      if (online) {
        const c = await api.post<ServerComment>("/api/comments", { target_type: "edit", target_id: pid, body, sequence_id: s.id, frame: f, timecode: framesToSeconds(f, s.fps) });
        const next = [...(server ?? []), c];
        setServer(next);
        syncMarkers(next);
      } else {
        host.apply("Add comment", (d) => {
          const sq = d.sequences.find((x) => x.id === d.activeSequenceId)!;
          sq.markers = [...sq.markers, { id: uid("m"), frame: f, duration: 0, name: "Comment", color: OPEN, comment: body, kind: "comment" as const }].sort((a, b) => a.frame - b.frame);
        });
      }
      setText("");
    } catch (e) { toast.error(`Couldn't add the comment: ${(e as Error).message}`); }
    setBusy(false);
  };

  const resolve = async (r: Row) => {
    if (r.server) {
      try {
        const c = await api.post<ServerComment>(`/api/comments/${r.server}/resolve`, {});
        const next = (server ?? []).map((x) => (x.id === r.server ? { ...x, resolved: c.resolved ?? !x.resolved } : x));
        setServer(next);
        if (s.markers.some((m) => m.id === `${SYNC_PREFIX}${r.server}`)) syncMarkers(next);
      } catch (e) { toast.error((e as Error).message); }
      return;
    }
    host.apply(r.resolved ? "Reopen comment" : "Resolve comment", (d) => {
      const sq = d.sequences.find((x) => x.id === d.activeSequenceId)!;
      sq.markers = sq.markers.map((m) => (m.id === r.markerId ? { ...m, color: r.resolved ? OPEN : DONE } : m));
    });
  };
  const remove = (r: Row) => host.apply("Delete comment", (d) => {
    const sq = d.sequences.find((x) => x.id === d.activeSequenceId)!;
    sq.markers = sq.markers.filter((m) => m.id !== r.markerId);
  });
  /** Local comments up to the studio (they become shared comments; their markers become mirrors). */
  const upload = async () => {
    const local = rows.filter((r) => r.markerId);
    if (!online || !local.length) return;
    setBusy(true);
    try {
      const made: ServerComment[] = [];
      for (const r of local) made.push(await api.post<ServerComment>("/api/comments", { target_type: "edit", target_id: pid, body: r.body || "(no text)", sequence_id: s.id, frame: r.frame, timecode: framesToSeconds(r.frame, s.fps) }));
      const ids = new Set(local.map((r) => r.markerId));
      const next = [...(server ?? []), ...made];
      setServer(next);
      host.apply("Share comments", (d) => {
        const sq = d.sequences.find((x) => x.id === d.activeSequenceId)!;
        sq.markers = sq.markers.filter((m) => !ids.has(m.id));
      });
      syncMarkers(next);
      toast.success(`${made.length} comment${made.length === 1 ? "" : "s"} shared with the studio`);
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };
  const connect = async () => {
    const mods = import.meta.glob("../ai/api.ts");
    const load = mods["../ai/api.ts"];
    if (!load) { toast.message("Sharing comments needs the studio connection of the AI tools"); return; }
    setBusy(true);
    try {
      const m = (await load()) as { ensureStudioProject?: (h: typeof host) => Promise<number> };
      if (m.ensureStudioProject) await m.ensureStudioProject(host);
    } catch (e) { toast.error(`Couldn't reach the studio: ${(e as Error).message}`); }
    setBusy(false);
  };
  const localCount = rows.filter((r) => r.markerId).length;

  return (
    <div ref={root} className="pn" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar gap-2">
        <span className={clsx("text-2xs", online ? "text-ok" : "text-dim")}>{online ? "Shared with the studio" : pid ? (err ? "Studio unreachable · kept in this edit" : "Connecting…") : "Kept in this edit"}</span>
        <label className="ml-auto flex items-center gap-1 text-2xs text-mute"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />Resolved</label>
        {online && <button type="button" className="ed-ibtn" title="Show the studio comments as markers on the timeline" onClick={() => syncMarkers()}><MapPin className="size-3.5" /></button>}
        {pid && <button type="button" className="ed-ibtn" title="Refresh" onClick={() => void load()}><RefreshCw className="size-3.5" /></button>}
      </div>
      <div className="border-b border-line p-2">
        <Textarea rows={2} className="text-xs" value={text} placeholder={`Comment at ${toTimecode(frame, s.fps)}…  (@name mentions a teammate)`} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void add(); }} />
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button size="sm" variant="primary" loading={busy} disabled={!text.trim()} icon={<MessageSquarePlus className="size-3.5" />} onClick={() => void add()}>Comment at {toTimecode(frame, s.fps)}</Button>
          {!pid && <Button size="sm" variant="ghost" onClick={() => void connect()} title="Make the edit's studio project to share comments">Share with the studio</Button>}
          {online && localCount > 0 && <Button size="sm" variant="ghost" icon={<CloudUpload className="size-3.5" />} onClick={() => void upload()}>Share {localCount} local</Button>}
        </div>
      </div>
      <div className="pn-scroll" data-comments>
        {shown.map((r) => (
          <div key={r.key} className={clsx("pn-row group items-start gap-2 py-1.5", r.resolved && "opacity-55")} onClick={() => { program.pause(); program.seek(r.frame); }}>
            <button type="button" title={r.resolved ? "Reopen" : "Resolve"} className={clsx("mt-0.5 shrink-0", r.resolved ? "text-ok" : "text-dim hover:text-ink")} onClick={(e) => { e.stopPropagation(); void resolve(r); }}>
              {r.resolved ? <CheckCircle2 className="size-3.5" /> : <Circle className="size-3.5" />}
            </button>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[10px] text-dim"><span className="mono text-accent-ink">{toTimecode(r.frame, s.fps)}</span><span>{r.author}</span>{r.at && <span>{new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>}{!r.server && <span>local</span>}</p>
              <p className="whitespace-pre-wrap break-words text-xs">{r.body}</p>
            </div>
            {r.markerId && <button type="button" aria-label="Delete comment" className="shrink-0 text-dim opacity-0 hover:text-red-300 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); remove(r); }}><Trash2 className="size-3" /></button>}
          </div>
        ))}
        {!shown.length && <div className="pn-empty h-auto py-8">{busy ? <Loader2 className="size-4 animate-spin" /> : "No comments yet. Park the playhead on a frame and write one."}</div>}
      </div>
    </div>
  );
}
