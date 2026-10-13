/** Settings → AI assistants → Activity: every tool call and refusal, newest first (userData/assistants-activity.jsonl). */
import { clsx } from "clsx";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AssistantActivity } from "../../lib/desktop";
import { assistantsBridge } from "../api";

export default function ActivityLog({ limit = 150, refreshKey }: { limit?: number; refreshKey?: unknown }) {
  const [rows, setRows] = useState<AssistantActivity[] | null>(null);
  const [only, setOnly] = useState<"all" | "refused">("all");
  const load = useCallback(() => { void assistantsBridge()?.activity(limit).then(setRows).catch(() => setRows([])); }, [limit]);
  useEffect(() => { load(); }, [load, refreshKey]);
  const shown = (rows ?? []).filter((r) => only === "all" || !r.ok);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <button type="button" className={clsx("rounded-md px-2 py-0.5", only === "all" ? "bg-raised text-ink" : "text-mute hover:text-ink")} onClick={() => setOnly("all")}>All</button>
        <button type="button" className={clsx("rounded-md px-2 py-0.5", only === "refused" ? "bg-raised text-ink" : "text-mute hover:text-ink")} onClick={() => setOnly("refused")}>Refused and failed</button>
        <button type="button" className="ml-auto inline-flex items-center gap-1 text-mute hover:text-ink" onClick={load}><RefreshCw className="size-3" />Refresh</button>
      </div>
      <div className="max-h-80 overflow-auto rounded-lg border border-line">
        {rows === null ? <p className="p-3 text-xs text-dim">Loading…</p> : !shown.length ? <p className="p-3 text-xs text-dim">Nothing yet.</p> : (
          <table className="w-full text-left text-xs">
            <tbody>
              {shown.map((r, i) => (
                <tr key={`${r.at}-${i}`} className="border-b border-line/60 last:border-0 align-top">
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono text-2xs text-dim">{new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-mute">{r.client}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono">{r.tool}</td>
                  <td className="px-2 py-1.5"><span className={clsx("mr-1.5 inline-block size-1.5 rounded-full", r.ok ? "bg-ok" : "bg-bad")} />{r.summary}{r.ms !== undefined ? <span className="text-dim"> · {r.ms} ms</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
