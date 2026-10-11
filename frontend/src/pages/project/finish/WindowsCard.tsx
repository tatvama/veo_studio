import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { AppWindow, Download, Maximize, MonitorUp, Plus, Trash2, Upload, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SectionCard } from "../../../components/room/kit";
import { Badge, Button, Field, IconButton, Input, Modal, Select, Toggle, Tooltip } from "../../../components/ui";
import { dcall, isDesktop, PANEL_IDS, panelUrl, useDesktopQuery, type PanelId } from "../../../lib/desktop";
import { useT } from "../../../lib/i18n";
import { PANEL_META } from "../../desktop/meta";
import { Quiet, Sub } from "./parts";

/** Opens a panel in its own browser window (the web's multi-window, also a fallback inside the app). */
export function openBrowserPanel(panel: PanelId, q: { pid: number; eid: number; clean?: boolean }) {
  const w = window.open(panelUrl(panel, q), `tatvam-${panel}-${q.eid}`, "popup=yes,width=1280,height=760");
  if (!w) toast.error("The browser blocked the pop-up window. Allow pop-ups for this site and try again.");
  else w.focus();
}

/**
 * Pop-out windows for the edit: every panel in its own window, on any screen, full screen or as a clean feed, plus saved
 * workspaces (desktop). On the web the same buttons open browser windows that follow the playhead over the bus.
 */
export function WindowsCard({ pid, eid, className }: { pid: number; eid: number; className?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const displays = useDesktopQuery(["displays"], (d) => d.windows.displays(), { refetchInterval: 15_000 });
  const open = useDesktopQuery(["windows"], (d) => d.windows.list(), { refetchInterval: 3_000 });
  const workspaces = useDesktopQuery(["workspaces"], (d) => d.windows.workspaces());
  const [display, setDisplay] = useState<number | "">("");
  const [full, setFull] = useState(false);
  const [clean, setClean] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["desktop", "windows"] });
    qc.invalidateQueries({ queryKey: ["desktop", "workspaces"] });
  };

  const pop = async (panel: PanelId) => {
    const feed = clean && !!PANEL_META[panel].feed;
    if (!isDesktop) { openBrowserPanel(panel, { pid, eid, clean: feed }); return; }
    await dcall(t("Pop out"), (d) => d.windows.popOut(panel, { pid, eid, display: display === "" ? undefined : display, fullscreen: full, clean: feed }));
    refresh();
  };
  const saveWs = async () => {
    const ws = await dcall(t("Save workspace"), (d) => d.windows.saveWorkspace(name.trim()));
    if (ws) { toast.success(t("Workspace \"{name}\" saved", { name: ws.name })); setSaveOpen(false); setName(""); }
    refresh();
  };
  const exportWs = async () => {
    const path = await dcall(t("Export workspaces"), (d) => d.windows.exportWorkspaces());
    if (path) toast.success(t("Workspaces exported"), { description: path });
  };
  const importWs = async () => {
    const n = await dcall(t("Import workspaces"), (d) => d.windows.importWorkspaces());
    if (n) toast.success(t("{n} workspaces imported", { n }));
    refresh();
  };
  const displayName = (id: number) => {
    const d = displays.data?.find((x) => x.id === id);
    return d ? `${d.label}${d.primary ? ` (${t("main")})` : ""}` : t("Screen {n}", { n: id });
  };

  return (
    <SectionCard className={className} icon={<AppWindow />} title={isDesktop ? t("Windows & screens") : t("Pop-out windows")}
      description={isDesktop
        ? t("Put the program monitor, scopes and mixer on other screens. They all follow one playhead.")
        : t("Open panels in their own browser windows: they follow the timeline's playhead and selection.")}>
      <div className="@container space-y-4">
        <Sub title={t("Open a panel")}>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            {isDesktop && (
              <label className="flex items-center gap-2 text-xs text-mute">
                {t("On")}
                <Select value={display === "" ? "" : String(display)} onChange={(e) => setDisplay(e.target.value === "" ? "" : Number(e.target.value))} className="!h-8 w-auto text-xs">
                  <option value="">{t("This screen")}</option>
                  {(displays.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.label}{d.primary ? ` (${t("main")})` : ""} · {d.bounds.width}×{d.bounds.height}</option>)}
                </Select>
              </label>
            )}
            {isDesktop && <Toggle checked={full} onChange={setFull} label={<span className="text-xs">{t("Full screen")}</span>} />}
            <Tooltip content={t("Picture only, letterboxed, no controls (program and source)")}>
              <span className="inline-flex"><Toggle checked={clean} onChange={setClean} label={<span className="text-xs">{t("Clean feed")}</span>} /></span>
            </Tooltip>
          </div>
          <div className="grid gap-1.5 @md:grid-cols-2 @3xl:grid-cols-3">
            {PANEL_IDS.map((p) => {
              const m = PANEL_META[p];
              const Icon = m.icon;
              const n = (open.data ?? []).filter((w) => w.panel === p).length;
              return (
                <button key={p} type="button" onClick={() => void pop(p)}
                  className="group flex items-start gap-2.5 rounded-lg border border-line px-3 py-2 text-left transition-colors hover:border-accent/40 hover:bg-hover">
                  <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-line bg-raised text-mute group-hover:text-accent-ink"><Icon className="size-3.5" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium">{t(m.label)}{n > 0 && <Badge tone="accent">{n}</Badge>}</span>
                    <span className="mt-0.5 block text-2xs leading-snug text-dim">{t(m.blurb)}</span>
                  </span>
                  <MonitorUp className="mt-1 size-3.5 shrink-0 text-dim opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              );
            })}
          </div>
          {!isDesktop && <p className="mt-2 text-2xs text-dim">{t("Double-click a monitor to fill the screen. Tatvam Desktop also places windows on chosen screens and saves workspaces.")}</p>}
        </Sub>

        {isDesktop && (
          <Sub title={t("Open windows")}>
            {!(open.data ?? []).length ? <Quiet>{t("No panels open. Pick one above, or apply a workspace.")}</Quiet> : (
              <ul className="divide-y divide-line/60 rounded-lg border border-line">
                {(open.data ?? []).map((w) => {
                  const m = PANEL_META[w.panel as PanelId];
                  return (
                    <li key={w.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-sm">{m ? t(m.label) : w.panel}</span>
                      <Select value={String(w.display)} aria-label={t("Screen")} className="!h-7 w-auto text-xs"
                        onChange={(e) => void dcall(t("Move window"), (d) => d.windows.moveToDisplay(w.id, Number(e.target.value), w.fullscreen)).then(refresh)}>
                        {(displays.data ?? []).map((d) => <option key={d.id} value={d.id}>{displayName(d.id)}</option>)}
                        {!(displays.data ?? []).some((d) => d.id === w.display) && <option value={w.display}>{displayName(w.display)}</option>}
                      </Select>
                      <IconButton title={w.fullscreen ? t("Leave full screen") : t("Full screen")} active={w.fullscreen}
                        onClick={() => void dcall(t("Full screen"), (d) => d.windows.moveToDisplay(w.id, w.display, !w.fullscreen)).then(refresh)} className="!size-7">
                        <Maximize className="size-3.5" />
                      </IconButton>
                      <IconButton title={t("Close window")} onClick={() => void dcall(t("Close window"), (d) => d.windows.close(w.id)).then(refresh)} className="!size-7"><X className="size-3.5" /></IconButton>
                    </li>
                  );
                })}
              </ul>
            )}
          </Sub>
        )}

        {isDesktop && (
          <Sub title={t("Workspaces")} actions={<>
            <Button size="sm" variant="ghost" icon={<Upload className="size-3.5" />} onClick={importWs}>{t("Import")}</Button>
            <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={exportWs}>{t("Export")}</Button>
            <Button size="sm" variant="outline" icon={<Plus className="size-3.5" />} onClick={() => setSaveOpen(true)}>{t("Save current")}</Button>
          </>}>
            <div className="flex flex-wrap gap-1.5">
              {(workspaces.data ?? []).map((ws) => (
                <span key={ws.id} className={clsx("inline-flex items-center overflow-hidden rounded-lg border", ws.builtIn ? "border-line" : "border-accent/30")}>
                  <button type="button" onClick={() => void dcall(t("Apply workspace"), (d) => d.windows.applyWorkspace(ws.id)).then(refresh)}
                    title={ws.panels.map((p) => `${t(PANEL_META[p.panel]?.label ?? p.panel)}${p.display !== undefined ? ` → ${displayName(p.display)}` : ""}${p.fullscreen ? ` (${t("full screen")})` : ""}`).join("\n")}
                    className="px-2.5 py-1 text-xs font-medium hover:bg-hover">
                    {t(ws.name)} <span className="mono ml-1 text-2xs text-dim">{ws.panels.length}</span>
                  </button>
                  {!ws.builtIn && (
                    <button type="button" aria-label={t("Delete workspace {name}", { name: ws.name })} onClick={() => void dcall(t("Delete workspace"), (d) => d.windows.deleteWorkspace(ws.id)).then(refresh)}
                      className="grid h-full place-items-center border-l border-line px-1.5 py-1 text-dim hover:bg-hover hover:text-bad"><Trash2 className="size-3" /></button>
                  )}
                </span>
              ))}
              {!(workspaces.data ?? []).length && <Quiet className="w-full">{t("No workspaces.")}</Quiet>}
            </div>
          </Sub>
        )}
      </div>

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title={t("Save workspace")}
        footer={<>
          <Button variant="ghost" onClick={() => setSaveOpen(false)}>{t("Cancel")}</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={saveWs}>{t("Save")}</Button>
        </>}>
        <Field label={t("Name")} hint={t("Saves the open panels, their screens and full screen state.")}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t("e.g. Grade on two screens")}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) void saveWs(); }} />
        </Field>
      </Modal>
    </SectionCard>
  );
}
