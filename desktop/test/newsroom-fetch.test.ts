/**
 * News Room data on the desktop (docs/EDITOR.md §16.9): web addresses (scheme, credentials, loopback / private /
 * link-local / multicast addresses in IPv4 and IPv6, also after a redirect), the size cap, the time limit, compressed
 * answers, no cookies, and local text files (BOMs, UTF-16, size, extensions, the dialog). Only a local server on
 * 127.0.0.1 is used, let through by the test-only `allowAddress` option; nothing goes to the internet.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import zlib from "node:zlib";
import { checkUrl, decodeText, fetchText, ipv4Blocked, ipv6Blocked, ipv6Groups, isBlockedAddress, readTextFile } from "../src/main/newsroom/fetch.ts";
import type { NewsroomDeps } from "../src/main/newsroom/ipc.ts";

const refused = (u: string) => { const r = checkUrl(u); return "error" in r ? r.error : ""; };

test("addresses: only public http / https web addresses pass", () => {
  for (const u of ["https://example.com/feed.xml", "http://8.8.8.8/x.csv", "https://[2606:4700:4700::1111]/", "https://172.32.0.1/", "https://docs.google.com/spreadsheets/d/e/x/pub?output=csv"]) {
    assert.equal(refused(u), "", u);
  }
  assert.match(refused("file:///C:/Windows/win.ini"), /http or https/);
  assert.match(refused("ftp://example.com/a.csv"), /http or https/);
  assert.match(refused("javascript:alert(1)"), /http or https/);
  assert.match(refused("not a url"), /isn't a web address/);
  assert.match(refused("https://user:pw@example.com/"), /user name or password/);
  for (const u of [
    "http://localhost:8100/", "http://api.localhost/", "http://127.0.0.1/", "http://127.9.9.9/", "http://0.0.0.0/", "http://10.1.2.3/",
    "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/",
    "http://224.0.0.1/", "http://255.255.255.255/", "http://[::1]/", "http://[::]/", "http://[fc00::1]/", "http://[fd12:3456::1]/",
    "http://[fe80::1]/", "http://[ff02::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:10.0.0.1]/", "http://[64:ff9b::a00:1]/",
    "http://[2002:c0a8:101::1]/", "http://2130706433/", "http://0x7f.1/", "http://017700000001/",
  ]) assert.match(refused(u), /private network/, u);
});

test("addresses: IPv4 and IPv6 ranges", () => {
  assert.equal(ipv4Blocked("8.8.8.8"), false);
  assert.equal(ipv4Blocked("172.15.255.255"), false);
  assert.equal(ipv4Blocked("172.16.0.0"), true);
  assert.equal(ipv4Blocked("192.169.0.1"), false);
  assert.equal(ipv4Blocked("1.2.3"), true);
  assert.equal(ipv4Blocked("1.2.3.256"), true);
  assert.deepEqual(ipv6Groups("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(ipv6Groups("2001:db8::8:800:200c:417a"), [0x2001, 0xdb8, 0, 0, 8, 0x800, 0x200c, 0x417a]);
  assert.deepEqual(ipv6Groups("::ffff:192.168.0.1"), [0, 0, 0, 0, 0, 0xffff, 0xc0a8, 1]);
  assert.deepEqual(ipv6Groups("fe80::1%eth0"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(ipv6Groups("1::2::3"), null);
  assert.equal(ipv6Groups("12345::1"), null);
  assert.equal(ipv6Blocked("2606:4700:4700::1111"), false);
  assert.equal(ipv6Blocked("::ffff:8.8.8.8"), false);
  assert.equal(ipv6Blocked("::ffff:7f00:1"), true);
  assert.equal(ipv6Blocked("fe80::abcd"), true);
  assert.equal(ipv6Blocked("febf::1"), true);
  assert.equal(ipv6Blocked("fec0::1"), true);
  assert.equal(ipv6Blocked("2001:db8::1"), true);
  assert.equal(isBlockedAddress("example.com"), true, "not an address at all");
  assert.equal(isBlockedAddress("[::1]"), true);
});

test("text: BOMs, UTF-16 and charsets", () => {
  const utf8 = Buffer.from("name,city\nप्रिया,Pune\n", "utf8");
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8])), "name,city\nप्रिया,Pune\n");
  assert.equal(decodeText(utf8), "name,city\nप्रिया,Pune\n");
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a\tb\nकन्नड\t1", "utf16le")]);
  assert.equal(decodeText(le), "a\tb\nकन्नड\t1");
  const be = Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x09, 0x15]);
  assert.equal(decodeText(be), "A\u0915");
  assert.equal(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "iso-8859-1"), "café");
  assert.equal(decodeText(Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?><a>caf\xe9</a>`, "latin1")), `<?xml version="1.0" encoding="ISO-8859-1"?><a>café</a>`);
  assert.equal(decodeText(Buffer.from("ok"), "no-such-charset"), "ok");
});

// ── a local server (127.0.0.1 only, let through with allowAddress) ───────────

let server: http.Server;
let base = "";
const seen: http.IncomingHttpHeaders[] = [];
const local = { allowAddress: (ip: string) => ip === "127.0.0.1" };

before(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.headers);
    const u = new URL(req.url ?? "/", "http://x");
    const n = Number(u.searchParams.get("n") ?? 0);
    switch (u.pathname) {
      case "/csv": res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "set-cookie": "a=1" }); res.end("headline\nमुंबई में बारिश\n"); return;
      case "/gzip": res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }); res.end(zlib.gzipSync(JSON.stringify({ data: { items: [1, 2] } }))); return;
      case "/latin": res.writeHead(200, { "content-type": "text/plain; charset=windows-1252" }); res.end(Buffer.from([0x93, 0x68, 0x69, 0x94])); return;
      case "/hop": res.writeHead(302, { location: n > 0 ? `/hop?n=${n - 1}` : "/csv", "set-cookie": "s=2" }); res.end(); return;
      case "/away": res.writeHead(301, { location: AWAY[Number(u.searchParams.get("i"))] ?? "/csv" }); res.end(); return;
      case "/big": res.writeHead(200, { "content-type": "text/plain", "content-length": String(5000) }); res.end("x".repeat(5000)); return;
      case "/stream": {
        res.writeHead(200, { "content-type": "text/plain" });
        let i = 0;
        const t = setInterval(() => { if (res.destroyed || i++ > 50) { clearInterval(t); res.end(); return; } res.write("y".repeat(400)); }, 2);
        return;
      }
      case "/bomb": res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }); res.end(zlib.gzipSync(Buffer.alloc(200_000, 32))); return;
      case "/slow": setTimeout(() => { if (!res.destroyed) res.end("late"); }, 3000); return;
      case "/missing": res.writeHead(404); res.end("no"); return;
      case "/locked": res.writeHead(403); res.end("no"); return;
      default: res.writeHead(500); res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

test("fetch: refuses the local server without the test option, before sending anything", async () => {
  const n = seen.length;
  const r = await fetchText(`${base}/csv`);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /private network/);
  assert.equal(seen.length, n, "no request reached the server");
});

test("fetch: text, status, type and the final address; plain headers, no cookies", async () => {
  const r = await fetchText(`${base}/csv`, local);
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/csv/);
  assert.equal(r.text, "headline\nमुंबई में बारिश\n");
  assert.equal(r.finalUrl, `${base}/csv`);
  const h = seen[seen.length - 1];
  assert.equal(h["user-agent"], "Tatvam-Studio");
  assert.equal(h.cookie, undefined);
  assert.equal(h.authorization, undefined);
});

test("fetch: compressed answers and charsets", async () => {
  const g = await fetchText(`${base}/gzip`, local);
  assert.deepEqual(JSON.parse(g.text), { data: { items: [1, 2] } });
  const l = await fetchText(`${base}/latin`, local);
  assert.equal(l.text, "\u201chi\u201d");
});

test("fetch: redirects are followed (at most 5) and cookies are never sent back", async () => {
  const r = await fetchText(`${base}/hop?n=3`, local);
  assert.equal(r.ok, true);
  assert.equal(r.finalUrl, `${base}/csv`);
  assert.ok(seen.slice(-5).every((h) => h.cookie === undefined));
  const many = await fetchText(`${base}/hop?n=6`, local);
  assert.equal(many.ok, false);
  assert.match(many.error ?? "", /redirected too many times/);
});

/** Where the test server's /away?i=<n> redirects (a fixed list: the server never redirects to a value it is sent). */
const AWAY = ["http://intranet.example/secret", "http://169.254.169.254/latest/", "http://[::1]:1/", "file:///etc/passwd", "http://localhost/"];

test("fetch: a redirect to a private or local address is refused", async () => {
  const resolve = async (host: string) => (host === "intranet.example" ? [{ address: "10.0.0.5", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]);
  for (const [i, to] of AWAY.entries()) {
    const r = await fetchText(`${base}/away?i=${i}`, { ...local, resolve });
    assert.equal(r.ok, false, to);
    assert.match(r.error ?? "", /private network|http or https/, to);
  }
});

test("fetch: a host name that resolves to a private address (any of its addresses) is refused", async () => {
  const r1 = await fetchText("http://router.example/", { resolve: async () => [{ address: "192.168.1.1", family: 4 }] });
  assert.match(r1.error ?? "", /private network/);
  const r2 = await fetchText("http://mixed.example/", { resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "fd00::1", family: 6 }] });
  assert.match(r2.error ?? "", /private network/);
  const r3 = await fetchText("http://nowhere.example/", { resolve: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); } });
  assert.match(r3.error ?? "", /Couldn't find that web address/);
});

test("fetch: the size cap (declared, streamed and decompressed) and the time limit", async () => {
  const big = await fetchText(`${base}/big`, { ...local, maxBytes: 1000 });
  assert.match(big.error ?? "", /larger than/);
  const streamed = await fetchText(`${base}/stream`, { ...local, maxBytes: 4000 });
  assert.match(streamed.error ?? "", /larger than/);
  const bomb = await fetchText(`${base}/bomb`, { ...local, maxBytes: 50_000 });
  assert.match(bomb.error ?? "", /larger than/);
  const t0 = Date.now();
  const slow = await fetchText(`${base}/slow`, { ...local, timeoutMs: 300 });
  assert.match(slow.error ?? "", /longer than/);
  assert.ok(Date.now() - t0 < 2500, "stopped at the time limit");
});

test("fetch: error answers are explained plainly", async () => {
  const nf = await fetchText(`${base}/missing`, local);
  assert.equal(nf.ok, false);
  assert.equal(nf.status, 404);
  assert.match(nf.error ?? "", /Nothing was found/);
  const lk = await fetchText(`${base}/locked`, local);
  assert.match(lk.error ?? "", /published to the web/);
});

// ── local files ──────────────────────────────────────────────────────────────

const tmp = mkdtempSync(path.join(os.tmpdir(), "tatvam-nr-data-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const deps = { parent: () => null, log: () => undefined, libraryRoot: () => tmp } as unknown as NewsroomDeps;

test("files: BOMs and UTF-16, the dialog, extensions and the size cap", async () => {
  const a = path.join(tmp, "rates.csv");
  writeFileSync(a, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("item,price\nGold,7250\n")]));
  assert.deepEqual(await readTextFile(deps, a), { path: a, name: "rates.csv", text: "item,price\nGold,7250\n" });
  const b = path.join(tmp, "excel.txt");
  writeFileSync(b, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("city\ttemp\nबेंगलुरु\t24", "utf16le")]));
  assert.equal((await readTextFile(deps, b))?.text, "city\ttemp\nबेंगलुरु\t24");
  // the dialog (replaced): cancelled, then a pick of any extension
  assert.equal(await readTextFile(deps, undefined, { pick: async () => null }), null);
  const c = path.join(tmp, "feed.dat");
  writeFileSync(c, "<rss></rss>");
  assert.equal((await readTextFile(deps, undefined, { pick: async () => c }))?.text, "<rss></rss>");
  // a path from the page: absolute data files only
  await assert.rejects(readTextFile(deps, c), /Only CSV/);
  await assert.rejects(readTextFile(deps, "rates.csv"), /Only CSV/);
  await assert.rejects(readTextFile(deps, path.join(tmp, "gone.csv")), /wasn't found/);
  await assert.rejects(readTextFile(deps, a, { maxBytes: 10 }), /larger than/);
});
