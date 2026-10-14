/**
 * Dev-only check page for the Template Designer and the Channel look panel (docs/EDITOR.md §16.8), served by the Vite
 * dev server at /src/editor/newsroom/designer/dev/index.html (never built). A throwaway edit with a made-up logo in
 * its bin; no sign-in, no desktop. Query: designer=<template id | sample | new>, clip=1 ("Change only this one" on a
 * sample graphic), look=1 (the Channel look panel), make=1 (Make my look with the made-up logo).
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import "../../../../index.css";
import "../../../editor.css";
import "../../../../pages/posters/fonts";
import { newProject } from "../../../model/defaults";
import type { EditProject, TimelineClip } from "../../../model/types";
import { loadProject, project as currentProject } from "../../../store";
import { MenuHost } from "../../../ui";
import { openDesigner } from "../../events";
import LookPanel from "../../panels/LookPanel";
import { defaults } from "../../templates/kit";
import DesignerOverlay from "../DesignerOverlay";
import { MakeMyLook } from "../MakeMyLook";
import { SAMPLE_STRAP } from "../sample";
import { clock, useDesigner } from "../state";

const q = new URLSearchParams(location.search);

function fakeLogo(): string {
  const c = document.createElement("canvas");
  c.width = 420; c.height = 160;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, 420, 160);
  g.fillStyle = "#6a1b9a"; g.beginPath(); g.arc(80, 80, 62, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#ffd54a"; g.fillRect(160, 104, 220, 16);
  g.fillStyle = "#1b1f3b"; g.font = "bold 64px sans-serif"; g.fillText("NEWS 9", 160, 92);
  g.fillStyle = "#ffffff"; g.font = "bold 54px sans-serif"; g.fillText("9", 64, 100);
  return c.toDataURL("image/png");
}

function project(): EditProject {
  const p = newProject("Designer check");
  const logo = fakeLogo();
  p.media.push({ id: "m_logo", binId: null, name: "Channel logo.png", kind: "image", path: "logo.png", url: logo, thumb: logo, duration: 0, fps: 0, width: 420, height: 160, hasAudio: false, markers: [] });
  if (q.get("clip")) {
    const s = p.sequences[0];
    const clip = {
      id: "c_strap", trackId: s.tracks[1].id, start: 0, duration: 150, name: "Name strap",
      source: { type: "graphic", gfx: { template: SAMPLE_STRAP.id, values: { ...defaults(SAMPLE_STRAP), name: "Arjun Mehta" } } },
    } as unknown as TimelineClip;
    s.clips.push(clip);
    p.newsroom = { version: 1, look: "look.classic_red", looks: {}, templates: { [SAMPLE_STRAP.id]: SAMPLE_STRAP }, ratio: "both", rundown: [], people: [], places: [], sources: [], data: {},
      settings: { safeGuides: true, collision: true, readSpeed: 3, tickerSpeed: "normal", aiLabel: true } };
  }
  return p;
}

function Harness() {
  const [make, setMake] = useState(!!q.get("make"));
  useEffect(() => {
    const d = q.get("designer");
    if (q.get("clip")) setTimeout(() => openDesigner({ template: SAMPLE_STRAP.id, clipId: "c_strap" }), 300);
    else if (d) setTimeout(() => openDesigner({ template: d }), 300);
    // sel=<layer id>, tab=fields, single=9:16 (state to show in a screenshot)
    const want = { sel: q.get("sel"), tab: q.get("tab"), single: q.get("single") };
    if (!want.sel && !want.tab && !want.single) return;
    const iv = setInterval(() => {
      if (!useDesigner.getState().open) return;
      clearInterval(iv);
      useDesigner.setState({
        ...(want.sel ? { sel: want.sel } : {}), ...(want.tab === "fields" ? { tab: "fields" } : {}),
        ...(want.single ? { view: "single", ratio: want.single as "16:9" | "9:16" } : {}),
      });
    }, 100);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="ed-root flex h-screen bg-bg text-ink">
      {q.get("look") && <div className="h-full w-[400px] border-r border-line"><LookPanel /></div>}
      <div className="grid flex-1 place-items-center text-xs text-dim">
        <div className="space-x-2">
          <button className="rounded border border-line px-3 py-1" onClick={() => openDesigner({ template: "sample" })}>Open the Designer</button>
          <button className="rounded border border-line px-3 py-1" onClick={() => setMake(true)}>Make my look</button>
        </div>
      </div>
      <DesignerOverlay />
      {make && <MakeMyLook open={make} onClose={() => setMake(false)} onUse={() => undefined} start={q.get("make") === "logo" ? { image: currentProject().media[0].url! } : undefined} />}
      <MenuHost />
      <Toaster theme="dark" position="bottom-right" />
    </div>
  );
}

/** act=<steps>: clicks for screenshots, "," separated: "btn:<text>" clicks a button by its text, "mi:<text>" a menu
 *  item, "row:<text>" a list row, "scroll:<px>" scrolls the inspector, "wait:<ms>". */
async function act(steps: string) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && !useDesigner.getState().open; i++) await sleep(100);
  await sleep(600);
  for (const s of steps.split(",")) {
    const [k, ...rest] = s.split(":");
    const v = rest.join(":");
    const byText = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].find((b) => b.textContent?.trim().startsWith(v));
    if (k === "btn") byText("button")?.click();
    else if (k === "mi") byText("[data-mi]")?.click();
    else if (k === "row") byText(".pn-row")?.click();
    else if (k === "scroll") { const el = [...document.querySelectorAll<HTMLElement>(".pn-scroll")].pop(); if (el) el.scrollTop = Number(v); }
    else if (k === "wait") await sleep(Number(v));
    await sleep(250);
  }
}
if (q.get("act")) void act(q.get("act")!);

loadProject(project(), { path: null, demo: true });
/** For checks from the browser console / automation. */
(window as unknown as { __nrd: unknown }).__nrd = { designer: useDesigner, clock, project: currentProject };
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
