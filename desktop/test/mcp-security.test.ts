/**
 * The local MCP server's rules (src/main/mcp/security.ts, folders.ts, tokens.ts; docs/EDITOR.md §13.1): the Host and
 * Origin checks, no CORS, bearer tokens and scopes, the rate limit, the folder allow-list with its prompt (Allow
 * once / Always / Deny, a Deny after the timeout), export path confinement and the readable file types.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FolderGuard } from "../src/main/mcp/folders.ts";
import {
  bearerOf, exportDirAllowed, folderDecision, fromBrowser, gate, hostAllowed, inside, RateLimiter, readableType, safeOutputName,
} from "../src/main/mcp/security.ts";
import { cleanScopes, TokenStore, type Cipher } from "../src/main/mcp/tokens.ts";
import { sanitizeAssistants, effectivePort } from "../src/main/mcp/settings.ts";

const fakeCipher: Cipher = { available: () => true, encrypt: (s) => Buffer.from(s).toString("base64"), decrypt: (b) => Buffer.from(b, "base64").toString() };

test("Host: only the loopback name and the right port", () => {
  assert.equal(hostAllowed("127.0.0.1:18911", 18911), true);
  assert.equal(hostAllowed("localhost:18911", 18911), true);
  assert.equal(hostAllowed("LOCALHOST:18911", 18911), true);
  assert.equal(hostAllowed("127.0.0.1:18912", 18911), false, "another port");
  assert.equal(hostAllowed("evil.example:18911", 18911), false, "DNS rebinding: a public name pointed at 127.0.0.1");
  assert.equal(hostAllowed("127.0.0.1", 18911), false, "no port");
  assert.equal(hostAllowed(undefined, 18911), false);
  assert.equal(hostAllowed("192.168.1.5:18911", 18911), false, "LAN address");
});

test("Origin: any browser request is refused; MCP apps send none", () => {
  assert.equal(fromBrowser({ origin: "https://evil.example" }), "Origin");
  assert.equal(fromBrowser({ origin: "null" }), "Origin", "sandboxed iframes send Origin: null");
  assert.equal(fromBrowser({ "sec-fetch-site": "cross-site" }), "Sec-Fetch-Site", "every browser request to 127.0.0.1 carries it");
  assert.equal(fromBrowser({ "sec-fetch-mode": "cors" }), null, "Node's fetch (Claude Code, the relay) sends Sec-Fetch-Mode only");
  assert.equal(fromBrowser({ "content-type": "application/json", authorization: "Bearer x" }), null);
});

test("gate: Host, browsers, CORS preflight, the path and the method, in that order", () => {
  const ok = { host: "127.0.0.1:18911" };
  assert.equal(gate({ method: "POST", url: "/mcp", headers: ok }, 18911), null);
  assert.equal(gate({ method: "POST", url: "/mcp", headers: { host: "evil.example:18911" } }, 18911)?.status, 421);
  assert.equal(gate({ method: "POST", url: "/mcp", headers: { ...ok, origin: "http://localhost:3000" } }, 18911)?.status, 403);
  assert.equal(gate({ method: "OPTIONS", url: "/mcp", headers: ok }, 18911)?.status, 405, "a CORS preflight is never answered");
  assert.equal(gate({ method: "POST", url: "/other", headers: ok }, 18911)?.status, 404);
  assert.equal(gate({ method: "PUT", url: "/mcp", headers: ok }, 18911)?.status, 405);
  assert.equal(gate({ method: "GET", url: "/mcp?x=1", headers: ok }, 18911), null);
});

test("bearer: only tvd_ tokens in an Authorization: Bearer header", () => {
  assert.equal(bearerOf("Bearer tvd_abcdefghijklmnopqrstuvwxyz012345"), "tvd_abcdefghijklmnopqrstuvwxyz012345");
  assert.equal(bearerOf("Bearer tvm_abcdefghijklmnopqrstuvwxyz012345"), null, "the studio's own tokens aren't these");
  assert.equal(bearerOf("Basic dXNlcjpwYXNz"), null);
  assert.equal(bearerOf(undefined), null);
  assert.equal(bearerOf("Bearer tvd_short"), null);
});

test("tokens: hashed, encrypted, verified in constant time, scoped, revocable", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tvd-tokens-"));
  try {
    const file = path.join(dir, "t.json");
    const store = new TokenStore(file, fakeCipher);
    const a = store.create("Claude Desktop", ["edit"]);
    assert.match(a.token, /^tvd_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(a.info.scopes, ["read", "edit"], "read always comes with a token");
    assert.equal(a.info.hint, `${a.token.slice(0, 8)}…`);
    const b = store.create("Codex", ["read", "export", "spend", "bogus"]);
    assert.deepEqual(b.info.scopes, ["read", "export", "spend"]);
    assert.equal(store.verify(a.token)?.id, a.info.id);
    assert.equal(store.verify(b.token)?.name, "Codex");
    assert.equal(store.verify(`${a.token.slice(0, -1)}x`), null);
    assert.equal(store.verify(null), null);
    // the file keeps no plain token: only the hash and the encrypted copy
    const again = new TokenStore(file, fakeCipher);
    assert.equal(again.verify(a.token)?.id, a.info.id);
    assert.equal(again.value(a.info.id), a.token);
    assert.ok(!readFileSync(file, "utf8").includes(a.token));
    assert.equal(again.revoke(a.info.id), true);
    assert.equal(again.verify(a.token), null);
    assert.throws(() => store.create("  ", ["read"]), /name/);
    assert.deepEqual(cleanScopes(["spend"]), ["read", "spend"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rate limit: a sliding window per key", () => {
  const r = new RateLimiter(3, 1000);
  assert.equal(r.take("a", 0), true);
  assert.equal(r.take("a", 10), true);
  assert.equal(r.take("a", 20), true);
  assert.equal(r.take("a", 30), false);
  assert.equal(r.take("b", 30), true, "keys are separate");
  assert.equal(r.retryAfter("a", 30), 1);
  assert.equal(r.take("a", 1001), true, "the window slides");
});

test("folders: the library and listed folders are allowed, system folders refused, others ask", () => {
  const roots = { library: "D:\\Tatvam Projects", folders: ["E:\\Shoots"], session: ["F:\\Once"] };
  assert.equal(folderDecision("D:\\Tatvam Projects\\Edits\\A\\A.tatvamedit", roots), "allowed");
  assert.equal(folderDecision("E:\\Shoots\\Day1\\clip.mp4", roots), "allowed");
  assert.equal(folderDecision("e:\\shoots\\day1", roots), "allowed", "case-insensitive");
  assert.equal(folderDecision("F:\\Once\\x.wav", roots), "allowed");
  assert.equal(folderDecision("E:\\ShootsOther\\a.mp4", roots), "ask", "a sibling with the same prefix isn't inside");
  assert.equal(folderDecision("G:\\Elsewhere\\a.mp4", roots), "ask");
  assert.equal(folderDecision("relative\\a.mp4", roots), "refused");
  if (process.platform === "win32") assert.equal(folderDecision(path.join(process.env.SystemRoot || "C:\\Windows", "System32"), roots), "refused");
  assert.equal(inside("D:\\A", "D:\\A"), true);
});

test("folder prompt: Allow once (this session), Always (saved), Deny, and Deny after the timeout", async () => {
  const shown: { id: string; folder: string; client: string }[] = [];
  const closed: string[] = [];
  const saved: string[] = [];
  const g = new FolderGuard({ libraryRoot: () => "D:\\Lib", folders: () => saved, addFolder: (f) => saved.push(f),
    show: (p) => shown.push(p), close: (id) => closed.push(id), timeoutMs: 60 });
  // once
  const p1 = g.check("G:\\Shoot\\a.mp4", { session: "s1", client: "Claude Desktop", why: "import" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].folder, path.resolve("G:\\Shoot"));
  assert.equal(shown[0].client, "Claude Desktop");
  g.answer(shown[0].id, "once");
  await p1;
  assert.equal(g.decide("G:\\Shoot\\b.mp4", "s1"), "allowed", "allowed for this session");
  assert.equal(g.decide("G:\\Shoot\\b.mp4", "s2"), "ask", "not for another session");
  // deny
  const p2 = g.check("H:\\Private\\x.mov", { session: "s1", client: "Codex", why: "import" });
  await new Promise((r) => setTimeout(r, 5));
  g.answer(shown[1].id, "deny");
  await assert.rejects(p2, /didn't allow/);
  // always
  const p3 = g.check("J:\\Footage\\y.mov", { session: "s3", client: "Codex", why: "import" });
  await new Promise((r) => setTimeout(r, 5));
  g.answer(shown[2].id, "always");
  await p3;
  assert.deepEqual(saved, [path.resolve("J:\\Footage")]);
  // no answer: denied after the timeout, and the prompt is taken away
  const p4 = g.check("K:\\Slow\\z.mov", { session: "s1", client: "Claude Code", why: "import" });
  await assert.rejects(p4, /didn't answer within 60 s/);
  assert.ok(closed.includes(shown[3].id));
  // two callers asking about one folder share one prompt
  const a = g.ask("L:\\Same", "A", "x");
  const b = g.ask("L:\\Same", "B", "y");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(shown.length, 5);
  g.answer(shown[4].id, "once");
  assert.deepEqual(await Promise.all([a, b]), ["once", "once"]);
});

test("exports go only into the library's Renders folders; names are never paths", () => {
  const lib = "D:\\Tatvam Projects";
  const ok = exportDirAllowed("D:\\Tatvam Projects\\Edits\\Lighthouse\\Lighthouse.tatvamedit", lib);
  assert.equal(ok.ok, true);
  assert.equal(ok.dir, path.join("D:\\Tatvam Projects\\Edits\\Lighthouse", "Renders"));
  const bad = exportDirAllowed("C:\\Users\\x\\Desktop\\Mine.tatvamedit", lib);
  assert.equal(bad.ok, false);
  assert.match(bad.reason ?? "", /isn't in the library/);
  assert.equal(safeOutputName("Final cut"), "Final cut");
  assert.equal(safeOutputName(undefined), undefined);
  assert.throws(() => safeOutputName("..\\..\\Windows\\evil"), /plain name/);
  assert.throws(() => safeOutputName("C:/x"), /plain name/);
});

test("only media and interchange files are read", () => {
  for (const f of ["a.mp4", "b.MOV", "c.wav", "d.png", "e.tatvamedit", "f.xml", "g.edl", "h.otio", "i.srt", "j.cube"]) assert.equal(readableType(f), true, f);
  for (const f of ["a.exe", "b.ps1", "c.docx", "id_rsa", "d.json", "e.txt", "settings.json"]) assert.equal(readableType(f), false, f);
});

test("settings: off by default, a valid port, folders de-duplicated, TATVAM_MCP_PORT for a run", () => {
  const d = sanitizeAssistants(undefined);
  assert.deepEqual(d, { enabled: false, port: 18110, folders: [], watches: [] });
  const s = sanitizeAssistants({ enabled: true, port: 80, folders: ["D:\\A", "d:\\a", "rel"], watches: [{ id: "w1abc", folder: "D:\\W", editPath: "D:\\E\\E.tatvamedit", style: "montage", mode: "rebuild" }, { id: "x" }] });
  assert.equal(s.enabled, true);
  assert.equal(s.port, 18110, "port 80 is refused");
  assert.equal(s.folders.length, 1);
  assert.equal(s.watches.length, 1);
  assert.equal(s.watches[0].mode, "rebuild");
  assert.equal(effectivePort(s, { TATVAM_MCP_PORT: "18911" }), 18911);
  assert.equal(effectivePort(s, {}), 18110);
});
