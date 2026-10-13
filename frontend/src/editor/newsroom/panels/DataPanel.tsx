/**
 * News Room: data (docs/EDITOR.md §16.10). Sources from a web address (CSV, JSON, RSS / Atom, a Google Sheet link), a
 * local file, or a typed / pasted table; Refresh one or all freezes what the source says into the edit ("as of 19:42")
 * so every export repeats it, and problems are said plainly. A preview shows the rows; "Use in graphic" links the
 * selected graphic's fields to the source (whole, through a mapper such as weather or markets, or one column), each
 * change one undo step, and the graphic updates on every refresh.
 */
import { clsx } from "clsx";
import { FileText, Globe, Link2, Loader2, Plus, RefreshCw, Rss, Sheet, Table2, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button, Segmented } from "../../../components/ui";
import { useEditorHost } from "../../host";
import { select, setFocus } from "../../store";
import { addFileSource, addTableSource, addWebSource, linkField, linkSuggested, refreshSources, saveTable } from "../feeds/actions";
import { bindableFields, graphicsUsing, parseBindPath, removeSource, updateSource } from "../feeds/bind";
import { toDelimited } from "../feeds/csv";
import { canRefresh, pickTextFile, plainError } from "../feeds/load";
import { MAPPER_IDS, MAPPERS, suggestMapper } from "../feeds/mappers";
import { asOf, snapshotColumns } from "../feeds/snapshot";
import { useNewsroomDoc, useSelectedGfx } from "../room/hooks";
import { NoNewsroom } from "../room/pickers";
import type { DataSnapshot, DataSource, GfxField, GfxTemplate } from "../types";

const KIND_ICON: Record<DataSource["kind"], typeof Globe> = { csv: FileText, json: FileText, rss: Rss, sheet: Sheet, manual: Table2 };
const KIND_LABEL: Record<DataSource["kind"], string> = { csv: "CSV", json: "JSON", rss: "Feed", sheet: "Google Sheet", manual: "Table" };
const cell = (v: unknown) => (v === undefined || v === null ? "" : String(v));

export default function DataPanel() {
  const host = useEditorHost();
  const nr = useNewsroomDoc();
  const sel = useSelectedGfx();
  const [cur, setCur] = useState<string | null>(null);
  const [adding, setAdding] = useState<null | "web" | "file" | "table">(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!nr) return <div className="pn"><NoNewsroom what="Fill tickers and boards from a spreadsheet, a news feed, a web address or a table you type." /></div>;
  const sources = nr.sources;
  // the chosen source, else the one the selected graphic is linked to, else the first
  const linked = Object.values(sel?.clip.source.gfx.bind ?? {})[0]?.source;
  const src = sources.find((x) => x.id === cur) ?? sources.find((x) => x.id === linked) ?? sources[0];

  const refresh = async (ids: string[], key: string) => {
    setBusy(key);
    try { await refreshSources(host, ids); } finally { setBusy(null); }
  };
  const remove = (s: DataSource) => {
    const used = graphicsUsing(host.project(), s.id).length;
    host.apply(`Remove ${s.name}`, (d) => removeSource(d, s.id));
    toast.message(`Removed ${s.name}${used ? `. ${used === 1 ? "Its graphic keeps" : `Its ${used} graphics keep`} the last values.` : ""}`);
    if (cur === s.id) setCur(null);
  };

  return (
    <div className="pn" onPointerDown={() => setFocus("other")}>
      <div className="ed-bar gap-1.5">
        <Button size="sm" variant={adding ? "secondary" : "ghost"} icon={<Plus className="size-3.5" />} onClick={() => setAdding(adding ? null : "web")}>Add source</Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={!sources.some(canRefresh) || !!busy} icon={busy === "all" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          onClick={() => void refresh(sources.map((x) => x.id), "all")} title="Read every source again">Refresh all</Button>
      </div>
      <div className="pn-scroll">
        {adding && <AddSource mode={adding} setMode={setAdding} onAdded={(id) => { setAdding(null); setCur(id); }} />}
        {!sources.length && !adding && (
          <div className="px-4 py-6 text-center text-xs text-dim">
            <p className="mx-auto max-w-[280px]">No data sources yet. Add a news feed, a published Google Sheet, a CSV or JSON address, a file, or type a small table.</p>
            <Button size="sm" variant="primary" className="mt-3" icon={<Plus className="size-3.5" />} onClick={() => setAdding("web")}>Add source</Button>
          </div>
        )}
        {sources.map((s) => {
          const snap = nr.data[s.id];
          const Icon = s.url && s.kind !== "sheet" && s.kind !== "rss" ? Globe : KIND_ICON[s.kind];
          return (
            <div key={s.id} className={clsx("pn-row group cursor-pointer", src?.id === s.id && "sel")} onClick={() => setCur(s.id)}>
              <Icon className="size-3.5 shrink-0 text-mute" />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className={clsx("max-w-[45%] shrink-0 truncate text-2xs", snap?.error ? "text-bad" : "text-dim")} title={snap?.error ?? snap?.at}>
                {snap?.error ? (snap.rows.length ? `Refresh failed · ${asOf(snap.at)}` : snap.error) : snap ? asOf(snap.at) : "Not read yet"}
              </span>
              {canRefresh(s) && (
                <button type="button" className="ed-ibtn" title={`Refresh ${s.name}`} disabled={!!busy} onClick={(e) => { e.stopPropagation(); void refresh([s.id], s.id); }}>
                  {busy === s.id ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                </button>
              )}
              <button type="button" className="ed-ibtn opacity-0 group-hover:opacity-100" title={`Remove ${s.name}`} onClick={(e) => { e.stopPropagation(); remove(s); }}><Trash2 className="size-3.5" /></button>
            </div>
          );
        })}
        {src && <SourceDetail key={src.id} s={src} snap={nr.data[src.id]} onRefresh={() => void refresh([src.id], src.id)} />}
        {src && <UseInGraphic s={src} snap={nr.data[src.id]} sel={sel} />}
      </div>
    </div>
  );
}

// ── adding ───────────────────────────────────────────────────────────────────

function AddSource({ mode, setMode, onAdded }: { mode: "web" | "file" | "table"; setMode: (m: "web" | "file" | "table" | null) => void; onAdded: (id: string) => void }) {
  const host = useEditorHost();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [table, setTable] = useState("");
  const [busy, setBusy] = useState(false);
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  const addWeb = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try { const id = await addWebSource(host, url.trim(), name); if (id) onAdded(id); } finally { setBusy(false); }
  };
  const addFile = async () => {
    setBusy(true);
    try {
      const f = await pickTextFile();
      if (f) { const id = await addFileSource(host, f); if (id) onAdded(id); }
    } catch (e) { toast.error(plainError(e)); } finally { setBusy(false); }
  };
  const addTable = () => { const id = addTableSource(host, name || "Table", table); if (id) onAdded(id); };
  return (
    <div className="space-y-2 border-b border-line bg-raised/30 px-3 py-2.5">
      <Segmented size="sm" value={mode} onChange={(v) => setMode(v)} options={[{ value: "web", label: "Web address" }, { value: "file", label: "File" }, { value: "table", label: "Table" }]} />
      {mode === "web" && (
        <div className="space-y-1.5">
          <input className="ed-field w-full" autoFocus placeholder="https://… a feed, CSV, JSON or Google Sheet link" value={url} onKeyDown={(e) => { stop(e); if (e.key === "Enter") void addWeb(); }} onChange={(e) => setUrl(e.target.value)} />
          <input className="ed-field w-full" placeholder="Name (optional)" value={name} onKeyDown={stop} onChange={(e) => setName(e.target.value)} />
          <p className="text-[10px] leading-snug text-dim">A Google Sheet: File → Share → Publish to web → CSV, or a link anyone can view. What it says is saved in the edit; Refresh reads it again.</p>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
            <Button size="sm" variant="primary" loading={busy} disabled={!url.trim()} icon={<Link2 className="size-3.5" />} onClick={() => void addWeb()}>Add</Button>
          </div>
        </div>
      )}
      {mode === "file" && (
        <div className="space-y-1.5">
          <p className="text-[10px] leading-snug text-dim">CSV or TSV (from Excel or Sheets), JSON, an RSS or Atom feed saved as XML, or plain text. In Tatvam Desktop, Refresh reads the file again.</p>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
            <Button size="sm" variant="primary" loading={busy} icon={<FileText className="size-3.5" />} onClick={() => void addFile()}>Choose file…</Button>
          </div>
        </div>
      )}
      {mode === "table" && (
        <div className="space-y-1.5">
          <input className="ed-field w-full" placeholder="Name" value={name} onKeyDown={stop} onChange={(e) => setName(e.target.value)} />
          <textarea className="ed-field h-auto w-full resize-y py-1 font-mono text-[11px] leading-snug" rows={6} value={table} onKeyDown={stop} onChange={(e) => setTable(e.target.value)}
            placeholder={"City\tTemp\tCondition\nMumbai\t31\tRain\nDelhi\t38\tHaze"} />
          <p className="text-[10px] leading-snug text-dim">Type or paste from a spreadsheet. The first line holds the column names.</p>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={!table.trim()} icon={<Table2 className="size-3.5" />} onClick={addTable}>Add table</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── one source ───────────────────────────────────────────────────────────────

function SourceDetail({ s, snap, onRefresh }: { s: DataSource; snap: DataSnapshot | undefined; onRefresh: () => void }) {
  const host = useEditorHost();
  const [editing, setEditing] = useState(false);
  const cols = snapshotColumns(snap);
  const [text, setText] = useState(() => toDelimited(cols, snap?.rows ?? []));
  const [root, setRoot] = useState(s.root ?? "");
  const rows = snap?.rows ?? [];
  const show = cols.filter((c) => rows.some((r) => cell(r[c]) !== "")).slice(0, 8);
  const where = s.url ?? s.path;
  return (
    <div className="border-t border-line">
      <div className="pn-section cursor-default">
        <span className="flex-1 truncate">{s.name}</span>
        <span className="font-normal text-dim">{KIND_LABEL[s.kind]} · {rows.length} {rows.length === 1 ? "row" : "rows"}</span>
      </div>
      <div className="space-y-2 px-3 py-2">
        {where && <p className="truncate text-[10px] text-dim" title={where}>{where}</p>}
        {snap?.error && <p className="rounded-md border border-bad/30 bg-bad/10 px-2 py-1 text-2xs text-red-300">{snap.error}{snap.rows.length ? ` The rows below are from ${asOf(snap.at).replace(/^as of /, "")}.` : ""}</p>}
        {s.kind === "json" && (s.url || s.path) && (
          <label className="flex items-center gap-1.5 text-2xs text-mute">Rows at
            <input className="ed-field min-w-0 flex-1 font-mono" placeholder="data.items" value={root} onChange={(e) => setRoot(e.target.value)} onKeyDown={(e) => e.stopPropagation()}
              onBlur={() => { if (root !== (s.root ?? "")) { host.apply(`Change ${s.name}`, (d) => updateSource(d, s.id, { root: root.trim() || undefined })); onRefresh(); } }} />
          </label>
        )}
        {rows.length > 0 && !editing && (
          <div className="max-h-[220px] overflow-auto rounded-md border border-line">
            <table className="w-full border-collapse text-[11px]">
              <thead className="sticky top-0 bg-raised"><tr>{show.map((c) => <th key={c} className="whitespace-nowrap border-b border-line px-1.5 py-1 text-left font-medium text-mute">{c}</th>)}</tr></thead>
              <tbody>
                {rows.slice(0, 12).map((r, i) => (
                  <tr key={i} className="odd:bg-hover/30">{show.map((c) => <td key={c} className="max-w-[180px] truncate whitespace-nowrap px-1.5 py-0.5" title={cell(r[c])}>{cell(r[c])}</td>)}</tr>
                ))}
              </tbody>
            </table>
            {(rows.length > 12 || cols.length > 8) && <p className="px-1.5 py-1 text-[10px] text-dim">Showing {Math.min(12, rows.length)} of {rows.length} rows{cols.length > 8 ? ` and 8 of ${cols.length} columns` : ""}.</p>}
          </div>
        )}
        {s.kind === "manual" && (editing ? (
          <div className="space-y-1.5">
            <textarea className="ed-field h-auto w-full resize-y py-1 font-mono text-[11px] leading-snug" rows={8} value={text} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setText(e.target.value)} />
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setText(toDelimited(cols, rows)); }}>Cancel</Button>
              <Button size="sm" variant="primary" onClick={() => { if (saveTable(host, s.id, text)) setEditing(false); }}>Save table</Button>
            </div>
          </div>
        ) : <Button size="sm" variant="secondary" icon={<Table2 className="size-3.5" />} onClick={() => { setText(toDelimited(cols, rows)); setEditing(true); }}>Edit table</Button>)}
        {!canRefresh(s) && s.kind !== "manual" && <p className="text-[10px] text-dim">This file was picked in the browser: add it again to bring in new data.</p>}
      </div>
    </div>
  );
}

// ── use in graphic ───────────────────────────────────────────────────────────

const WHOLE = "*";
function optionsFor(f: GfxField, cols: string[], t: GfxTemplate): { value: string; label: string }[] {
  const m = suggestMapper(t);
  if (f.type === "list" || f.type === "table") {
    return [
      { value: WHOLE, label: m ? `Whole source (as ${MAPPERS[m].label.toLowerCase()})` : "Whole source" },
      ...MAPPER_IDS.filter((x) => x !== m).map((x) => ({ value: `@${x}`, label: `As ${MAPPERS[x].label.toLowerCase()}` })),
      ...cols.map((c) => ({ value: c, label: `Column: ${c}` })),
    ];
  }
  return [{ value: WHOLE, label: m === "ticker" || !m ? "First headline" : "First row (main column)" }, ...cols.map((c) => ({ value: c, label: c }))];
}

function UseInGraphic({ s, snap, sel }: { s: DataSource; snap: DataSnapshot | undefined; sel: ReturnType<typeof useSelectedGfx> }) {
  const host = useEditorHost();
  const cols = useMemo(() => snapshotColumns(snap), [snap]);
  const used = graphicsUsing(host.project(), s.id);
  const t = sel?.template;
  const fields = t ? bindableFields(t) : [];
  const bind = sel?.clip.source.gfx.bind ?? {};
  return (
    <div className="border-t border-line">
      <div className="pn-section cursor-default"><span className="flex-1">Use in graphic</span></div>
      <div className="space-y-2 px-3 py-2">
        {!sel || !t ? (
          <p className="text-2xs text-dim">Select a graphic on the timeline (a ticker, a weather or markets board …) to fill it from “{s.name}”.</p>
        ) : !fields.length ? (
          <p className="text-2xs text-dim">“{sel.clip.name || t.name}” has no fields that data can fill.</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{sel.clip.name || t.name}</span>
              <Button size="sm" variant="ghost" icon={<Link2 className="size-3.5" />} disabled={!snap}
                onClick={() => { const n = linkSuggested(host, sel.clip.id, t.id, s.id); toast.message(n ? `Linked ${n} ${n === 1 ? "field" : "fields"} to ${s.name}` : "Nothing to link: choose the columns below"); }}>Link suggested</Button>
            </div>
            {fields.map((f) => {
              const b = bind[f.id];
              const other = b && b.source !== s.id ? host.project().newsroom?.sources.find((x) => x.id === b.source)?.name ?? "another source" : null;
              const parsed = b && !other ? parseBindPath(b.path) : null;
              const scalar = f.type !== "list" && f.type !== "table";
              const m = suggestMapper(t);
              const value = !b ? "" : other ? "other" : parsed?.mapper ? (!scalar && parsed.mapper === m ? WHOLE : `@${parsed.mapper}`) : parsed?.column ?? WHOLE;
              const opts = optionsFor(f, cols, t);
              const row = parsed?.row !== undefined ? parsed.row + 1 : 1;
              const set = (v: string, r = row) => {
                if (!v || v === "other") { linkField(host, sel.clip.id, f.id, null, f.label); return; }
                const path = v === WHOLE ? (!scalar && m ? `@${m}` : undefined) : !v.startsWith("@") && scalar && r > 1 ? `${v}#${r}` : v;
                linkField(host, sel.clip.id, f.id, { source: s.id, ...(path ? { path } : {}) }, f.label);
              };
              return (
                <div key={f.id} className="flex items-center gap-1.5">
                  <span className="w-24 shrink-0 truncate text-2xs text-mute" title={f.label}>{f.label}</span>
                  <select className="ed-field min-w-0 flex-1" value={value} onChange={(e) => set(e.target.value)}>
                    <option value="">{other ? "Not linked" : "Typed in (not linked)"}</option>
                    {other && <option value="other">Linked to {other}</option>}
                    {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  {scalar && b && !other && parsed?.column && (
                    <label className="flex shrink-0 items-center gap-1 text-[10px] text-dim">row
                      <input type="number" min={1} max={Math.max(1, snap?.rows.length ?? 1)} value={row} className="ed-field w-12"
                        onKeyDown={(e) => e.stopPropagation()} onChange={(e) => set(parsed.column!, Math.max(1, Number(e.target.value) || 1))} />
                    </label>
                  )}
                </div>
              );
            })}
            {!snap && <p className="text-[10px] text-dim">Refresh the source first to see its columns.</p>}
          </>
        )}
        {!!used.length && (
          <p className="text-[10px] leading-relaxed text-dim">Used by{" "}
            {used.map((g, i) => (
              <span key={g.clipId}>{i ? ", " : ""}<button type="button" className="text-accent-ink hover:underline" onClick={() => select([g.clipId], "set", { linked: false })}>{g.name || "a graphic"}</button></span>
            ))}
          </p>
        )}
      </div>
    </div>
  );
}
