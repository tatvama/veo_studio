/** Pick a studio project, then one of its episodes (for "Import studio episode"). */
import { Clapperboard } from "lucide-react";
import { useState } from "react";
import { Button, Field, Modal, Select, Skeleton } from "../components/ui";
import { useProject, useProjects } from "../lib/queries";

export function EpisodePicker({ open, onClose, onPick, busy, title = "Import a studio episode" }: {
  open: boolean; onClose: () => void; onPick: (pid: number, eid: number, label: string) => void; busy?: boolean; title?: string;
}) {
  const projects = useProjects();
  const [pid, setPid] = useState(0);
  const [eid, setEid] = useState(0);
  const proj = useProject(pid);
  const list = (projects.data ?? []).filter((p) => p.type !== "edit");
  const eps = proj.data?.episodes ?? [];
  const ep = eps.find((e) => e.id === eid);
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!pid || !eid} onClick={() => ep && onPick(pid, eid, `${proj.data?.title ?? "Project"} · ${ep.title || `Episode ${ep.number}`}`)}>Import cut</Button>
      </>}>
      <div className="grid gap-3.5">
        <p className="text-sm text-mute">The episode's cut becomes a sequence in the edit: its shots, trims, transitions and effects, with the media synced into the edit folder.</p>
        <Field label="Project">
          {projects.isLoading ? <Skeleton className="h-9" /> : (
            <Select value={pid || ""} onChange={(e) => { setPid(Number(e.target.value)); setEid(0); }}>
              <option value="">Choose a project…</option>
              {list.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Episode">
          {pid && proj.isLoading ? <Skeleton className="h-9" /> : (
            <Select value={eid || ""} disabled={!pid} onChange={(e) => setEid(Number(e.target.value))}>
              <option value="">{pid ? (eps.length ? "Choose an episode…" : "No episodes yet") : "Choose a project first"}</option>
              {eps.map((e) => <option key={e.id} value={e.id}>S{e.season}·E{String(e.number).padStart(2, "0")} — {e.title || "Untitled"}</option>)}
            </Select>
          )}
        </Field>
        {ep && (() => {
          const n = ep.shots ? ep.shots.filter((s) => s.include).length : null;
          return <p className="flex items-center gap-2 text-2xs text-dim"><Clapperboard className="size-3.5" />{n === null ? "The shots in its cut come in as clips" : n === 0 ? "No shots in its cut yet: you'll get an empty sequence" : `${n} shot${n === 1 ? "" : "s"} in the cut`}</p>;
        })()}
      </div>
    </Modal>
  );
}
