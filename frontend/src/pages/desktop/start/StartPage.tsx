/**
 * Start (the desktop launcher, shown in the main window when no project is open): recent edits with thumbnails and
 * when they were last opened, recent studio projects (from the server when it answers), New edit / New edit from
 * folder / Open…, What's new in this version, quick tips and this machine's card. It uses the editor bridge the same
 * way the editor's home does (list, create, open).
 */
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  ArrowRight, CloudOff, Film, FolderOpen, FolderTree, Keyboard, Lightbulb, LibraryBig, MousePointerClick, Plus, RefreshCw, Sparkles, Wand2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, Field, Input, Kbd, Modal, Select } from "../../../components/ui";
import { newEditFromFolder, openEdit } from "../../../desktop/actions";
import { ago, editUrl, errText, useOfflineStatus, useShellState } from "../../../desktop/bridge";
import { AssistantBannerSlot } from "../../../desktop/AssistantBannerSlot";
import { CrashDialog } from "../../../desktop/CrashDialog";
import { setOverlay } from "../../../desktop/state";
import { loadNotes, NotesView, type Notes } from "../../../desktop/WhatsNew";
import { PRESET_SIZES } from "../../../editor/model/defaults";
import { FPS_LIST, fpsLabel } from "../../../editor/model/time";
import { editorBridge, type EditListEntry } from "../../../lib/desktop";
import { useAuthStatus, useProjects } from "../../../lib/queries";
import { MachineCard } from "../../project/finish/MachineCard";
import { Card, DesktopPage, EmptyRow, ErrorRow, LoadingRows } from "../DesktopPage";

const TIPS: { icon: typeof Lightbulb; text: string; keys?: string }[] = [
  { icon: Keyboard, text: "Search for anything — projects, edits, panels, editor actions and settings.", keys: "Ctrl+K" },
  { icon: FolderTree, text: "Drop a folder of clips from Explorer onto any window to start an edit with them." },
  { icon: Keyboard, text: "Every shortcut of this window, the editor's included.", keys: "Shift+/" },
  { icon: MousePointerClick, text: "Right-click Tatvam on the taskbar for New edit, recent edits and the library folder." },
  { icon: CloudOff, text: "No connection? The screens and your cut keep working; edits are sent when the server is back." },
  { icon: Sparkles, text: "Mica, accent, density and UI scale are in Settings → Appearance.", keys: "Ctrl+," },
];

function greeting(name?: string) {
  const h = new Date().getHours();
  const part = h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : part;
}

function NewEditDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [size, setSize] = useState("1080p");
  const [fps, setFps] = useState(25);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    const b = editorBridge();
    const p = PRESET_SIZES.find((x) => x.id === size) ?? PRESET_SIZES[0];
    if (!b) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await b.create(name.trim() || "Untitled edit", { width: p.width, height: p.height, fps });
      onClose();
      nav(editUrl(r.path));
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="New edit" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void create()} icon={<Film className="size-4" />}>Create edit</Button></>}>
      <div className="grid gap-3">
        <Field label="Name"><Input data-autofocus value={name} placeholder="Untitled edit" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} /></Field>
        <Field label="Format" hint="Size and frame rate of the first sequence (you can add others later).">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Select value={size} onChange={(e) => setSize(e.target.value)} aria-label="Size">{PRESET_SIZES.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.width}×{p.height}</option>)}</Select>
            <Select value={fps} onChange={(e) => setFps(Number(e.target.value))} aria-label="Frame rate">{FPS_LIST.map((f) => <option key={f} value={f}>{fpsLabel(f)}</option>)}</Select>
          </div>
        </Field>
        {err && <ErrorRow message={err} />}
      </div>
    </Modal>
  );
}

/** Arrow keys move between the cards of a grid (Tab enters and leaves it). */
function gridKeys(e: React.KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-card]")];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  const cols = Math.max(1, Math.round(e.currentTarget.clientWidth / (items[0]?.offsetWidth || 1)));
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: items.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  items[Math.max(0, Math.min(items.length - 1, next))]?.focus();
}

function RecentEdits() {
  const nav = useNavigate();
  const [list, setList] = useState<EditListEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    const b = editorBridge();
    if (!b) { setList([]); return; }
    setErr(null);
    b.list().then(setList).catch((e) => { setErr(errText(e)); setList([]); });
  };
  useEffect(load, []);
  const shown = (list ?? []).slice(0, 12);
  return (
    <Card title="Recent edits" icon={<Film />} actions={<Button size="sm" variant="ghost" icon={<FolderOpen className="size-3.5" />} onClick={() => void openEdit(nav)}>Open…</Button>}>
      {list === null ? <LoadingRows rows={2} className="sm:grid-cols-3" />
        : err ? <ErrorRow message={`Couldn't list the edits: ${err}`} onRetry={load} />
          : !shown.length ? <EmptyRow icon={<Film className="size-5" />} title="No edits yet" sub="Start a new edit, or drop a folder of clips onto this window." />
            : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4" role="list" onKeyDown={gridKeys}>
                {shown.map((e) => (
                  <button key={e.path} type="button" data-card role="listitem" onClick={() => nav(editUrl(e.path))} title={e.path}
                    className="group overflow-hidden rounded-xl border border-line bg-raised text-left transition-[border-color,transform] hover:-translate-y-0.5 hover:border-accent/40 focus-visible:border-accent/60">
                    <div className="relative aspect-video bg-bg">
                      {e.thumb ? <img src={e.thumb} alt="" className="size-full object-cover" loading="lazy" />
                        : <div className="grid size-full place-items-center text-dim"><Film className="size-6" /></div>}
                      {e.recent && <span className="absolute left-1.5 top-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">Recent</span>}
                    </div>
                    <div className="px-2.5 py-2">
                      <p className="truncate text-sm font-medium group-hover:text-ink">{e.name}</p>
                      <p className="mono truncate text-2xs text-dim">{e.recent ? "Opened" : "Saved"} {ago(e.modified)}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
    </Card>
  );
}

function RecentProjects() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const offline = useOfflineStatus();
  const { data, isLoading, error } = useProjects();
  const list = useMemo(() => [...(data ?? [])].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || "")).slice(0, 6), [data]);
  return (
    <Card title="Studio projects" icon={<LibraryBig />} actions={<Button size="sm" variant="ghost" iconRight={<ArrowRight className="size-3.5" />} onClick={() => nav("/")}>All projects</Button>} flush>
      <div className="p-2">
        {isLoading ? <LoadingRows rows={3} className="p-2" />
          : error && !data ? <div className="p-2"><ErrorRow message={offline && !offline.online ? "The studio server can't be reached; projects show when it's back." : `Couldn't load the projects: ${errText(error)}`}
            onRetry={() => void qc.invalidateQueries({ queryKey: ["projects"] })} /></div>
            : !list.length ? <div className="p-2"><EmptyRow icon={<LibraryBig className="size-5" />} title="No projects yet" sub="Projects are made in the studio; the desktop finishes them." /></div>
              : (
                <ul className="grid gap-0.5">
                  {list.map((p, i) => (
                    <li key={p.id}>
                      <button type="button" onClick={() => nav(`/p/${p.id}`)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-hover">
                        <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-line text-xs font-bold text-black"
                          style={{ background: p.thumb_url ? undefined : `linear-gradient(135deg, hsl(${(p.id * 47) % 360} 70% 60%), hsl(${(p.id * 47 + 60) % 360} 70% 45%))` }}>
                          {p.thumb_url ? <img src={p.thumb_url} alt="" className="size-full object-cover" /> : p.title.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{p.title}</span>
                          <span className="block truncate text-2xs text-dim">{p.episodes?.length ?? 0} episode{p.episodes?.length === 1 ? "" : "s"} · {p.aspect} · updated {ago(p.updated_at)}</span>
                        </span>
                        <span className={clsx("text-2xs", i === 0 ? "text-accent-ink" : "text-dim")}>{i === 0 ? "Latest" : ""}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
        {offline && !offline.online && data && <p className="px-2.5 pb-1 pt-2 text-2xs text-amber-300">Offline: these are the projects as they were last seen.</p>}
      </div>
    </Card>
  );
}

function WhatsNewCard() {
  const [notes, setNotes] = useState<Notes | null>(null);
  useEffect(() => {
    let alive = true;
    void loadNotes().then((n) => { if (alive) setNotes(n); });
    return () => { alive = false; };
  }, []);
  return (
    <Card title={`What's new${notes?.version ? ` in ${notes.version}` : ""}`} icon={<Sparkles />}
      actions={notes?.text ? <Button size="sm" variant="ghost" onClick={() => setOverlay("whatsnew")}>Read all</Button> : undefined}>
      {!notes ? <LoadingRows rows={2} /> : notes.text
        ? <div className="max-h-64 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]"><NotesView text={notes.text} limit={6} /></div>
        : <p className="text-sm text-mute">The release notes for this version aren't on this PC.</p>}
    </Card>
  );
}

function Tips() {
  const [i, setI] = useState(() => Math.floor(Math.random() * TIPS.length));
  return (
    <Card title="Quick tips" icon={<Lightbulb />} actions={<Button size="sm" variant="ghost" aria-label="Next tip" icon={<RefreshCw className="size-3.5" />} onClick={() => setI((x) => (x + 1) % TIPS.length)}>Next</Button>}>
      <ul className="space-y-3">
        {[0, 1, 2].map((k) => {
          const t = TIPS[(i + k) % TIPS.length];
          const I = t.icon;
          return (
            <li key={k} className="flex items-start gap-3 text-sm">
              <I className="mt-0.5 size-4 shrink-0 text-accent-ink" />
              <span className="min-w-0 flex-1 text-mute">{t.text}{t.keys && <> <Kbd>{t.keys}</Kbd></>}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export default function StartPage() {
  const nav = useNavigate();
  const loc = useLocation();
  const { data: auth } = useAuthStatus();
  const state = useShellState();
  const [newOpen, setNewOpen] = useState(false);
  const machine = useRef<HTMLDivElement>(null);
  const first = auth?.user?.name?.split(" ")[0];

  // the Jump List's "New edit from folder…"; "#machine" from Help → Machine check
  useEffect(() => {
    if (new URLSearchParams(loc.search).get("action") === "new-edit-from-folder") {
      nav("/desktop/panel/start", { replace: true });
      void newEditFromFolder();
    }
    if (loc.hash === "#machine") setTimeout(() => machine.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
  }, [loc.search, loc.hash, nav]);
  // "What's new" once after an update (in this window only: Start is the main window's page)
  useEffect(() => {
    if (!state?.updatedFrom) return;
    const k = "tatvam-desktop:whatsnew-seen";
    try {
      if (localStorage.getItem(k) === state.appVersion) return;
      localStorage.setItem(k, state.appVersion);
    } catch { /* storage blocked */ }
    setOverlay("whatsnew");
  }, [state?.updatedFrom, state?.appVersion]);

  return (
    <DesktopPage title="Start">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow !text-accent-ink">Tatvam Studio</p>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-tight">{greeting(first)}</h1>
          <p className="mt-1 text-sm text-mute">Pick up an edit, open a studio project, or start something new.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setNewOpen(true)}>New edit</Button>
          <Button icon={<Wand2 className="size-4" />} onClick={() => void newEditFromFolder()}>New edit from folder…</Button>
          <Button variant="outline" icon={<FolderOpen className="size-4" />} onClick={() => void openEdit(nav)}>Open…</Button>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-8">
          <RecentEdits />
          <RecentProjects />
        </div>
        <div className="space-y-4 lg:col-span-4">
          <WhatsNewCard />
          <Tips />
          <div ref={machine}><MachineCard variant="summary" /></div>
        </div>
      </div>
      <NewEditDialog open={newOpen} onClose={() => setNewOpen(false)} />
      <CrashDialog state={state} />
      <AssistantBannerSlot />
    </DesktopPage>
  );
}
