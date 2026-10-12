/**
 * Assistant tokens (docs/EDITOR.md §13.1): one per assistant, `tvd_` + 32 random bytes, with a name, scopes, created
 * and last-used dates. The file (userData/assistants-tokens.json) holds each token's SHA-256 (what requests are
 * checked against, in constant time) and the token encrypted with safeStorage (Windows DPAPI), so Settings can copy it
 * into the connection snippets again. Electron-free: index.ts passes safeStorage in as the Cipher.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../config.ts";
import { ASSISTANT_SCOPES, type AssistantScope, type AssistantToken } from "../../shared/types.ts";

export interface Cipher {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(enc: string): string;
}

interface Stored extends AssistantToken { hash: string; enc?: string }

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest();

export function newTokenValue(): string {
  return `tvd_${randomBytes(32).toString("base64url")}`;
}

export function cleanScopes(s: unknown): AssistantScope[] {
  const list = Array.isArray(s) ? s.filter((x): x is AssistantScope => (ASSISTANT_SCOPES as readonly string[]).includes(x as string)) : [];
  const out = [...new Set(list)];
  if (!out.includes("read")) out.unshift("read"); // every token can look
  return ASSISTANT_SCOPES.filter((x) => out.includes(x));
}

export class TokenStore {
  private list: Stored[] = [];
  private file: string;
  private cipher: Cipher;
  private log: (m: string) => void;

  constructor(file: string, cipher: Cipher, log: (m: string) => void = () => undefined) {
    this.file = file;
    this.cipher = cipher;
    this.log = log;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(raw?.tokens)) this.list = raw.tokens.filter((t: Stored) => typeof t?.id === "string" && typeof t.hash === "string");
    } catch { /* none yet */ }
  }

  private save(): void {
    try { writeFileAtomic(this.file, JSON.stringify({ version: 1, tokens: this.list }, null, 2)); } catch (e) { this.log(`assistant tokens: ${(e as Error).message}`); }
  }

  infos(): AssistantToken[] {
    return this.list.map(({ id, name, scopes, created, lastUsed, hint }) => ({ id, name, scopes: [...scopes], created, ...(lastUsed ? { lastUsed } : {}), hint }));
  }

  create(name: string, scopes: unknown): { token: string; info: AssistantToken } {
    const n = String(name ?? "").trim().replace(/[\r\n\t]+/g, " ").slice(0, 60);
    if (!n) throw new Error("Give the token a name (the assistant it is for)");
    if (this.list.length >= 50) throw new Error("At most 50 tokens: revoke some first");
    const token = newTokenValue();
    const rec: Stored = { id: randomBytes(6).toString("hex"), name: n, scopes: cleanScopes(scopes), created: new Date().toISOString(),
      hint: `${token.slice(0, 8)}…`, hash: sha(token).toString("hex") };
    if (this.cipher.available()) {
      try { rec.enc = this.cipher.encrypt(token); } catch (e) { this.log(`assistant token encrypt: ${(e as Error).message}`); }
    }
    this.list.push(rec);
    this.save();
    return { token, info: this.infos().find((t) => t.id === rec.id)! };
  }

  revoke(id: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter((t) => t.id !== id);
    if (this.list.length !== before) this.save();
    return this.list.length !== before;
  }

  /** The token again (to copy into a snippet): only when it was kept encrypted. */
  value(id: string): string {
    const t = this.list.find((x) => x.id === id);
    if (!t) throw new Error("No such token");
    if (!t.enc || !this.cipher.available()) throw new Error("This token can't be shown again (Windows encryption wasn't available): make a new one");
    return this.cipher.decrypt(t.enc);
  }

  /** The token record for a request's bearer token, or null. Constant-time against every stored hash. */
  verify(token: string | null): AssistantToken | null {
    if (!token) return null;
    const h = sha(token);
    let hit: Stored | null = null;
    for (const t of this.list) {
      const b = Buffer.from(t.hash, "hex");
      if (b.length === h.length && timingSafeEqual(b, h)) hit = t;
    }
    return hit ? this.infos().find((x) => x.id === hit!.id)! : null;
  }

  /** Last used, written at most once a minute per token. */
  touch(id: string, now = new Date()): void {
    const t = this.list.find((x) => x.id === id);
    if (!t) return;
    const last = t.lastUsed ? Date.parse(t.lastUsed) : 0;
    t.lastUsed = now.toISOString();
    if (now.getTime() - last > 60_000) this.save();
  }
}
