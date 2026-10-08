import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { receivePresence, setLiveSender } from "./collab";

/** Streams server events over WebSocket and refreshes the affected queries, so every teammate sees changes live. */
export function useLiveEvents(projectId: number | null) {
  const qc = useQueryClient();
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = new Set<string>();

    const flush = () => {
      const keys = pending;
      pending = new Set();
      timer = null;
      keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    };
    const touch = (...keys: string[]) => {
      keys.forEach((k) => pending.add(k));
      if (!timer) timer = setTimeout(flush, 250);
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/ws${projectId ? `?project_id=${projectId}` : ""}`);
      ws.onopen = () => {
        retry = 1000;
        const sock = ws;
        setLiveSender((msg) => { if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg)); });
      };
      ws.onmessage = (ev) => {
        let e: { type: string; payload: Record<string, any> };
        try { e = JSON.parse(ev.data); } catch { return; }
        const t = e.type;
        if (t === "presence") {  // who is here and what they are editing (not an event log entry)
          if (projectId) receivePresence(projectId, e.payload as any);
          return;
        }
        if (t.startsWith("job") || t === "jobs.created") touch("jobs", "episode", "costs");
        if (t === "job.updated" && e.payload.status === "failed") toast.error(`Job failed: ${String(e.payload.error || e.payload.type).slice(0, 160)}`);
        if (t.startsWith("take") || t === "shot.updated" || t === "episode.updated" || t === "audio.created") touch("episode", "shot", "board");
        if (t === "bible.updated") touch("characters", "character", "locations", "location", "project");
        if (t.startsWith("project") || t === "autopilot.updated") touch("project", "projects");
        if (t === "agent.message") touch("agent");
        if (t.startsWith("models")) touch("models", "model", "shot-engines");
        if (t === "episode.updated") touch("table-read", "script-versions", "marketing", "scenes", "layers");
        if (t.startsWith("approval")) {
          touch("approvals", "notifications", "jobs");
          if (t === "approval.requested") toast.message(`Approval requested: ${e.payload.summary ?? ""}`, { description: e.payload.reason });
        }
        if (t === "export.updated") {
          touch("episode", "exports");
          if (e.payload.status === "ready") toast.success("Render finished");
        }
        if (t.startsWith("comment")) touch("comments", "notifications", "episode");
        if (t === "budget.alert") {
          touch("costs", "notifications");
          toast.warning(`Team budget at ${e.payload.threshold}%`);
        }
        touch("activity");
      };
      ws.onclose = () => {
        setLiveSender(null);
        if (closed) return;
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 15000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [projectId, qc]);
}
