/**
 * The sections of the Settings window. Settings the web UI may not change (the server address, where the screens come
 * from, FFmpeg, folders) open the native windows and dialogs that do; everything else saves at once.
 */
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
  ArrowUpCircle, Bot, Check, Cpu, Download, FolderOpen, HardDrive, Keyboard, MonitorCog, RefreshCw, RotateCcw, ScrollText, Server, Trash2,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge, Button, Input, Progress, Segmented, Select, Skeleton, Toggle, Tooltip } from "../../../components/ui";
import { loadAssistantsSettings } from "../../../desktop/automation";
import { ago, assistantsBridge, errText, toolsBridge, useAppearanceState, useShellState, useUiStatus, useUpdate, type ToolStatus } from "../../../desktop/bridge";
import { askConfirm, reloadGuardsThen } from "../../../desktop/ScreensToast";
import { setOverlay } from "../../../desktop/state";
import { loadNotes, NotesView, type Notes } from "../../../desktop/WhatsNew";
import {
  bytes, desktop, useDesktopInfo, useDesktopSettings, type AiToolsInfo, type AppearanceSettings, type GpuSummary, type NotificationKind, type ShellPrefs,
  type StorageReport,
} from "../../../lib/desktop";
import { DEFAULT_TEMPLATES } from "../../project/finish/NamingCard";
import { ErrorRow, LoadingRows } from "../DesktopPage";
import { Row, Section, SpaceBar, StatusLine } from "./parts";

const d = () => desktop();
const ShortcutEditor = lazy(() => import("../../../editor/ShortcutEditor").then((m) => ({ default: m.ShortcutEditor })));

function useSaveSettings() {
  const qc = useQueryClient();
  return async (patch: Record<string, unknown>) => {
    try {
      await d()?.settings.set(patch as never);
      await qc.invalidateQueries({ queryKey: ["desktop", "settings"] });
    } catch (e) { toast.error(errText(e)); }
  };
}

// ── server and screens ───────────────────────────────────────────────────────

export function ServerSection() {
  const { data: info } = useDesktopInfo();
  const ui = useUiStatus();
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    const s = await d()?.app.checkUi?.().catch((e) => { toast.error(errText(e)); return null; });
    setBusy(false);
    if (s) toast.message(s.lastError ? s.lastError : s.notice ?? s.label);
  };
  const source = info?.uiSource === "server" ? "Always from the server" : info?.uiSource === "bundled" ? "Built into this app" : "Automatic: the server's screens, with an offline copy";
  return (
    <Section id="server" title="Server and screens" blurb="Your login, approvals and costs live on the studio server; the screens can come from it, with a copy kept on this PC">
      <Row id="server-url" label="Studio server" help="Changing the server signs you out of the old one. Only the native Studio server window can change it.">
        <span className="mono max-w-[22rem] truncate text-xs text-ink" title={info?.serverUrl}>{info?.serverUrl ?? "—"}</span>
        <Button size="sm" icon={<Server className="size-3.5" />} onClick={() => void d()?.app.openConnection()}>Change…</Button>
      </Row>
      <Row id="ui-source" label="Screens" stack help={<>Where the app's screens come from: <span className="text-mute">{source}</span>. Change it in the Studio server window.</>}>
        {!ui ? <Skeleton className="h-14" /> : (
          <div className="rounded-xl border border-line bg-raised px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <MonitorCog className="size-4 text-accent-ink" />
              <span className="text-sm font-medium">{ui.label}</span>
              {ui.checking && <Badge tone="info" dot>Checking</Badge>}
              {!ui.online && <Badge tone="warn" dot>Server unreachable</Badge>}
              {ui.serving === "cache" && ui.online && ui.serverBuild === ui.build && <Badge tone="ok" dot>Up to date</Badge>}
            </div>
            <p className="mono mt-1 text-2xs text-dim">
              {ui.lastCheck ? `Last check ${ago(ui.lastCheck)}` : "Not checked yet"}{ui.serverBuild ? ` · server build ${ui.serverBuild.slice(0, 6)}` : ""}
              {ui.kept?.length ? ` · ${ui.kept.length} saved build${ui.kept.length === 1 ? "" : "s"}` : ""}
            </p>
            {ui.progress && ui.progress.total > 0 && <Progress value={ui.progress.done / ui.progress.total} size="sm" className="mt-2" />}
            {!ui.originOk && ui.originReason && <StatusLine tone="bad">{ui.originReason}</StatusLine>}
            {ui.notice && <StatusLine tone="warn">{ui.notice}</StatusLine>}
            {ui.lastError && <StatusLine tone="bad">{ui.lastError}</StatusLine>}
          </div>
        )}
      </Row>
      <Row id="ui-check" label="Check for new screens now" help="The app also checks at start, every 10 minutes and whenever the connection comes back.">
        <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void check()}>Check now</Button>
      </Row>
    </Section>
  );
}

// ── library and naming ───────────────────────────────────────────────────────

export function LibrarySection() {
  const { data: s } = useDesktopSettings();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const base = useMemo(() => ({ ...DEFAULT_TEMPLATES, ...(s?.naming ?? {}) }), [s?.naming]);
  useEffect(() => { setDraft(base); }, [base]);
  const dirty = Object.keys(base).some((k) => draft[k] !== base[k]);
  const choose = async () => {
    const r = await d()?.library.chooseRoot().catch((e) => { toast.error(errText(e)); return null; });
    if (r) { toast.success(`Library folder: ${r}`); await qc.invalidateQueries({ queryKey: ["desktop"] }); }
  };
  const s2 = s as (typeof s & { autoSync?: boolean }) | undefined;
  return (
    <Section id="library" title="Library and naming" blurb="Where projects and edits live on this PC, and how their files are named">
      <Row id="library-root" label="Library folder" help="Each project gets a folder here; edits live in its Edits folder.">
        <span className="mono max-w-[22rem] truncate text-xs" title={s?.libraryRoot}>{s?.libraryRoot ?? "—"}</span>
        <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => void choose()}>Choose…</Button>
      </Row>
      <Row id="naming" label="File name templates" stack help={<>Names follow the cut: when shots move, files are renamed so the folder lists in playback order. Tokens like <span className="mono">{"{cut:03}"}</span> zero-pad.</>}>
        <div className="grid gap-2">
          {Object.keys(base).map((k) => (
            <label key={k} className="grid grid-cols-[6.5rem_1fr] items-center gap-3">
              <span className="text-xs text-mute">{k}</span>
              <Input value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} className="mono !h-8 text-xs" spellCheck={false} />
            </label>
          ))}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setDraft({ ...DEFAULT_TEMPLATES })}>Defaults</Button>
            <Button size="sm" variant="primary" disabled={!dirty} icon={<Check className="size-3.5" />}
              onClick={() => void d()?.naming.set(draft).then(() => { toast.success("Templates saved"); void qc.invalidateQueries({ queryKey: ["desktop"] }); }).catch((e) => toast.error(errText(e)))}>Save templates</Button>
          </div>
        </div>
      </Row>
      <Row id="pull-scope" label="What a sync pulls" help="Approved shots (the default), or every current take of the cut, to start before approval.">
        <Segmented size="sm" aria-label="Sync scope" value={s?.pullScope ?? "approved"} onChange={(v) => void save({ pullScope: v })}
          options={[{ value: "approved", label: "Approved" }, { value: "cut", label: "Whole cut" }]} />
      </Row>
      <Row id="auto-sync" label="Re-sync automatically" help="While a project syncs, changes on the server are pulled as they happen.">
        <Toggle checked={s2?.autoSync !== false} onChange={(v) => void save({ autoSync: v })} label={<span className="sr-only">Re-sync automatically</span>} />
      </Row>
    </Section>
  );
}

// ── rendering ────────────────────────────────────────────────────────────────

function webgl2(): string {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "WebGL2";
  } catch { return ""; }
}

export function RenderingSection() {
  const { data: s } = useDesktopSettings();
  const save = useSaveSettings();
  const enc = (s?.encoder ?? {}) as { prefer?: string; hevc10bit?: boolean; intermediateCq?: number };
  const backups = (s as unknown as { editorBackups?: { auto: boolean; minutes: number } } | undefined)?.editorBackups;
  const [gl] = useState(webgl2);
  const [presets, setPresets] = useState<{ id: string; label: string; hardware?: string | boolean }[] | null>(null);
  useEffect(() => { void d()?.render.presets().then(setPresets).catch(() => setPresets([])); }, []);
  return (
    <Section id="rendering" title="Rendering" blurb="Hardware encoders, proxies and the GPU engine">
      <Row id="encoder" label="Preferred encoder" help={presets ? `This PC: ${presets.find((p) => p.hardware)?.hardware || "no hardware encoder found (software)"}` : "Finding the encoders…"}>
        <Select value={enc.prefer ?? "auto"} onChange={(e) => void save({ encoder: { prefer: e.target.value } })} aria-label="Preferred encoder" className="!h-8 w-56 text-sm">
          <option value="auto">Automatic (fastest that works)</option><option value="nvenc">NVIDIA NVENC</option><option value="qsv">Intel Quick Sync</option>
          <option value="amf">AMD AMF</option><option value="software">Software (x264 / x265)</option>
        </Select>
      </Row>
      <Row id="ten-bit" label="10-bit HEVC for YouTube 4K" help="Smoother gradients, where the encoder test says it works.">
        <Toggle checked={enc.hevc10bit !== false} onChange={(v) => void save({ encoder: { hevc10bit: v } })} label={<span className="sr-only">10-bit HEVC</span>} />
      </Row>
      <Row id="intermediate" label="Quality of intermediate segments" help={`Constant quality ${enc.intermediateCq ?? 16} (lower is better and bigger; 16 is visually lossless).`}>
        <input type="range" min={10} max={28} step={1} value={enc.intermediateCq ?? 16} aria-label="Intermediate quality"
          onChange={(e) => void save({ encoder: { intermediateCq: Number(e.target.value) } })} className="w-48" />
      </Row>
      <Row id="proxies" label="Play 1080p proxies" help="On a slower PC the timeline plays light copies; renders always use the originals.">
        <Toggle checked={Boolean(s?.proxyMode)} onChange={(v) => void d()?.media.proxyMode(v).then(() => save({ proxyMode: v }))} label={<span className="sr-only">Proxy mode</span>} />
      </Row>
      <Row id="gpu-engine" label="GPU engine" help="Shader transitions, effects, colour and keying run in WebGL2 on the graphics card, in the preview and the final render.">
        {gl ? <Badge tone="ok" dot>WebGL2 · {gl.replace(/^ANGLE \(|\)$/g, "").slice(0, 60)}</Badge> : <Badge tone="bad" dot>WebGL2 not available</Badge>}
      </Row>
      <Row id="backups" label="Automatic studio backups of edits" help="While signed in, an edit with a studio project is uploaded when it changed.">
        <Toggle checked={backups?.auto !== false} onChange={(v) => void save({ editorBackups: { ...(backups ?? { minutes: 10 }), auto: v } })} label={<span className="sr-only">Automatic backups</span>} />
        <Select value={backups?.minutes ?? 10} onChange={(e) => void save({ editorBackups: { ...(backups ?? { auto: true }), minutes: Number(e.target.value) } })} aria-label="Every" className="!h-8 w-36 text-sm">
          {[5, 10, 15, 30, 60, 120].map((m) => <option key={m} value={m}>every {m} min</option>)}
        </Select>
      </Row>
    </Section>
  );
}

// ── AI tools on this PC ──────────────────────────────────────────────────────

export function AiToolsSection() {
  const tb = toolsBridge();
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [info, setInfo] = useState<AiToolsInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    if (!tb) { setTools([]); return; }
    setErr(null);
    tb.status().then(setTools).catch((e) => { setErr(errText(e)); setTools([]); });
    void d()?.shell?.aiTools().then(setInfo).catch(() => undefined);
  };
  useEffect(() => {
    load();
    const off = tb?.onProgress((t) => setTools((list) => (list ?? []).map((x) => (x.id === t.id ? t : x))));
    return () => off?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const install = async (t: ToolStatus) => {
    const src = info?.sources.find((s) => s.id === t.id);
    const ok = await askConfirm({ title: `Download ${t.label}?`, ok: `Download ${bytes(t.sizeBytes)}`,
      body: `${bytes(t.sizeBytes)} from ${src?.host ?? "its official release"}${src ? ` (${src.file})` : ""}. The file's size and SHA-256 are checked before it's unpacked into the app's tools folder. ${t.license ? `Licence: ${t.license}.` : ""}` });
    if (!ok || !tb) return;
    tb.install(t.id).then((r) => setTools((l) => (l ?? []).map((x) => (x.id === r.id ? r : x)))).catch((e) => toast.error(`${t.label}: ${errText(e)}`));
  };
  const remove = async (t: ToolStatus) => {
    const ok = await askConfirm({ title: `Remove ${t.label}?`, body: "It's deleted from this PC; download it again any time.", ok: "Remove" });
    if (!ok || !tb) return;
    tb.remove(t.id).then((r) => setTools((l) => (l ?? []).map((x) => (x.id === r.id ? r : x)))).catch((e) => toast.error(errText(e)));
  };
  return (
    <Section id="ai-tools" title="AI tools on this PC" blurb="Free, on your graphics card: upscaling, slow motion, speech to text and segmentation">
      <div id="i-tools" data-item="tools" className="px-5 py-3">
        {tools === null ? <LoadingRows rows={3} /> : err ? <ErrorRow message={err} onRetry={load} /> : !tb ? <StatusLine tone="warn">This desktop build has no local tools.</StatusLine> : (
          <ul className="divide-y divide-line/70">
            {tools.map((t) => {
              const src = info?.sources.find((s) => s.id === t.id);
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                  <div className="min-w-0 flex-1 basis-72">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{t.label}
                      {t.installed ? <Badge tone="ok" dot>Installed {t.version}</Badge> : <Badge>Not installed</Badge>}
                      {t.kind === "model" && <Badge tone="info">Model</Badge>}
                      {!t.platformSupported && <Badge tone="warn">Windows only</Badge>}
                    </p>
                    <p className="mt-0.5 text-2xs leading-relaxed text-dim">{t.note}</p>
                    <p className="mono mt-0.5 text-[10px] text-dim">{bytes(t.sizeBytes)} download{src ? ` · ${src.host}` : ""}{t.license ? ` · ${t.license}` : ""}{t.gpu ? ` · ${t.gpu.name}` : ""}</p>
                    {t.missing?.length ? <StatusLine tone="warn">Missing: {t.missing.join(", ")}</StatusLine> : null}
                    {t.error && <StatusLine tone="bad">{t.error}</StatusLine>}
                    {t.installing && <Progress value={t.progress} size="sm" className="mt-2 max-w-sm" />}
                  </div>
                  {t.installed
                    ? <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={t.installing} onClick={() => void remove(t)}>Remove</Button>
                    : <Button size="sm" icon={<Download className="size-3.5" />} loading={t.installing} disabled={!t.platformSupported} onClick={() => void install(t)}>Download</Button>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Row id="mediapipe" label="MediaPipe (background removal, face tracking)" help={info?.mediapipe.source ?? "Ships with the screens"}>
        {info ? (info.mediapipe.installed ? <Badge tone="ok" dot>Included · {bytes(info.mediapipe.sizeBytes)}</Badge> : <Badge tone="warn">Not in these screens</Badge>) : <Skeleton className="h-5 w-28" />}
      </Row>
    </Section>
  );
}

// ── AI assistants (desktop-mcp) ──────────────────────────────────────────────

const Assistants = loadAssistantsSettings ? lazy(loadAssistantsSettings) : null;

export function AssistantsSection() {
  const ready = Boolean(Assistants && assistantsBridge());
  return (
    <Section id="assistants" title="AI assistants" blurb="Assistants (like Claude) that can work in the editor on this PC">
      {ready && Assistants ? (
        <div id="i-assistants" data-item="assistants" className="px-5 py-4"><Suspense fallback={<LoadingRows rows={2} />}><Assistants /></Suspense></div>
      ) : (
        <Row id="assistants" label="Coming soon" help="Connect an assistant to the editor and let it make an auto edit from a folder of clips.">
          <Bot className="size-5 text-ai" />
        </Row>
      )}
    </Section>
  );
}

// ── storage ──────────────────────────────────────────────────────────────────

export function StorageSection() {
  const [r, setR] = useState<StorageReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => { setErr(null); d()?.shell?.storage().then(setR).catch((e) => setErr(errText(e))); };
  useEffect(load, []);
  const clear = async (id: string, label: string, size: number) => {
    const ok = await askConfirm({ title: `Clear ${label.toLowerCase()}?`, body: `About ${bytes(size)} is removed. It's rebuilt when it's needed.`, ok: "Clear" });
    if (!ok) return;
    setBusy(id);
    const res = await d()?.shell?.clearStorage(id).catch((e) => { toast.error(errText(e)); return null; });
    setBusy(null);
    if (res) toast.success(`${bytes(res.removedBytes)} cleared`);
    load();
  };
  return (
    <Section id="storage" title="Storage" blurb="What the app keeps on this PC, and the free space it needs"
      actions={<Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={load}>Refresh</Button>}>
      <div id="i-low-disk" data-item="low-disk" className="space-y-2.5 px-5 py-3.5">
        {err ? <ErrorRow message={err} onRetry={load} /> : !r ? <LoadingRows rows={2} /> : r.disk.drives.map((dr) => (
          <div key={dr.path} className="flex flex-wrap items-center gap-3">
            <HardDrive className={clsx("size-4", dr.low ? "text-warn" : "text-mute")} />
            <span className="w-40 text-sm font-medium">{dr.path} <span className="font-normal text-dim">· {dr.label}</span></span>
            <SpaceBar free={dr.freeBytes} total={dr.totalBytes} low={dr.low} />
            <span className={clsx("mono text-xs", dr.low ? "text-amber-300" : "text-mute")}>{bytes(dr.freeBytes)} free of {bytes(dr.totalBytes)}</span>
            {dr.low && <Badge tone="warn" dot>Below {Math.round(r.disk.thresholdBytes / 1024 ** 3)} GB</Badge>}
          </div>
        ))}
      </div>
      <div id="i-caches" data-item="caches" className="px-5 py-2">
        {r && (
          <table className="w-full table-fixed text-sm">
            <thead><tr className="text-left text-2xs uppercase tracking-wide text-dim"><th className="py-2 font-medium">Folder</th><th className="w-28 py-2 text-right font-medium">Size</th><th className="w-24" /></tr></thead>
            <tbody>
              {r.items.map((it) => (
                <tr key={it.id} className="border-t border-line/70">
                  <td className="min-w-0 py-2.5 pr-3">
                    <p className="truncate font-medium">{it.label}</p>
                    <p className="mono truncate text-[10px] text-dim" title={it.path}>{it.note ?? it.path}</p>
                  </td>
                  <td className="mono py-2.5 text-right text-xs">{bytes(it.bytes)}{it.files ? <span className="block text-[10px] text-dim">{it.files} files</span> : null}</td>
                  <td className="py-2.5 text-right">
                    {it.clearable && <Button size="sm" variant="ghost" disabled={!it.bytes} loading={busy === it.id} onClick={() => void clear(it.id, it.label, it.bytes)}>Clear</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Section>
  );
}

// ── appearance ───────────────────────────────────────────────────────────────

const SWATCHES = ["#22d3ee", "#818cf8", "#a78bfa", "#f472b6", "#fb7185", "#f97316", "#fbbf24", "#34d399", "#60a5fa"];

export function AppearanceSection() {
  const a = useAppearanceState();
  const set = (p: Partial<AppearanceSettings>) => void d()?.appearance?.set(p).catch((e) => toast.error(errText(e)));
  if (!a) return <Section id="appearance" title="Appearance"><div className="p-5"><LoadingRows rows={3} /></div></Section>;
  const custom = a.accent.startsWith("#");
  return (
    <Section id="appearance" title="Appearance" blurb="Applied at once to every window">
      <Row id="theme" label="Theme" help="Dark is made for footage; System follows Windows.">
        <Segmented aria-label="Theme" value={a.theme} onChange={(v) => set({ theme: v })}
          options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }]} />
      </Row>
      <Row id="accent" label="Accent colour" help={a.systemAccent ? `Windows accent: ${a.systemAccent}` : "Windows didn't report an accent colour"}>
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Accent colour">
          <button type="button" role="radio" aria-checked={a.accent === "system"} onClick={() => set({ accent: "system" })}
            className={clsx("h-7 rounded-lg border px-2 text-xs", a.accent === "system" ? "border-accent text-ink" : "border-line text-mute hover:text-ink")}>
            <span className="mr-1.5 inline-block size-2.5 rounded-full align-middle" style={{ background: a.systemAccent ?? "#22d3ee" }} />Windows
          </button>
          <button type="button" role="radio" aria-checked={a.accent === "tatvam"} onClick={() => set({ accent: "tatvam" })}
            className={clsx("h-7 rounded-lg border px-2 text-xs", a.accent === "tatvam" ? "border-accent text-ink" : "border-line text-mute hover:text-ink")}>
            <span className="mr-1.5 inline-block size-2.5 rounded-full bg-[#22d3ee] align-middle" />Tatvam
          </button>
          {SWATCHES.slice(1).map((c) => (
            <Tooltip key={c} content={c}>
              <button type="button" role="radio" aria-checked={a.accent === c} aria-label={`Accent ${c}`} onClick={() => set({ accent: c })}
                className={clsx("size-7 rounded-lg border-2", a.accent === c ? "border-ink" : "border-transparent")} style={{ background: c }} />
            </Tooltip>
          ))}
          <label className={clsx("relative grid size-7 cursor-pointer place-items-center overflow-hidden rounded-lg border", custom && !SWATCHES.includes(a.accent) ? "border-ink" : "border-line")} title="Any colour">
            <input type="color" value={custom ? a.accent : a.accentColor} onChange={(e) => set({ accent: e.target.value })} className="absolute inset-0 size-full cursor-pointer opacity-0" aria-label="Pick any accent colour" />
            <span className="size-4 rounded-full" style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }} />
          </label>
        </div>
      </Row>
      <Row id="density" label="Density" help="Compact fits more on a laptop screen.">
        <Segmented aria-label="Density" value={a.density} onChange={(v) => set({ density: v })} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} />
      </Row>
      <Row id="scale" label="UI scale" help="Every window, remembered (also Ctrl+Plus, Ctrl+- and Ctrl+0).">
        <input type="range" min={80} max={150} step={5} value={a.scale} onChange={(e) => set({ scale: Number(e.target.value) })} aria-label="UI scale" className="w-48" />
        <span className="mono w-12 text-right text-sm">{a.scale}%</span>
        <Button size="sm" variant="ghost" disabled={a.scale === 100} onClick={() => set({ scale: 100 })}>100%</Button>
      </Row>
      <Row id="motion" label="Reduce motion" help="Fades and slides become instant; windows open without the fade.">
        <Toggle checked={a.reduceMotion} onChange={(v) => set({ reduceMotion: v })} label={<span className="sr-only">Reduce motion</span>} />
      </Row>
      <Row id="contrast" label="High contrast" help="Stronger lines and text, thick focus rings, a solid window background.">
        <Toggle checked={a.highContrast} onChange={(v) => set({ highContrast: v })} label={<span className="sr-only">High contrast</span>} />
      </Row>
      <Row id="material" label="Window backdrop" help={a.materialSupported ? "Mica and acrylic let the desktop tint the title bar (Windows 11)." : "Mica and acrylic need Windows 11 (22H2 or later): the backdrop is solid here."}>
        <Segmented aria-label="Window backdrop" value={a.material} onChange={(v) => set({ material: v })}
          options={[{ value: "mica", label: "Mica" }, { value: "acrylic", label: "Acrylic" }, { value: "none", label: "Solid" }]} />
      </Row>
    </Section>
  );
}

// ── notifications ────────────────────────────────────────────────────────────

const KINDS: { id: NotificationKind; label: string; help: string }[] = [
  { id: "render", label: "Renders and exports", help: "Done, failed, uploaded to the Render Center" },
  { id: "ai", label: "AI jobs", help: "Local upscales, slow motion and transcripts" },
  { id: "sync", label: "Sync", help: "A sync that failed, an offline edit the server refused" },
  { id: "download", label: "Downloads", help: "A project folder synced, an AI tool installed" },
  { id: "update", label: "Updates", help: "An update is ready to install" },
  { id: "system", label: "This PC", help: "Low disk space, a window that stopped" },
];

export function NotificationsSection() {
  const st = useShellState();
  const p = st?.prefs;
  const set = (patch: Partial<ShellPrefs>) => void d()?.shell?.setPrefs(patch).catch((e) => toast.error(errText(e)));
  if (!p) return <Section id="notifications" title="Notifications"><div className="p-5"><LoadingRows rows={3} /></div></Section>;
  return (
    <Section id="notifications" title="Notifications" blurb="The bell in the status bar keeps the history"
      actions={<Button size="sm" variant="ghost" onClick={() => void d()?.notifications?.show({ kind: "system", tone: "info", title: "Test notification", body: "This is how Tatvam tells you something finished." })}>Send a test</Button>}>
      <div id="i-kinds" data-item="kinds" className="grid gap-x-6 gap-y-3 px-5 py-4 sm:grid-cols-2">
        {KINDS.map((k) => (
          <label key={k.id} className="flex cursor-pointer items-start justify-between gap-3">
            <span><span className="block text-sm font-medium">{k.label}</span><span className="block text-2xs text-dim">{k.help}</span></span>
            <Toggle checked={p.notifications[k.id]} onChange={(v) => set({ notifications: { ...p.notifications, [k.id]: v } })} label={<span className="sr-only">{k.label}</span>} />
          </label>
        ))}
      </div>
      <Row id="native" label="Windows notifications" help="When no Tatvam window has the focus, Windows shows the notification; click it to jump to the item.">
        <Toggle checked={p.notifications.native} onChange={(v) => set({ notifications: { ...p.notifications, native: v } })} label={<span className="sr-only">Windows notifications</span>} />
      </Row>
      <Row id="tray" label="Tray icon" help="The job queue with progress, Open Tatvam and Quit.">
        <Segmented aria-label="Tray icon" size="sm" value={p.tray} onChange={(v) => set({ tray: v })}
          options={[{ value: "auto", label: "While jobs run" }, { value: "always", label: "Always" }, { value: "off", label: "Never" }]} />
      </Row>
      <Row id="keep-rendering" label="Keep rendering when the window is closed" help="Closing the main window during a render hides it in the tray; the render carries on.">
        <Toggle checked={p.keepRendering} onChange={(v) => set({ keepRendering: v })} label={<span className="sr-only">Keep rendering</span>} />
      </Row>
    </Section>
  );
}

// ── shortcuts ────────────────────────────────────────────────────────────────

export function ShortcutsSection() {
  const [open, setOpen] = useState(false);
  return (
    <Section id="shortcuts" title="Shortcuts" blurb="Every window has a cheat sheet (Shift+/) built from the same list">
      <Row id="shortcut-editor" label="Editor keyboard shortcuts" help="Premiere Pro (the default), DaVinci Resolve or Final Cut Pro, plus your own changes; export and import them as JSON.">
        <Button size="sm" icon={<Keyboard className="size-3.5" />} onClick={() => setOpen(true)}>Edit shortcuts…</Button>
      </Row>
      <Row id="cheat-sheet" label="Shortcut cheat sheet" help="All the keys of this window.">
        <Button size="sm" variant="ghost" onClick={() => setOverlay("shortcuts")}>Show</Button>
      </Row>
      {open && <Suspense fallback={null}><ShortcutEditor open={open} onClose={() => setOpen(false)} /></Suspense>}
    </Section>
  );
}

// ── updates ──────────────────────────────────────────────────────────────────

export function UpdatesSection() {
  const u = useUpdate();
  const st = useShellState();
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Notes | null>(null);
  useEffect(() => {
    let alive = true;
    void loadNotes().then((n) => { if (alive) setNotes(n); });
    return () => { alive = false; };
  }, []);
  const check = async () => {
    setBusy(true);
    const s = await d()?.app.checkForUpdates().catch((e) => { toast.error(errText(e)); return null; });
    setBusy(false);
    if (s?.state === "disabled") toast.message("Updates are off in a development build");
    else if (s?.state === "none" || s?.state === "idle") toast.success("Tatvam Desktop is up to date");
    else if (s?.state === "error") toast.error(s.error ?? "Couldn't check");
  };
  const state = !u ? "…" : u.state === "disabled" ? "Off in a development build" : u.state === "ready" ? `Version ${u.version} is ready to install`
    : u.state === "downloading" ? `Downloading ${u.version ?? ""} · ${Math.round((u.progress ?? 0) * 100)}%` : u.state === "available" ? `Version ${u.version} found`
      : u.state === "checking" ? "Checking…" : u.state === "error" ? `Failed: ${u.error ?? ""}` : u.state === "none" ? "Up to date" : "Waiting for the first check";
  return (
    <Section id="updates" title="Updates" blurb={`Tatvam Studio ${desktop()?.version ?? ""} · updates come from GitHub Releases`}>
      <Row id="check" label="Status" help={state}>
        {u?.state === "ready"
          ? <Button size="sm" variant="primary" icon={<ArrowUpCircle className="size-3.5" />} onClick={() => void reloadGuardsThen(() => void d()?.app.installUpdate?.())}>Restart to update</Button>
          : <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void check()}>{u?.state === "error" ? "Retry" : "Check now"}</Button>}
      </Row>
      {u?.state === "downloading" && <div className="px-5 pb-3"><Progress value={u.progress ?? 0} size="sm" /></div>}
      <Row id="auto-install" label="Install updates when the app quits" help="A downloaded update installs the next time you quit; otherwise restart from the title bar.">
        <Toggle checked={st?.prefs.autoInstallOnQuit !== false} onChange={(v) => void d()?.shell?.setPrefs({ autoInstallOnQuit: v })} label={<span className="sr-only">Install on quit</span>} />
      </Row>
      <Row id="notes" label="Release notes" stack>
        <div className="max-h-72 overflow-y-auto rounded-xl border border-line bg-raised px-4 py-3">
          {!notes ? <LoadingRows rows={2} /> : notes.text ? <NotesView text={u?.releaseNotes && u.state === "ready" ? u.releaseNotes : notes.text} /> : <p className="text-sm text-mute">No notes on this PC for this version.</p>}
        </div>
      </Row>
    </Section>
  );
}

// ── advanced ─────────────────────────────────────────────────────────────────

export function AdvancedSection() {
  const st = useShellState();
  const [gpu, setGpu] = useState<GpuSummary | null>(null);
  useEffect(() => { void d()?.shell?.gpu().then(setGpu).catch(() => undefined); }, []);
  const reset = async (scope: "appearance" | "app" | "all") => {
    const text = { appearance: "the appearance", app: "the app's preferences (notifications, tray, updates)", all: "every setting except the server, the folders and your workspaces" }[scope];
    if (!(await askConfirm({ title: "Reset settings?", body: `This resets ${text} to the defaults.`, ok: "Reset" }))) return;
    await d()?.shell?.reset(scope).catch((e) => toast.error(errText(e)));
    toast.success("Settings reset");
  };
  return (
    <Section id="advanced" title="Advanced">
      <Row id="logs" label="Logs folder" help="Rolling logs and crash dumps stay on this PC; send them with a bug report.">
        <Button size="sm" icon={<ScrollText className="size-3.5" />} onClick={() => void d()?.app.revealLogs()}>Open logs folder</Button>
      </Row>
      <Row id="gpu" label="Graphics card" stack help={gpu?.name ? `${gpu.vendor ? `${gpu.vendor} · ` : ""}${gpu.name}${gpu.driver ? ` · driver ${gpu.driver}` : ""}` : "Reading…"}>
        {gpu && (
          <div className="flex flex-wrap gap-1">
            {Object.entries(gpu.features).map(([k, v]) => (
              <span key={k} className={clsx("mono rounded-md border px-1.5 py-0.5 text-[10px]", v.startsWith("enabled") ? "border-ok/30 text-ok" : "border-line text-dim")}>
                <Cpu className="mr-1 inline size-2.5" />{k.replace(/_/g, " ")}: {v.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        )}
      </Row>
      <Row id="restore" label="After a crash, offer to reopen the last windows">
        <Toggle checked={st?.prefs.restoreWindows !== false} onChange={(v) => void d()?.shell?.setPrefs({ restoreWindows: v })} label={<span className="sr-only">Reopen after a crash</span>} />
      </Row>
      <Row id="onboarding" label="First-run steps" help="Server, sign-in, library folder, machine check and the AI tools.">
        <Button size="sm" variant="ghost" onClick={() => void d()?.shell?.open("welcome")}>Run again</Button>
      </Row>
      <Row id="reset" label="Reset settings">
        <Button size="sm" variant="ghost" onClick={() => void reset("appearance")}>Appearance</Button>
        <Button size="sm" variant="ghost" onClick={() => void reset("app")}>App preferences</Button>
        <Button size="sm" variant="danger" onClick={() => void reset("all")}>Everything…</Button>
      </Row>
    </Section>
  );
}
