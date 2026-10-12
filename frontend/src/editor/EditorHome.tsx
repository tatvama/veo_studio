/**
 * The editor's start screen (docs/EDITOR.md): recent edits, a new edit (name + format), Open…, and Import studio
 * episode, with a way back to the studio. In a plain browser it says the editor runs in Tatvam Desktop and offers
 * the in-memory demo.
 */
import "./editor.css";
import { ArrowLeft, Clapperboard, Download, FileInput, Film, FolderOpen, MonitorPlay, Plus, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button, Empty, Field, Input, Panel, Skeleton } from "../components/ui";
import { useAuthStatus } from "../lib/queries";
import { editorBridge, type EditListEntry } from "../lib/desktop";
import { PresetPicker } from "./dialogs";
import { EpisodePicker } from "./EpisodePicker";
import { PRESET_SIZES } from "./model/defaults";
import { MenuHost } from "./ui";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");
const editUrl = (path: string) => `/editor/edit?path=${encodeURIComponent(path)}`;

export default function EditorHome() {
  const b = editorBridge();
  useEffect(() => { document.title = "Tatvam Editor"; }, []);
  if (!b) return <DesktopOnly />;
  return <Home />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="ed-root hud-bg fixed inset-0 overflow-y-auto bg-bg text-ink">
      <header className="flex h-12 items-center gap-3 border-b border-line bg-panel/80 px-4 backdrop-blur">
        <Link to="/" className="ed-ibtn" title="Back to the studio"><ArrowLeft className="size-4" /></Link>
        <span className="select-none font-semibold tracking-tight"><span className="text-gradient">TATVAM</span> <span className="text-2xs font-medium text-mute">EDITOR</span></span>
        <Link to="/" className="ml-auto text-xs text-mute hover:text-ink">Studio</Link>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
      <MenuHost />
    </div>
  );
}

function Home() {
  const b = editorBridge()!;
  const nav = useNavigate();
  const { data: auth } = useAuthStatus();
  const [list, setList] = useState<EditListEntry[] | null>(null);
  const [name, setName] = useState("");
  const [size, setSize] = useState<string>("1080p");
  const [fps, setFps] = useState(25);
  const [busy, setBusy] = useState<string | null>(null);
  const [ep, setEp] = useState(false);
  useEffect(() => { b.list().then(setList).catch((e) => { toast.error(`Couldn't list edits: ${msg(e)}`); setList([]); }); }, [b]);

  const create = async (nm = name.trim() || "Untitled edit") => {
    const p = PRESET_SIZES.find((x) => x.id === size)!;
    setBusy("new");
    try {
      const r = await b.create(nm, { width: p.width, height: p.height, fps });
      nav(editUrl(r.path));
      return r.path;
    } catch (e) { toast.error(`Couldn't create the edit: ${msg(e)}`); return null; } finally { setBusy(null); }
  };
  const open = async () => {
    setBusy("open");
    try { const r = await b.open(); if (r) nav(editUrl(r.path)); } catch (e) { toast.error(msg(e)); } finally { setBusy(null); }
  };
  // a Premiere / Resolve / OTIO timeline as a new edit (editor-interop, docs/EDITOR.md §12)
  const importTimeline = async () => {
    setBusy("xml");
    try {
      const r = await b.interop?.importFile();
      if (!r) return;
      if (r.kind === "markers") { toast.message("A markers CSV goes into an edit: open one, then File → Import markers CSV"); return; }
      for (const w of r.warnings.slice(0, 4)) toast.warning(w);
      nav(editUrl(r.path));
    } catch (e) { toast.error(`Import failed: ${msg(e)}`); } finally { setBusy(null); }
  };
  const importEp = async (pid: number, eid: number, label: string) => {
    setBusy("ep");
    try {
      const p = PRESET_SIZES.find((x) => x.id === size)!;
      const made = await b.create(label, { width: p.width, height: p.height, fps });
      const r = await b.importEpisode(pid, eid, made.path);
      for (const w of (r.warnings ?? []).slice(0, 4)) toast.warning(w);
      // the returned project is the edit now (written here too, so opening it from disk shows the episode)
      await b.save(made.path, { ...r.project, activeSequenceId: r.sequenceId });
      setEp(false);
      nav(editUrl(made.path));
    } catch (e) { toast.error(`Import failed: ${msg(e)}`); } finally { setBusy(null); }
  };

  const first = auth?.user?.name?.split(" ")[0];
  return (
    <Shell>
      <div className="mb-6">
        <p className="eyebrow !text-accent-ink">Tatvam Editor</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{first ? `Ready to cut, ${first}?` : "Ready to cut?"}</h1>
        <p className="mt-1 text-sm text-mute">A multi-track editor on this PC's graphics card: any footage, studio episodes, transitions, effects and keyframes.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-5">
          <Panel eyebrow="Start" title="New edit" icon={<Plus className="size-4" />}>
            <div className="grid gap-3">
              <Field label="Name"><Input value={name} placeholder="Untitled edit" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} /></Field>
              <Field label="Format" hint="Size and frame rate of the first sequence (you can add others later)."><PresetPicker size={size} fps={fps} onSize={setSize} onFps={setFps} /></Field>
              <Button variant="primary" loading={busy === "new"} onClick={() => void create()} icon={<Film className="size-4" />}>Create edit</Button>
            </div>
          </Panel>
          <Panel eyebrow="Or" title="Open or import" icon={<FolderOpen className="size-4" />}>
            <div className="grid gap-2">
              <Button loading={busy === "open"} onClick={() => void open()} icon={<FolderOpen className="size-4" />}>Open an edit…</Button>
              <Button loading={busy === "ep"} onClick={() => setEp(true)} icon={<Clapperboard className="size-4" />}>Import a studio episode…</Button>
              <p className="text-2xs text-dim">An episode's cut becomes a new edit: shots, trims, transitions and effects, with its media synced to this PC.</p>
              {b.interop && <Button loading={busy === "xml"} onClick={() => void importTimeline()} icon={<FileInput className="size-4" />}>Import Premiere XML, EDL or OTIO…</Button>}
            </div>
          </Panel>
        </div>
        <div className="lg:col-span-7">
          <Panel eyebrow="Library" title="Recent edits" icon={<MonitorPlay className="size-4" />} flush>
            {list === null ? (
              <div className="grid gap-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
            ) : list.length === 0 ? (
              <div className="p-4"><Empty icon={<Film className="size-6" />} title="No edits yet" sub="Create one on the left, or import a studio episode." /></div>
            ) : (
              <ul className="divide-y divide-line">
                {list.map((e) => (
                  <li key={e.path}>
                    <button type="button" onClick={() => nav(editUrl(e.path))} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-hover">
                      {e.thumb ? <img src={e.thumb} alt="" className="h-11 w-20 shrink-0 rounded-md border border-line object-cover" /> : <div className="grid h-11 w-20 shrink-0 place-items-center rounded-md border border-line bg-raised"><Film className="size-4 text-dim" /></div>}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{e.name}</span>
                        <span className="mono block truncate text-2xs text-dim" title={e.path}>{e.path}</span>
                      </span>
                      <span className="shrink-0 text-right text-2xs text-dim">{e.recent ? <span className="block text-accent-ink">recent</span> : null}{new Date(e.modified).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
      <EpisodePicker open={ep} busy={busy === "ep"} onClose={() => setEp(false)} onPick={(pid, eid, label) => void importEp(pid, eid, label)} />
    </Shell>
  );
}

/** In a plain browser: the editor needs Tatvam Desktop; the demo still runs here. */
export function DesktopOnly() {
  return (
    <Shell>
      <div className="mx-auto max-w-xl py-10">
        <Panel eyebrow="Tatvam Editor" title="The editor runs in Tatvam Desktop" icon={<MonitorPlay className="size-4" />}>
          <div className="space-y-4 text-sm text-mute">
            <p>It edits footage on your PC — imports, autosave, GPU preview and exports at full size — so it lives in the desktop app. Sign in there with this account and open <span className="text-ink">Window → Editor</span>.</p>
            <div className="flex flex-wrap gap-2">
              <a href="tatvam://editor" className="inline-flex"><Button variant="primary" icon={<Download className="size-4" />}>Open in Tatvam Desktop</Button></a>
              <Link to="/editor/edit?demo=1"><Button icon={<Sparkles className="size-4" />}>Try the demo here</Button></Link>
            </div>
            <p className="text-2xs text-dim">The demo is an in-memory edit with generated clips: everything works except importing, saving and exporting.</p>
          </div>
        </Panel>
      </div>
    </Shell>
  );
}
