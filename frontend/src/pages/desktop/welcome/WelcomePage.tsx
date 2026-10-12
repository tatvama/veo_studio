/**
 * First run (five steps, each can be skipped): the studio server (or working offline with local edits only), signing
 * in, the library folder (names follow the cut), the graphics card and encoder check, and the optional AI tool
 * downloads (each asks first). Help → Getting started… opens it again.
 */
import { clsx } from "clsx";
import { ArrowLeft, ArrowRight, Check, CircleAlert, CircleCheck, Cpu, FolderOpen, HardDrive, Server, Sparkles, Stethoscope, UserRound, WifiOff } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Badge, Button, Skeleton, Toggle } from "../../../components/ui";
import { errText, useOfflineStatus, useShellState } from "../../../desktop/bridge";
import { bytes, desktop, useDesktopInfo, type MachineReport } from "../../../lib/desktop";
import { useAuthStatus } from "../../../lib/queries";
import { useQueryClient } from "@tanstack/react-query";
import { DesktopPage, ErrorRow } from "../DesktopPage";
import { AiToolsSection } from "../settings/sections";

const STEPS = [
  { id: "server", title: "Studio server", icon: Server },
  { id: "signin", title: "Sign in", icon: UserRound },
  { id: "library", title: "Library folder", icon: FolderOpen },
  { id: "machine", title: "Graphics and encoders", icon: Cpu },
  { id: "tools", title: "AI tools", icon: Sparkles },
] as const;

function Step({ title, lead, children }: { title: string; lead: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-mute">{lead}</p>
      </div>
      {children}
    </div>
  );
}

function ServerStep({ offline, setOffline }: { offline: boolean; setOffline: (v: boolean) => void }) {
  const { data: info } = useDesktopInfo();
  const net = useOfflineStatus();
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async () => {
    setTest(null);
    try {
      const r = await fetch("/api/health/live", { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { version?: string };
      setTest(r.ok && !r.headers.get("X-Tatvam-Offline") ? { ok: true, text: `Connected${j.version ? ` · server ${j.version}` : ""}` } : { ok: false, text: "The server can't be reached right now" });
    } catch { setTest({ ok: false, text: "The server can't be reached right now" }); }
  };
  useEffect(() => { void run(); }, [info?.serverUrl]);
  return (
    <Step title="Connect to your studio server" lead="Logins, approvals, AI jobs and costs live on the studio server; this app finishes the cut on your PC.">
      <div className="rounded-2xl border border-line bg-panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Server className="size-5 text-accent-ink" />
          <span className="mono min-w-0 flex-1 truncate text-sm">{info?.serverUrl ?? "—"}</span>
          {test ? <Badge tone={test.ok ? "ok" : "warn"} dot>{test.text}</Badge> : <Skeleton className="h-5 w-24" />}
          <Button size="sm" onClick={() => void run()}>Test again</Button>
          <Button size="sm" variant="primary" onClick={() => void desktop()?.app.openConnection()}>Change server…</Button>
        </div>
        {net && !net.online && <p className="mt-2 text-2xs text-amber-300">{net.lastError ?? "Offline"}</p>}
      </div>
      <label className="flex items-start gap-3 rounded-2xl border border-line bg-panel p-4">
        <WifiOff className="mt-0.5 size-5 text-mute" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Work offline: local edits only</span>
          <span className="block text-2xs leading-relaxed text-dim">The Tatvam Editor works on files on this PC without a server. Studio projects, AI jobs and the Render Center come back when you connect. You need to have signed in once.</span>
        </span>
        <Toggle checked={offline} onChange={setOffline} label={<span className="sr-only">Work offline</span>} />
      </label>
    </Step>
  );
}

function SigninStep({ offline }: { offline: boolean }) {
  const { data } = useAuthStatus();
  const qc = useQueryClient();
  const u = data?.user;
  return (
    <Step title="Sign in" lead={offline ? "You chose to work offline: signing in can wait until you connect." : "Your account decides which projects you see and what you may approve or spend."}>
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel p-4">
        {u ? <CircleCheck className="size-5 text-ok" /> : <CircleAlert className="size-5 text-warn" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{u ? `Signed in as ${u.name}` : "Not signed in"}</p>
          {u && <p className="text-2xs text-dim">{u.email} · {u.role}</p>}
        </div>
        <Button size="sm" variant="ghost" onClick={() => void qc.invalidateQueries({ queryKey: ["auth"] })}>Refresh</Button>
      </div>
    </Step>
  );
}

function LibraryStep() {
  const { data: info } = useDesktopInfo();
  const qc = useQueryClient();
  const choose = async () => {
    const r = await desktop()?.library.chooseRoot().catch((e) => { toast.error(errText(e)); return null; });
    if (r) { await qc.invalidateQueries({ queryKey: ["desktop"] }); toast.success("Library folder chosen"); }
  };
  return (
    <Step title="Choose the library folder" lead="Every project gets a folder here with its takes, sound, captions, renders and edits. Pick a fast drive with room: 4K renders are big.">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel p-4">
        <FolderOpen className="size-5 text-accent-ink" />
        <span className="mono min-w-0 flex-1 truncate text-sm" title={info?.libraryRoot}>{info?.libraryRoot ?? "—"}</span>
        <Button size="sm" variant="primary" onClick={() => void choose()}>Choose…</Button>
      </div>
      <div className="rounded-2xl border border-line bg-panel p-4">
        <p className="text-sm font-medium">Names follow the cut</p>
        <p className="mt-1 text-2xs leading-relaxed text-dim">Files are named from the cut, so the folder always lists in playback order. When a shot moves to the front, its files are renamed before the others, and Premiere or DaVinci see the same order through the EDL and FCPXML.</p>
        <div className="mono mt-3 grid gap-1 text-[11px]">
          <span className="text-dim">Kaali_S01E02_<b className="text-accent-ink">001</b>_SC02_SH003_video_T02.mp4</span>
          <span className="text-dim">Kaali_S01E02_<b className="text-accent-ink">002</b>_SC01_SH001_video_T01.mp4</span>
          <span className="text-dim">Kaali_S01E02_<b className="text-accent-ink">003</b>_SC01_SH002_video_T03.mp4</span>
        </div>
      </div>
    </Step>
  );
}

function MachineStep() {
  const [r, setR] = useState<MachineReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try { setR(await desktop()!.media.machineCheck()); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  useEffect(() => { void run(); }, []);
  const ok = (r?.encoders ?? []).filter((e) => e.ok && e.hardware);
  return (
    <Step title="Check the graphics card and encoders" lead="The check finds FFmpeg, test-encodes on NVENC, Quick Sync and AMF, and compares this PC with the editing baseline (RTX 3060, 32 GB, NVMe).">
      {err ? <ErrorRow message={err} onRetry={() => void run()} /> : !r ? (
        <div className="rounded-2xl border border-line bg-panel p-4"><div className="flex items-center gap-2 text-sm text-mute"><Stethoscope className="size-4 animate-pulse" />Checking this PC…</div><Skeleton className="mt-3 h-20" /></div>
      ) : (
        <div className="space-y-3 rounded-2xl border border-line bg-panel p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={r.verdict === "ok" ? "ok" : r.verdict === "bad" ? "bad" : "warn"} dot>{r.verdict === "ok" ? "Meets the baseline" : r.verdict === "bad" ? "Below the baseline" : "Partly below the baseline"}</Badge>
            <Badge tone={ok.length ? "ok" : "warn"}>{ok.length ? `Hardware encoding: ${ok.map((e) => e.label ?? e.id).join(", ")}` : "No hardware encoder: renders use the CPU"}</Badge>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void run()}>Check again</Button>
          </div>
          <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
            {(r.gpus ?? []).map((g, i) => <div key={i} className="flex gap-2"><dt className="w-20 text-dim">GPU</dt><dd className="min-w-0 truncate">{g.name}{g.vramBytes ? ` · ${bytes(g.vramBytes)}` : ""}</dd></div>)}
            {r.cpu && <div className="flex gap-2"><dt className="w-20 text-dim">CPU</dt><dd className="min-w-0 truncate">{r.cpu}</dd></div>}
            {r.ramBytes !== undefined && <div className="flex gap-2"><dt className="w-20 text-dim">Memory</dt><dd>{bytes(r.ramBytes)}</dd></div>}
            {r.disk && <div className="flex gap-2"><dt className="w-20 text-dim"><HardDrive className="inline size-3.5" /> Disk</dt><dd>{bytes(r.disk.freeBytes)} free{r.disk.kind ? ` · ${r.disk.kind}` : ""}</dd></div>}
          </dl>
          {(r.notes ?? []).slice(0, 3).map((n, i) => <p key={i} className="text-2xs leading-relaxed text-dim">{n}</p>)}
        </div>
      )}
    </Step>
  );
}

export default function WelcomePage() {
  const nav = useNavigate();
  const st = useShellState();
  const [i, setI] = useState(0);
  const [offline, setOffline] = useState(false);
  useEffect(() => { if (st) setOffline(st.offlineOnly); }, [st?.offlineOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  const finish = async () => {
    await desktop()?.shell?.finishOnboarding({ offlineOnly: offline }).catch(() => undefined);
    nav("/desktop/panel/start", { replace: true });
  };
  const next = () => (i < STEPS.length - 1 ? setI(i + 1) : void finish());
  const step = STEPS[i];
  return (
    <DesktopPage title="Welcome">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="eyebrow !text-accent-ink">Welcome to Tatvam Studio</p>
            <p className="text-sm text-mute">Five quick steps. Skip any of them; everything is in Settings later.</p>
          </div>
          <Button variant="ghost" onClick={() => void finish()}>Skip all</Button>
        </div>
        <ol className="mb-6 grid grid-cols-5 gap-2" aria-label="Steps">
          {STEPS.map((s, k) => {
            const I = s.icon;
            const done = k < i;
            return (
              <li key={s.id}>
                <button type="button" onClick={() => setI(k)} aria-current={k === i ? "step" : undefined}
                  className={clsx("flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-xs transition-colors",
                    k === i ? "border-accent/50 bg-accent/8 text-ink" : done ? "border-line text-mute hover:bg-hover" : "border-line text-dim hover:bg-hover")}>
                  <span className={clsx("grid size-6 shrink-0 place-items-center rounded-full border", done ? "border-ok/40 bg-ok/15 text-ok" : k === i ? "border-accent/50 text-accent-ink" : "border-line")}>
                    {done ? <Check className="size-3.5" /> : <I className="size-3.5" />}
                  </span>
                  <span className="hidden truncate sm:inline">{s.title}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="min-h-[320px]">
          {step.id === "server" && <ServerStep offline={offline} setOffline={setOffline} />}
          {step.id === "signin" && <SigninStep offline={offline} />}
          {step.id === "library" && <LibraryStep />}
          {step.id === "machine" && <MachineStep />}
          {step.id === "tools" && (
            <Step title="AI tools on this PC (optional)" lead="Free upscaling, slow motion and speech to text on your graphics card. Each download asks first and shows its size and source; you can add them later.">
              <AiToolsSection />
            </Step>
          )}
        </div>
        <div className="mt-8 flex items-center justify-between border-t border-line pt-4">
          <Button variant="ghost" icon={<ArrowLeft className="size-4" />} disabled={i === 0} onClick={() => setI(i - 1)}>Back</Button>
          <span className="text-2xs text-dim">Step {i + 1} of {STEPS.length}</span>
          <div className="flex gap-2">
            {i < STEPS.length - 1 && <Button variant="ghost" onClick={() => setI(i + 1)}>Skip</Button>}
            <Button variant="primary" iconRight={i < STEPS.length - 1 ? <ArrowRight className="size-4" /> : <Check className="size-4" />} onClick={next}>
              {i < STEPS.length - 1 ? "Next" : "Finish"}
            </Button>
          </div>
        </div>
      </div>
    </DesktopPage>
  );
}
