/**
 * Dev-only check page for the ticker item editor (tickers/ItemsEditor.tsx), served by the Vite dev server at
 * /src/editor/newsroom/tickers/dev/index.html (never built). Shows the editor for the list fields of a few built-in
 * tickers at the Fill in panel's width, with the live value as JSON under each. Query: w=<panel px> (default 400),
 * only=<template id> to show one.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../../index.css";
import "../../../editor.css";
import { TICKERS } from "../../templates/tickers";
import type { GfxField, GfxListItem } from "../../types";
import { TickerItemsEditor } from "../ItemsEditor";

const q = new URLSearchParams(location.search);
const W = Number(q.get("w")) || 400;
const only = q.get("only");

function One({ title, field }: { title: string; field: GfxField }) {
  const [v, setV] = useState<GfxListItem[]>(field.default as GfxListItem[]);
  return (
    <section className="grid gap-2 rounded-lg border border-line bg-panel p-3" style={{ width: W }}>
      <h2 className="text-xs font-semibold text-mute">{title} · {field.label}</h2>
      <TickerItemsEditor value={v} onChange={setV} field={field} />
      <pre className="max-h-24 overflow-auto text-[10px] text-dim">{JSON.stringify(v.slice(0, 3))}{v.length > 3 ? " …" : ""}</pre>
    </section>
  );
}

function Page() {
  const lists = TICKERS.filter((t) => !only || t.id === only).flatMap((t) => t.fields.filter((f) => f.type === "list").map((f) => ({ t, f })));
  const empty: GfxField = { id: "items", label: "Ticker lines", type: "list", default: [], maxItems: 40, hint: "One line per item" };
  return (
    <div className="ed-root flex min-h-screen flex-wrap items-start gap-4 bg-bg p-4 text-ink">
      {lists.map(({ t, f }) => <One key={`${t.id}.${f.id}`} title={t.name} field={f} />)}
      {!only && <One title="Empty list" field={empty} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Page /></StrictMode>);
