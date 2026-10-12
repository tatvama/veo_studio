"""GET /api/ui/manifest (docs/DESKTOP.md §4.3): the built screens' files with sizes and sha256, no sign-in, cached until
index.html changes."""
from __future__ import annotations

import hashlib
import json
import os

from fastapi.testclient import TestClient

from app.api import ui


def _dist(tmp_path, index="<!doctype html><div id=root></div>"):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(index, encoding="utf-8")
    (dist / "assets" / "app-abc123.js").write_text("console.log(1)", encoding="utf-8")
    (dist / "models" / "mediapipe").mkdir(parents=True)
    (dist / "models" / "mediapipe" / "face.tflite").write_bytes(bytes(range(256)) * 4)
    (tmp_path / "package.json").write_text(json.dumps({"version": "3.0.0", "tatvam": {"requiresDesktop": "3.0.0"}}), encoding="utf-8")
    return dist


def test_manifest_lists_the_build_without_sign_in(client: TestClient, tmp_path, monkeypatch):
    dist = _dist(tmp_path)
    monkeypatch.setattr(ui, "DIST", dist)
    monkeypatch.setattr(ui, "_cache", {"key": None, "hash": None, "manifest": None})
    anon = TestClient(client.app)  # a fresh client: no session cookie
    r = anon.get("/api/ui/manifest")
    assert r.status_code == 200, r.text
    m = r.json()
    index_sha = hashlib.sha256((dist / "index.html").read_bytes()).hexdigest()
    assert m["build"] == index_sha[:12]
    assert m["requires_desktop"] == "3.0.0"
    assert m["version"] and m["built_at"].endswith("Z")
    by = {f["path"]: f for f in m["files"]}
    assert set(by) == {"index.html", "assets/app-abc123.js", "models/mediapipe/face.tflite"}
    assert by["models/mediapipe/face.tflite"]["size"] == 1024
    assert by["assets/app-abc123.js"]["sha256"] == hashlib.sha256(b"console.log(1)").hexdigest()
    assert r.headers["cache-control"] == "no-cache"


def test_manifest_is_cached_until_index_html_changes(tmp_path, monkeypatch):
    dist = _dist(tmp_path)
    monkeypatch.setattr(ui, "_cache", {"key": None, "hash": None, "manifest": None})
    calls = []
    real = ui.build_manifest
    monkeypatch.setattr(ui, "build_manifest", lambda d: (calls.append(d), real(d))[1])
    a = ui.current_manifest(dist)
    b = ui.current_manifest(dist)
    assert a is b and len(calls) == 1
    # touched (new mtime) but the same content: still cached
    st = (dist / "index.html").stat()
    os.utime(dist / "index.html", ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
    assert ui.current_manifest(dist) is a and len(calls) == 1
    # a new build: recomputed
    (dist / "index.html").write_text("<!doctype html><div id=root data-v=2></div>", encoding="utf-8")
    c = ui.current_manifest(dist)
    assert len(calls) == 2 and c["build"] != a["build"]


def test_manifest_404_without_a_build(client: TestClient, tmp_path, monkeypatch):
    monkeypatch.setattr(ui, "DIST", tmp_path / "missing")
    monkeypatch.setattr(ui, "_cache", {"key": None, "hash": None, "manifest": None})
    assert client.get("/api/ui/manifest").status_code == 404


def test_requires_desktop_defaults_when_package_json_is_missing(tmp_path, monkeypatch):
    dist = _dist(tmp_path)
    (tmp_path / "package.json").unlink()
    monkeypatch.setattr(ui, "_cache", {"key": None, "hash": None, "manifest": None})
    assert ui.current_manifest(dist)["requires_desktop"] == "0.0.0"
