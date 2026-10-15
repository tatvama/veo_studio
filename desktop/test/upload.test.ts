import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { uploadFile, type UploadMeta } from "../src/main/upload.ts";
import { Upstream } from "../src/main/upstream.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tatvam-up-"));
const file = path.join(tmp, "render.mp4");
const data = Buffer.from(Array.from({ length: 100_000 }, (_, i) => (i * 7) % 251));
writeFileSync(file, data);
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A fake Render Center upload endpoint (backend/app/api/desktop.py semantics), with knobs for flaky behaviour. */
function fakeServer(opts: { chunk: number; failOnce?: number; skewOnce?: boolean; stuck?: boolean }) {
  const st = { received: Buffer.alloc(0), size: 0, puts: 0, completeBody: "", initBody: {} as Record<string, unknown>, cookie: "", failed: false, skewed: false };
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const json = (code: number, v: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
      const u = new URL(req.url!, "http://x");
      st.cookie = String(req.headers.cookie ?? "");
      if (req.method === "POST" && u.pathname === "/api/episodes/3/renders/uploads") {
        st.initBody = JSON.parse(body.toString());
        st.size = Number(st.initBody.size);
        return json(200, { upload_id: "u1", chunk_size: opts.chunk });
      }
      if (req.method === "PUT" && u.pathname === "/api/renders/uploads/u1") {
        st.puts++;
        if (opts.failOnce && st.puts === opts.failOnce && !st.failed) { st.failed = true; return json(503, { detail: "busy" }); }
        if (opts.stuck) return json(409, { detail: "wrong offset", received: 0 }); // a server that never takes the chunk it asks for
        const off = Number(u.searchParams.get("offset"));
        if (opts.skewOnce && !st.skewed && st.received.length > 0) { // the server already had more than the client thinks
          st.skewed = true;
          return json(409, { detail: `Expected the next chunk at byte ${st.received.length}`, received: st.received.length });
        }
        if (off !== st.received.length) return json(409, { detail: "wrong offset", received: st.received.length });
        st.received = Buffer.concat([st.received, body]);
        return json(200, { received: st.received.length, size: st.size });
      }
      if (req.method === "GET" && u.pathname === "/api/renders/uploads/u1") return json(200, { upload_id: "u1", received: st.received.length, size: st.size });
      if (req.method === "POST" && u.pathname === "/api/renders/uploads/u1/complete") {
        st.completeBody = body.toString();
        if (st.received.length !== st.size) return json(409, { detail: "not finished", received: st.received.length });
        return json(200, { id: 55, version: 4, kind: "final" });
      }
      json(404, { detail: "nope" });
    });
  });
  return { srv, st };
}

const meta: UploadMeta = { filename: "render.mp4", size: 0, language: "kn", preset: "yt4k", w: 3840, h: 2160, fps: 24, codec: "hevc", encoder: "hevc_nvenc",
  cut_version: 4, duration_s: 12, machine: "EDIT-PC", fingerprint: "abc" };

async function withServer(opts: Parameters<typeof fakeServer>[0], fn: (up: Upstream, st: ReturnType<typeof fakeServer>["st"]) => Promise<void>) {
  const { srv, st } = fakeServer(opts);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const up = new Upstream({ serverUrl: () => `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, cookie: async () => "veo_session=tok" });
  try { await fn(up, st); } finally { await new Promise<void>((r) => srv.close(() => r())); }
}

test("chunked upload: init with the plan's metadata, chunks in order, complete with the SRT", async () => {
  await withServer({ chunk: 30_000 }, async (up, st) => {
    const seen: number[] = [];
    const r = await uploadFile(up, { eid: 3, file, meta, srt: "1\n00:00:00,000 --> 00:00:01,000\nHi\n", onProgress: (p) => seen.push(p.received) });
    assert.equal(r.uploadId, "u1");
    assert.deepEqual(r.export, { id: 55, version: 4, kind: "final" });
    assert.ok(st.received.equals(data));
    assert.equal(st.puts, 4);
    assert.deepEqual(seen, [0, 30_000, 60_000, 90_000, 100_000]);
    assert.equal(st.initBody.size, 100_000);
    assert.equal(st.initBody.fingerprint, "abc");
    assert.equal(st.cookie, "veo_session=tok");
    assert.match(JSON.parse(st.completeBody).srt, /Hi/);
  });
});

test("a 409 resumes from the server's position, a 503 is retried", async () => {
  await withServer({ chunk: 25_000, failOnce: 2, skewOnce: true }, async (up, st) => {
    await uploadFile(up, { eid: 3, file, meta, retryDelayMs: 5 });
    assert.ok(st.received.equals(data));
    assert.ok(st.skewed && st.failed);
  });
});

test("resume after a restart: GET the status, send only the rest", async () => {
  await withServer({ chunk: 40_000 }, async (up, st) => {
    st.size = data.length;
    st.received = data.subarray(0, 40_000);
    const before = st.puts;
    await uploadFile(up, { eid: 3, file, meta, uploadId: "u1" });
    assert.equal(st.puts - before, 1, "the remaining 60 kB in one default-size chunk");
    assert.ok(st.received.equals(data));
  });
});

test("a server that keeps answering 409 at the same offset fails the upload after 5 tries instead of looping", async () => {
  await withServer({ chunk: 30_000, stuck: true }, async (up, st) => {
    await assert.rejects(uploadFile(up, { eid: 3, file, meta }), (e: Error) => /upload stuck: the server rejected the chunk at byte 0 5 times/.test(e.message));
    assert.equal(st.puts, 5);
    assert.equal(st.completeBody, "", "complete was never called");
  });
});
