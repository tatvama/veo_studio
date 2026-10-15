/**
 * Trust boundaries of the desktop app (docs/DESKTOP.md §4): the server address must be https unless the server is on
 * this PC, and one path-confinement rule serves the editor, the library, the bridge and the MCP server.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { defaultSettings, isLoopbackHost, isPrivateNetworkHost, normalizeServerUrl, sanitize } from "../src/main/config.ts";
import { isInside } from "../src/main/paths.ts";
import { inside } from "../src/main/mcp/security.ts";

test("normalizeServerUrl: https anywhere, http only on this PC or the local network, a bare host becomes https", () => {
  assert.equal(normalizeServerUrl("https://studio.example.com/"), "https://studio.example.com");
  assert.equal(normalizeServerUrl("studio.example.com:8443"), "https://studio.example.com:8443");
  assert.equal(normalizeServerUrl("http://localhost:8100"), "http://localhost:8100");
  assert.equal(normalizeServerUrl("127.0.0.1:8100"), "http://127.0.0.1:8100");
  assert.equal(normalizeServerUrl("http://[::1]:8100"), "http://[::1]:8100");
  assert.equal(normalizeServerUrl("http://dev.localhost:8100"), "http://dev.localhost:8100");
  assert.equal(normalizeServerUrl("http://192.168.1.20:8100"), "http://192.168.1.20:8100");
  assert.equal(normalizeServerUrl("10.0.0.5:8100"), "http://10.0.0.5:8100");
  assert.equal(normalizeServerUrl("http://studio.local:8100"), "http://studio.local:8100");
  assert.throws(() => normalizeServerUrl("http://8.8.8.8:8100"), /must be reached over https/);
  assert.throws(() => normalizeServerUrl("http://172.32.0.1:8100"), /must be reached over https/);
  assert.throws(() => normalizeServerUrl("http://studio.example.com"), /must be reached over https/);
  assert.throws(() => normalizeServerUrl("ftp://studio.example.com"), /https/);
  assert.throws(() => normalizeServerUrl("not a url at all"), TypeError);
  assert.ok(isLoopbackHost("LOCALHOST") && isLoopbackHost("127.9.9.9") && isLoopbackHost("[::1]") && !isLoopbackHost("10.0.0.1") && !isLoopbackHost("localhost.evil.com"));
  assert.ok(isPrivateNetworkHost("10.1.2.3") && isPrivateNetworkHost("172.16.0.1") && isPrivateNetworkHost("172.31.255.255") && isPrivateNetworkHost("192.168.0.1"));
  assert.ok(isPrivateNetworkHost("[fd12::1]") && isPrivateNetworkHost("::ffff:192.168.1.1") && isPrivateNetworkHost("nas.local"));
  assert.ok(!isPrivateNetworkHost("172.15.0.1") && !isPrivateNetworkHost("172.32.0.1") && !isPrivateNetworkHost("192.169.0.1") && !isPrivateNetworkHost("evil.local.com") && !isPrivateNetworkHost("[2001:db8::1]"));
});

test("a stored plain-http public address falls back to the default; LAN and TATVAM_SERVER addresses are kept", () => {
  const d = defaultSettings({ documents: "D:\\Docs", env: {} });
  assert.equal(d.serverUrl, "http://localhost:8100");
  assert.equal(sanitize({ serverUrl: "http://8.8.8.8:8100" }, d).serverUrl, "http://localhost:8100");
  assert.equal(sanitize({ serverUrl: "http://192.168.1.20:8100" }, d).serverUrl, "http://192.168.1.20:8100");
  assert.equal(sanitize({ serverUrl: "https://studio.example.com" }, d).serverUrl, "https://studio.example.com");
  assert.equal(defaultSettings({ documents: "D:\\Docs", env: { TATVAM_SERVER: "http://10.1.1.1:8100" } }).serverUrl, "http://10.1.1.1:8100");
  assert.equal(defaultSettings({ documents: "D:\\Docs", env: { TATVAM_SERVER: "http://8.8.8.8:8100" } }).serverUrl, "http://localhost:8100");
  assert.equal(defaultSettings({ documents: "D:\\Docs", env: { TATVAM_SERVER: "https://studio.example.com" } }).serverUrl, "https://studio.example.com");
});

test("isInside: the folder itself and below, never a sibling that shares the prefix; case and slashes don't matter", () => {
  const a = path.resolve("D:\\Projects\\A");
  assert.equal(isInside(a, a), true);
  assert.equal(isInside(a, path.join(a, "Renders", "x.mp4")), true);
  assert.equal(isInside(a, `${a}B`), false, "D:\\Projects\\AB is not inside D:\\Projects\\A");
  assert.equal(isInside(a, `${a}B\\x.mp4`), false);
  assert.equal(isInside(a, path.join(a, "..", "A2", "x.mp4")), false);
  assert.equal(isInside(a.toUpperCase(), path.join(a.toLowerCase(), "x.mp4").replace(/\\/g, "/")), true);
  assert.equal(isInside(`${a}\\`, path.join(a, "x")), true, "a trailing slash on the folder");
  assert.equal(inside(a, `${a}B`), false, "the MCP server uses the same rule");
  assert.equal(inside(a, path.join(a, "y")), true);
});
