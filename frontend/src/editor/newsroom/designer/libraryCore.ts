/**
 * The look / template library's logic (docs/EDITOR.md §16.8–16.9), behind newsroom/library.ts: two backends (the
 * desktop bridge's files, or the browser's localStorage), checked reads, the user's ids (`look.my.<uuid>`,
 * `my.<uuid>`), imports that never clash with what's there, and change notifications. Pure: the backends are passed
 * in, so Node tests run it with fakes.
 */
import type { ChannelLook, GfxCategory, GfxTemplate } from "../types.ts";
import { checkLook, checkTemplate, parseChecked, type Checked } from "./validate.ts";

export type LibKind = "look" | "template";
export interface LibraryEntry { id: string; name: string; modified: string; category?: GfxCategory }

/** Where library files live. Every method may throw; the library turns that into empty lists / null / an error. */
export interface LibraryBackend {
  where: "desktop" | "browser";
  list(k: LibKind): Promise<{ id: string; name: string; modified: string; category?: GfxCategory }[]>;
  read(k: LibKind, id: string): Promise<string | null>;
  write(k: LibKind, id: string, json: string): Promise<void>;
  remove(k: LibKind, id: string): Promise<void>;
}

/** The part of the desktop bridge the library uses. */
export interface LibraryBridge {
  libraryList(k: LibKind): Promise<{ id: string; name: string; modified: string }[]>;
  libraryRead(k: LibKind, id: string): Promise<string | null>;
  libraryWrite(k: LibKind, id: string, json: string): Promise<{ path: string }>;
  libraryDelete(k: LibKind, id: string): Promise<void>;
}
export function bridgeBackend(b: LibraryBridge): LibraryBackend {
  return {
    where: "desktop",
    list: async (k) => (await b.libraryList(k)).map((e) => ({ id: e.id, name: e.name, modified: e.modified })),
    read: (k, id) => b.libraryRead(k, id),
    write: async (k, id, json) => { await b.libraryWrite(k, id, json); },
    remove: (k, id) => b.libraryDelete(k, id),
  };
}

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
type Index = Record<string, { name: string; modified: string; category?: GfxCategory }>;
const indexKey = (k: LibKind) => `tatvam.newsroom.library.${k}s`;
const itemKey = (k: LibKind, id: string) => `tatvam.newsroom.library.${k}.${id}`;

/** The browser's library: an index of names plus one item per look or template. A full storage says so plainly. */
export function storageBackend(s: StorageLike | null): LibraryBackend {
  const need = () => { if (!s) throw new Error("This browser can't keep a library (storage is off)."); return s; };
  const readIndex = (k: LibKind): Index => {
    try { const v = JSON.parse(need().getItem(indexKey(k)) ?? "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v as Index : {}; } catch { return {}; }
  };
  const put = (key: string, v: string) => {
    try { need().setItem(key, v); } catch (e) {
      throw new Error((e as Error)?.name === "QuotaExceededError" ? "The browser's storage is full: delete a look or template, or use the desktop app." : (e as Error)?.message ?? "Couldn't save.");
    }
  };
  return {
    where: "browser",
    list: async (k) => Object.entries(readIndex(k)).map(([id, e]) => ({ id, name: e.name, modified: e.modified, ...(e.category ? { category: e.category } : {}) })),
    read: async (k, id) => { try { return need().getItem(itemKey(k, id)); } catch { return null; } },
    write: async (k, id, json) => {
      let name = id, category: GfxCategory | undefined;
      try { const v = JSON.parse(json) as { name?: unknown; category?: unknown }; if (typeof v.name === "string") name = v.name; if (typeof v.category === "string") category = v.category as GfxCategory; } catch { /* checked by the caller */ }
      put(itemKey(k, id), json);
      const ix = readIndex(k);
      ix[id] = { name, modified: new Date().toISOString(), ...(category ? { category } : {}) };
      put(indexKey(k), JSON.stringify(ix));
    },
    remove: async (k, id) => {
      const ix = readIndex(k);
      delete ix[id];
      try { need().removeItem(itemKey(k, id)); } catch { /* gone already */ }
      put(indexKey(k), JSON.stringify(ix));
    },
  };
}

// ── ids ──────────────────────────────────────────────────────────────────────

export const MY_LOOK_ID = /^look\.my\.[A-Za-z0-9_-]{4,64}$/;
export const MY_TEMPLATE_ID = /^my\.[A-Za-z0-9_-]{4,64}$/;
function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => { const r = (Math.random() * 16) | 0; return (ch === "x" ? r : (r & 3) | 8).toString(16); });
}
export const newLookId = () => `look.my.${uuid()}`;
export const newTemplateId = () => `my.${uuid()}`;
export const isMyTemplate = (id: string) => MY_TEMPLATE_ID.test(id);
export const isMyLook = (id: string) => MY_LOOK_ID.test(id);

// ── the library ──────────────────────────────────────────────────────────────

export interface Library {
  listLooks(): Promise<LibraryEntry[]>;
  loadLook(id: string): Promise<ChannelLook | null>;
  saveLook(l: ChannelLook): Promise<void>;
  deleteLook(id: string): Promise<void>;
  listTemplates(): Promise<LibraryEntry[]>;
  loadTemplate(id: string): Promise<GfxTemplate | null>;
  saveTemplate(t: GfxTemplate): Promise<void>;
  deleteTemplate(id: string): Promise<void>;
  /** A look file's JSON → a checked look with a library id that doesn't clash (a fresh one when needed). */
  parseLook(json: string, taken: ReadonlySet<string>): Checked<ChannelLook>;
  parseTemplate(json: string, taken: ReadonlySet<string>): Checked<GfxTemplate>;
  onChange(cb: () => void): () => void;
  where(): "desktop" | "browser";
}

const byNewest = (a: LibraryEntry, b: LibraryEntry) => b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name);

export function createLibrary(backend: () => LibraryBackend, fallbackLook: () => ChannelLook, log: (msg: string) => void = () => undefined): Library {
  const subs = new Set<() => void>();
  const changed = () => subs.forEach((f) => { try { f(); } catch { /* a listener's problem */ } });
  /** Template categories by id + modified (the desktop list has names only). */
  const cats = new Map<string, GfxCategory | undefined>();
  const safeList = async (k: LibKind) => { try { return await backend().list(k); } catch (e) { log(`library: ${(e as Error).message}`); return []; } };
  const readChecked = async <T,>(k: LibKind, id: string, check: (v: unknown) => Checked<T>): Promise<T | null> => {
    let json: string | null = null;
    try { json = await backend().read(k, id); } catch (e) { log(`library: ${(e as Error).message}`); return null; }
    if (!json) return null;
    const r = parseChecked(json, check);
    if (!r.ok) { log(`library: ${k} ${id}: ${r.reason}`); return null; }
    return r.value;
  };
  const lookCheck = (v: unknown) => checkLook(v, fallbackLook());
  const fresh = <T extends { id: string; name: string }>(v: T, mine: (id: string) => boolean, make: () => string, taken: ReadonlySet<string>): T => {
    if (!mine(v.id) || taken.has(v.id)) v.id = make();
    return v;
  };

  return {
    where: () => backend().where,
    async listLooks() {
      return (await safeList("look")).filter((e) => isMyLook(e.id)).map((e) => ({ id: e.id, name: e.name, modified: e.modified })).sort(byNewest);
    },
    loadLook: (id) => readChecked("look", id, lookCheck),
    async saveLook(l) {
      if (!isMyLook(l.id)) throw new Error("Only your own looks are saved to the library (ready looks never change).");
      const r = lookCheck(l);
      if (!r.ok) throw new Error(r.reason);
      await backend().write("look", l.id, JSON.stringify(r.value, null, 1));
      changed();
    },
    async deleteLook(id) { await backend().remove("look", id); changed(); },
    async listTemplates() {
      const list = (await safeList("template")).filter((e) => isMyTemplate(e.id));
      const out: LibraryEntry[] = [];
      for (const e of list) {
        let category = e.category;
        if (!category) {
          const key = `${e.id}|${e.modified}`;
          if (!cats.has(key)) cats.set(key, (await readChecked("template", e.id, checkTemplate))?.category);
          category = cats.get(key);
        }
        out.push({ id: e.id, name: e.name, modified: e.modified, ...(category ? { category } : {}) });
      }
      return out.sort(byNewest);
    },
    loadTemplate: (id) => readChecked("template", id, checkTemplate),
    async saveTemplate(t) {
      if (!isMyTemplate(t.id)) throw new Error("Only your own templates are saved to the library (built-in ones never change).");
      const r = checkTemplate(t);
      if (!r.ok) throw new Error(r.reason);
      await backend().write("template", t.id, JSON.stringify(r.value, null, 1));
      changed();
    },
    async deleteTemplate(id) { await backend().remove("template", id); changed(); },
    parseLook(json, taken) {
      const r = parseChecked(json, lookCheck);
      return r.ok ? { ok: true, value: fresh(r.value, isMyLook, newLookId, taken) } : r;
    },
    parseTemplate(json, taken) {
      const r = parseChecked(json, checkTemplate);
      if (!r.ok) return r;
      const t = fresh(r.value, isMyTemplate, newTemplateId, taken);
      if (t.source === "builtin" || !t.source) t.source = "imported";
      return { ok: true, value: t };
    },
    onChange(cb) { subs.add(cb); return () => { subs.delete(cb); }; },
  };
}
