/**
 * Installed apps update from the public, releases-only repository (docs/DESKTOP.md §6), so they never need a token,
 * even when the code repository is private. The installer's update feed (electron-builder.yml `publish`) and the
 * release workflow that publishes there must name the same repository.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const here = import.meta.dirname;
const builder = readFileSync(path.join(here, "..", "electron-builder.yml"), "utf8");
const workflow = readFileSync(path.join(here, "..", "..", ".github", "workflows", "release.yml"), "utf8");

test("the update feed is the releases-only repository, and the release workflow publishes to it", () => {
  const publish = /^publish:\n((?: {2}.+\n)+)/m.exec(builder)?.[1] ?? "";
  const field = (k: string) => new RegExp(String.raw`^ {2}${k}: *(\S+)`, "m").exec(publish)?.[1];
  assert.equal(field("provider"), "github");
  const repo = `${field("owner")}/${field("repo")}`;
  assert.equal(repo, "tatvama/tatvam-desktop-releases", "never the code repository");
  assert.equal(field("releaseType"), "release", "drafts and prereleases are not offered as updates");
  assert.ok(workflow.includes(`vars.DESKTOP_RELEASES_REPO || '${repo}'`), "the workflow's default repository matches");
  assert.match(workflow, /gh release upload "\$TAG" --repo "\$RELEASES_REPO" release\/\*\.exe release\/\*\.blockmap release\/latest\.yml/);
  assert.match(workflow, /secrets\.DESKTOP_RELEASES_TOKEN/);
});

test("updates are signature-checked against a pinned publisher, and the workflow signs when a certificate secret exists", () => {
  const win = /^win:\n((?: {2}.+\n)+)/m.exec(builder)?.[1] ?? "";
  assert.match(win, /^ {2}verifyUpdateCodeSignature: true$/m, "electron-updater verifies the downloaded installer's signature");
  assert.match(win, /^ {2}publisherName:\n(?: {4}- .+\n)+/m, "the publisher the signature must come from");
  assert.match(workflow, /CSC_LINK: \$\{\{ secrets\.WIN_CSC_LINK \|\| secrets\.CSC_LINK \}\}/);
  assert.match(workflow, /CSC_KEY_PASSWORD: \$\{\{ secrets\.WIN_CSC_KEY_PASSWORD \|\| secrets\.CSC_KEY_PASSWORD \}\}/);
  assert.match(workflow, /\[ -n "\$CSC_LINK" \] \|\| unset CSC_LINK CSC_KEY_PASSWORD/, "an unsigned build when no certificate is set");
});
