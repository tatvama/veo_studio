"""Poster Studio: designs, safety of stored documents, uploads, exports, versions and AI layers (mock providers)."""
from __future__ import annotations

import io

import numpy as np
from PIL import Image

from app.core import designs as dz
from conftest import H, ok, wait_jobs


def _png(w=64, h=48, color=(200, 40, 40, 255)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def _new(client, **kw):
    body = {"title": "Lamp poster", "format": "film_poster", "width": 2000, "height": 3000,
            "doc": {"background": {"color": "#000000"}, "layers": [
                {"id": "t1", "type": "text", "text": "THE LAMP", "x": 100, "y": 200, "width": 800, "height": 120}]}}
    body.update(kw)
    return ok(client.post("/api/designs", json=body, headers=H))


def test_create_get_list_save_and_conflict(client):
    d = _new(client)
    assert d["width"] == 2000 and d["doc"]["layers"][0]["text"] == "THE LAMP" and d["revision"] == 1
    assert any(x["id"] == d["id"] for x in ok(client.get("/api/designs", headers=H)))
    assert any(x["id"] == d["id"] for x in ok(client.get("/api/designs?q=lamp", headers=H)))
    saved = ok(client.put(f"/api/designs/{d['id']}", json={"title": "Lamp v2", "base_revision": 1,
                                                            "doc": {"layers": d["doc"]["layers"] * 1}}, headers=H))
    assert saved["revision"] == 2
    # someone else saved in between: a stale editor is told instead of overwriting
    r = client.put(f"/api/designs/{d['id']}", json={"title": "stale", "base_revision": 1}, headers=H)
    assert r.status_code == 409
    assert ok(client.put(f"/api/designs/{d['id']}", json={"title": "mine", "base_revision": 1, "force": True}, headers=H))["revision"] == 3
    got = ok(client.get(f"/api/designs/{d['id']}", headers=H))
    assert got["title"] == "mine"


def test_sizes_are_clamped_and_bad_docs_rejected(client):
    d = _new(client, width=10, height=99999)
    assert (d["width"], d["height"]) == (dz.MIN_SIDE, dz.MAX_SIDE)
    r = client.post("/api/designs", json={"title": "x", "doc": {"layers": [{"id": str(i), "type": "text"} for i in range(400)]}}, headers=H)
    assert r.status_code == 400


def test_documents_only_point_at_allowed_media():
    doc = dz.clean_doc({"layers": [
        {"id": "a", "type": "image", "asset": "consents/release.pdf", "src": "/media/consents/release.pdf"},
        {"id": "b", "type": "image", "asset": "designs/1/uploads/x.png", "src": "/media/designs/1/uploads/x.png"},
        {"id": "c", "type": "image", "src": "https://evil.example/track.png"},
        {"id": "d", "type": "image", "src": "/showcase/lamp.webp"},
        {"id": "e", "type": "image", "asset": "designs/../../secrets.txt"},
        {"id": "f", "type": "nonsense"},
    ]})
    by = {l["id"]: l for l in doc["layers"]}
    assert "asset" not in by["a"] and by["a"]["src"] == ""
    assert by["b"]["asset"] == "designs/1/uploads/x.png" and "src" not in by["b"]
    assert by["c"]["src"] == "" and by["d"]["src"] == "/showcase/lamp.webp"
    assert "asset" not in by["e"] and "f" not in by
    resolved = dz.resolve_doc(doc)
    assert {l["id"]: l for l in resolved["layers"]}["b"]["src"] == "/media/designs/1/uploads/x.png"


def test_upload_thumbnail_and_exports(client):
    d = _new(client)
    up = ok(client.post(f"/api/designs/{d['id']}/upload", files={"file": ("logo.png", _png(), "image/png")}, headers=H))
    assert up["asset"].startswith(f"designs/{d['id']}/uploads/") and (up["width"], up["height"]) == (64, 48)
    assert client.post(f"/api/designs/{d['id']}/upload", files={"file": ("x.txt", b"hello", "text/plain")}, headers=H).status_code == 400
    th = ok(client.post(f"/api/designs/{d['id']}/thumbnail", files={"file": ("t.png", _png(400, 600), "image/png")}, headers=H))
    assert th["thumb_url"].endswith(".webp")
    for kind in ("png", "jpg", "webp", "pdf"):
        x = ok(client.post(f"/api/designs/{d['id']}/export", data={"kind": kind},
                           files={"file": ("render.png", _png(300, 450), "image/png")}, headers=H))
        assert x["kind"] == kind and x["url"].endswith(f".{kind}") and x["width"] == 300
        assert client.get(x["url"]).status_code == 200
    assert len(ok(client.get(f"/api/designs/{d['id']}/exports", headers=H))) == 4
    assert client.post(f"/api/designs/{d['id']}/export", data={"kind": "tiff"},
                       files={"file": ("r.png", _png(), "image/png")}, headers=H).status_code == 400


def test_versions_duplicate_and_archive(client):
    d = _new(client)
    v = ok(client.post(f"/api/designs/{d['id']}/versions", json={"note": "first look"}, headers=H))
    ok(client.put(f"/api/designs/{d['id']}", json={"doc": {"layers": []}}, headers=H))
    assert ok(client.get(f"/api/designs/{d['id']}", headers=H))["doc"]["layers"] == []
    restored = ok(client.post(f"/api/designs/{d['id']}/versions/{v['id']}/restore", headers=H))
    assert restored["doc"]["layers"][0]["text"] == "THE LAMP"
    notes = [x["note"] for x in ok(client.get(f"/api/designs/{d['id']}/versions", headers=H))]
    assert "first look" in notes and any(n.startswith("Before restoring") for n in notes)
    copy = ok(client.post(f"/api/designs/{d['id']}/duplicate", headers=H))
    assert copy["id"] != d["id"] and copy["title"].endswith("(copy)")
    ok(client.delete(f"/api/designs/{copy['id']}", headers=H))
    assert all(x["id"] != copy["id"] for x in ok(client.get("/api/designs", headers=H)))
    assert any(x["id"] == copy["id"] for x in ok(client.get("/api/designs?archived=true", headers=H)))


def test_ai_layers_run_as_jobs(client):
    d = _new(client)
    res = ok(client.post(f"/api/designs/{d['id']}/ai/image", json={"kind": "background", "prompt": "temple at dusk",
                                                                   "layer_id": "bg", "count": 2}, headers=H))
    assert res["status"] == "queued" and len(res["jobs"]) == 2
    ids = ",".join(str(j["id"]) for j in res["jobs"])
    wait_jobs(client, None)
    st = ok(client.get(f"/api/designs/jobs/status?ids={ids}", headers=H))
    assert len(st) == 2 and all(s["status"] == "succeeded" for s in st)
    r0 = st[0]["result"]
    assert r0["asset"].startswith(f"designs/{d['id']}/ai/") and r0["layer_id"] == "bg" and r0["width"] > 0
    assert client.get(r0["src"]).status_code == 200
    # an element with a transparent background comes back as a PNG cut-out
    el = ok(client.post(f"/api/designs/{d['id']}/ai/image", json={"kind": "element", "prompt": "brass lamp", "cutout": True},
                        headers=H))
    wait_jobs(client, None)
    st = ok(client.get(f"/api/designs/jobs/status?ids={el['jobs'][0]['id']}", headers=H))
    assert st[0]["status"] == "succeeded" and st[0]["result"]["asset"].endswith(".png") and st[0]["result"]["cutout"]
    # harmonize needs something to work from
    assert client.post(f"/api/designs/{d['id']}/ai/image", json={"kind": "harmonize"}, headers=H).status_code == 400
    assert client.post(f"/api/designs/{d['id']}/ai/image", json={"kind": "restyle", "source_asset": "consents/x.png"},
                       headers=H).status_code == 400


def test_ai_copy_and_brief(client):
    out = ok(client.post("/api/designs/ai/copy", json={"kind": "tagline", "context": "a temple lamp moves at night", "n": 4}, headers=H))
    assert len(out["suggestions"]) == 4 and all(s for s in out["suggestions"])
    plan = ok(client.post("/api/designs/ai/brief", json={"brief": "Poster for a short film about a magic temple lamp"}, headers=H))
    assert plan["template"] and plan["title"] and plan["background_prompt"] and plan["palette"]


def test_green_screen_cutout_keeps_the_subject_and_drops_the_green():
    img = Image.new("RGB", (200, 160), (0, 255, 0))
    for x in range(70, 130):
        for y in range(40, 120):
            img.putpixel((x, y), (180, 90, 60))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    data, w, h = dz.cutout_green(buf.getvalue())
    out = Image.open(io.BytesIO(data))
    assert out.mode == "RGBA" and w < 200 and h < 160  # trimmed to the subject
    a = np.asarray(out)[..., 3]
    assert a[h // 2, w // 2] > 240 and a[0, 0] < 10


def test_nearest_aspect_and_prompts():
    assert dz.nearest_aspect(2000, 3000) == "2:3" and dz.nearest_aspect(1280, 720) == "16:9" and dz.nearest_aspect(1080, 1350) == "4:5"
    p = dz.prompt_for("background", "a temple at dusk")
    assert "No text" in p and "temple" in p
    c = dz.prompt_for("character", "", pose="arms crossed", cutout=True, has_ref=True)
    assert "#00FF00" in c and "Same person" in c and "arms crossed" in c


def test_template_and_brand_kit_are_saved(client):
    d = _new(client)
    ok(client.put(f"/api/designs/{d['id']}", json={"template": "festival_greeting", "brand_kit_id": 7}, headers=H))
    got = ok(client.get(f"/api/designs/{d['id']}", headers=H))
    assert got["template"] == "festival_greeting" and got["brand_kit_id"] == 7
