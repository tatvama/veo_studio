import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { receiveAgentProgress } from "./agentProgress";
import { receivePresence, setLiveSender } from "./collab";
import { createReconnector } from "./reconnect";

/** Streams server events over WebSocket and refreshes the affected queries, so every teammate sees changes live. */
export function useLiveEvents(projectId: number | null) {
  const qc = useQueryClient();
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null; // the flush debounce
    let pending = new Set<string>();
    // one pending reconnect at a time, cancelled by cleanup: a socket for the old project must never come back
    const reconnect = createReconnector(() => connect(), { initial: 1000, max: 15000 });

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
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/ws${projectId ? `?project_id=${projectId}` : ""}`);
      ws.onopen = () => {
        reconnect.reset();
        const sock = ws;
        setLiveSender((msg) => { if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg)); });
      };
      ws.onmessage = (ev) => {
        let e: { type: string; payload: Record<string, any>; user_id?: number | null };
        try { e = JSON.parse(ev.data); } catch { return; }
        const t = e.type;
        if (t === "presence") {  // who is here and what they are editing (not an event log entry)
          if (projectId) receivePresence(projectId, e.payload as any);
          return;
        }
        if (t === "agent.progress") {  // the Director's live steps while a chat turn runs (nothing to refetch)
          if (projectId) receiveAgentProgress(projectId, e.user_id, e.payload);
          return;
        }
        // a finished or blocked video changes the shot's recovery options too
        if (t.startsWith("job") || t === "jobs.created") touch("jobs", "episode", "costs", "shot", "shot-alternatives");
        if (t === "job.updated" && e.payload.status === "failed") toast.error(`Job failed: ${String(e.payload.error || e.payload.type).slice(0, 160)}`);
        if (t === "run.finished") {  // Produce all / Autopilot / Scenes in order ended; what it couldn't make is on the board
          touch("board", "episode", "project");
          const n = Array.isArray(e.payload.problems) ? e.payload.problems.length : 0;
          if (n) toast.warning(`Finished with ${n} problem${n === 1 ? "" : "s"} — see the shot list`, { duration: 15000 });
        }
        if (t === "produce.paused") {  // Produce all stopped for the new looks and voices to be checked
          touch("board", "characters", "locations");
          toast.message(String(e.payload.message || "Produce all is waiting for you"), { duration: 15000 });
        }
        if (t.startsWith("take") || t === "shot.updated" || t === "episode.updated" || t === "audio.created") touch("episode", "shot", "board", "impact", "dashboard", "wardrobe", "continuity-bible", "dialogue-check");
        if (t === "bible.updated") touch("characters", "character", "locations", "location", "project", "costumes", "character-versions", "character-lock", "character-look", "props", "mentions");
        if (t.startsWith("take") || t === "bible.updated") touch("character-impact");  // the Cast's "look out of date" and "Redo these shots"
        if (t.startsWith("project") || t === "autopilot.updated") touch("project", "projects", "seasons", "dashboard");
        if (t.startsWith("job")) touch("dashboard");
        if (t === "agent.message") touch("agent");
        if (t.startsWith("models")) touch("models", "model", "shot-engines", "shot-alternatives");
        if (t === "providers.credit") touch("provider-credit", "shot-alternatives");
        if (t === "episode.updated") touch("table-read", "script-versions", "marketing", "scenes", "layers");
        // the finishing room: who holds the cut, and its versions (check-in, restore, saves)
        if (t === "episode.updated") touch("versions", ...(e.payload.what === "checkout" ? ["checkout"] : []));
        if (t === "export.updated" || t.startsWith("comment")) touch("review-notes");
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
        reconnect.schedule();
      };
    };
    connect();
    return () => {
      closed = true;
      reconnect.stop();
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [projectId, qc]);
}
