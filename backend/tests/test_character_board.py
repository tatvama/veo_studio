"""Character boards: splitting an uploaded board into labelled views, a whole board in one Seedream request (BytePlus
group generation), and the image engine picked per character. Mock providers only; BytePlus HTTP is mocked."""
from __future__ import annotations

import io
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from sqlalchemy import inspect, text

from app.core import identity, model_hub
from app.db import SessionLocal, engine, is_sqlite
from app.db_migrate import migrate
from app.models import AIModel, Character, CharacterAsset, Costume, Job
from app.pipeline import board_split
from app.pipeline.prompting import character_refs
from app.providers import byteplus, mock
from app.providers import services as services_mod
from app.providers.base import MediaResult, ProviderError, Usage
from app.workers.handlers_hub import PHOTO_REASON, auto_register_reason, register_images
from conftest import H, ok, wait_jobs


def _png(img: Image.Image) -> bytes:
    b = io.BytesIO()
    img.save(b, "PNG")
    return b.getvalue()


def _figure(d: ImageDraw.ImageDraw, cx: int, top: int, scale: float = 1.0, coat=(40, 60, 140)) -> None:
    """A standing figure: head, body, two legs."""
    s = scale
    d.ellipse([cx - 50 * s, top, cx + 50 * s, top + 120 * s], fill=(210, 160, 120))
    d.rectangle([cx - 90 * s, top + 125 * s, cx + 90 * s, top + 460 * s], fill=coat)
    d.rectangle([cx - 70 * s, top + 460 * s, cx - 20 * s, top + 680 * s], fill=(30, 30, 30))
    d.rectangle([cx + 20 * s, top + 460 * s, cx + 70 * s, top + 680 * s], fill=(30, 30, 30))


def turnaround(n: int = 5, captions: bool = True) -> bytes:
    """A turnaround on a light-grey background, one figure per view, a small caption under each."""
    img = Image.new("RGB", (400 * n, 900), (232, 232, 232))
    d = ImageDraw.Draw(img)
    for i in range(n):
        cx = 200 + i * 400
        _figure(d, cx, 100, coat=(40 + 30 * i, 60, 140))
        if captions:
            d.text((cx - 30, 830), "VIEW", fill=(0, 0, 0))
    return _png(img)


def grid_board(rows: int = 2, cols: int = 4) -> bytes:
    """Framed panels on white, separated by gutters, a figure in each."""
    img = Image.new("RGB", (40 + cols * 420, 40 + rows * 620), (255, 255, 255))
    d = ImageDraw.Draw(img)
    for r in range(rows):
        for c in range(cols):
            x, y = 40 + c * 420, 40 + r * 620
            d.rectangle([x, y, x + 380, y + 580], fill=(245, 240, 230), outline=(20, 20, 20), width=4)
            _figure(d, x + 190, y + 60, scale=0.7, coat=(60 + 20 * c, 40 + 50 * r, 120))
    return _png(img)


# ── panel detection ──────────────────────────────────────────────────────────

def test_detect_panels_on_synthetic_boards():
    grid = board_split.detect_panels(grid_board(2, 3))
    assert grid["clean"] and grid["method"] == "gutters" and len(grid["panels"]) == 6
    first = grid["panels"][0]
    assert first["x"] <= 40 and first["y"] <= 40 and 380 <= first["w"] <= 430 and 580 <= first["h"] <= 630
    # reading order: the first row left to right, then the second
    assert [p["y"] < 600 for p in grid["panels"]] == [True, True, True, False, False, False]
    assert [p["x"] for p in grid["panels"][:3]] == sorted(p["x"] for p in grid["panels"][:3])

    turn = board_split.detect_panels(turnaround(5))
    assert turn["clean"] and len(turn["panels"]) == 5  # the captions under the figures are not panels
    assert all(p["h"] > 600 and p["y"] < 120 for p in turn["panels"])
    assert turn["background"] == "#e8e8e8"

    jpeg = io.BytesIO()
    Image.open(io.BytesIO(turnaround(4))).save(jpeg, "JPEG", quality=70)  # JPEG noise on the background
    assert len(board_split.detect_panels(jpeg.getvalue())["panels"]) == 4

    # two figures whose boxes overlap in both directions: no gutter, but two separate regions
    img = Image.new("RGB", (1200, 900), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.ellipse([100, 100, 600, 520], fill=(200, 60, 60))
    d.ellipse([560, 470, 1100, 860], fill=(60, 60, 200))
    regions = board_split.detect_panels(_png(img))
    assert regions["clean"] and regions["method"] == "regions" and len(regions["panels"]) == 2

    # a busy (gradient) background isn't clean: a vision model finds the panels instead
    g = Image.new("RGB", (800, 600))
    gd = ImageDraw.Draw(g)
    for y in range(600):
        gd.line([(0, y), (800, y)], fill=(y % 255, 100, 255 - y % 255))
    assert board_split.detect_panels(_png(g)) == {**board_split.detect_panels(_png(g)), "clean": False, "panels": []}

    assert board_split.normalize_label("expression:happy") == ("expression", "happy")
    assert board_split.normalize_label("Three-Quarter") == ("three_quarter", "")
    assert board_split.normalize_label("selfie")[0] == "other"
    assert board_split.from_fractions([{"x": 0.5, "y": 0, "w": 0.5, "h": 1}, {"x": 0, "y": 0, "w": 0.5, "h": 1}], 200, 100) == [
        {"x": 0, "y": 0, "w": 100, "h": 100}, {"x": 100, "y": 0, "w": 100, "h": 100}]


# ── split an uploaded board: label, review, save ────────────────────────────

def _board_asset(c: TestClient, cid: int) -> dict:
    return next(a for a in ok(c.get(f"/api/characters/{cid}"))["assets"] if a["origin"] == "board")


def test_split_board_labels_and_saves_views(client: TestClient):
    c = client
    cid = ok(c.post("/api/characters", headers=H, json={"name": "Meera Board", "gender": "female"}))["id"]
    up = ok(c.post(f"/api/characters/{cid}/board", headers=H, files={"file": ("board.png", grid_board(2, 4), "image/png")}))
    assert up["board"]["clean"] and len(up["board"]["panels"]) == 8
    assert up["jobs"]["jobs"][0]["type"] == "board_split" and up["jobs"]["total_usd"] == 0  # mock: free
    wait_jobs(c, None, timeout=120)
    board = _board_asset(c, cid)
    assert board["kind"] == "source" and not board["approved"]  # kept as the user's own picture, never used whole
    state = board["meta"]["board"]
    assert state["status"] == "ready" and state["method"] == "gutters"
    labels = [(p["kind"], p["name"]) for p in state["panels"]]
    assert labels == [("front", ""), ("three_quarter", ""), ("profile", ""), ("back", ""), ("full_body", ""),
                      ("expression", "happy"), ("expression", "angry"), ("outfit", "board outfit")]
    with SessionLocal() as db:
        split_job = db.query(Job).filter(Job.type == "board_split").order_by(Job.id.desc()).first()
        assert split_job.status == "succeeded" and split_job.result["panels"] == 8

    # review: rename an expression, drop the profile, nudge a box, then save
    panels = [dict(p) for p in state["panels"]]
    panels[2]["keep"] = False
    panels[6]["name"] = "furious"
    panels[0]["w"] -= 10
    saved = ok(c.post(f"/api/character-assets/{board['id']}/board/save", headers=H, json={"panels": panels}))
    assert len(saved["saved"]) == 7
    with SessionLocal() as db:
        crops = db.query(CharacterAsset).filter(CharacterAsset.id.in_(saved["saved"])).order_by(CharacterAsset.id).all()
        assert all(a.origin == f"board:{board['id']}" and a.approved for a in crops)
        assert [a.kind for a in crops] == ["front", "three_quarter", "back", "full_body", "expression", "expression", "outfit"]
        assert crops[5].label == "furious" and crops[6].outfit == "board outfit" and crops[6].view == "full_body"
        assert crops[0].meta["box"]["w"] == panels[0]["w"]
        assert Image.open(get_abs(crops[0].path)).size == (panels[0]["w"], panels[0]["h"])
        assert db.query(Costume).filter(Costume.character_id == cid, Costume.name == "board outfit").count() == 1
        ch = db.get(Character, cid)
        # SAFETY: crops of an uploaded board are never sent to BytePlus as AI-generated sheet views
        assert register_images(db, ch) == []
        assert auto_register_reason(db, ch) in ("Automatic registration is off (Settings → Generation)",
                                                PHOTO_REASON.rstrip("."))
        # the crops are references; the whole board is not
        refs = character_refs(db, ch, max_n=3)
        assert board["id"] not in [a.id for a in refs] and refs[0].kind == "front"
        # a face model trains on the crops as the user's own photos: no AI fill-up of a maybe-real person
        ts = identity.training_set(db, ch)
        assert ts["basis"] == "your_photos" and not ts["auto_fill"] and board["id"] not in [a.id for a in ts["assets"]]
        # an AI-generated sheet view of the same character is still eligible
        db.add(CharacterAsset(character_id=cid, kind="front", path=crops[0].path, approved=True))
        db.commit()
        assert [a.origin for a in register_images(db, ch)] == [""]
    # the board isn't attested AI-made: the character counts as made from a photo, so it can't be registered by hand
    assert c.post(f"/api/characters/{cid}/register/byteplus", headers=H, json={}).status_code == 409
    # once the board is marked AI-generated, its views go along with the AI sheet view
    ok(c.put(f"/api/character-assets/{board['id']}/ai-made", headers=H, json={"ai_made": True}))
    with SessionLocal() as db:
        sent = register_images(db, db.get(Character, cid))
        assert board["id"] not in [a.id for a in sent]  # never the whole board
        assert {a.origin for a in sent} == {"", f"board:{board['id']}"}
    assert c.post(f"/api/characters/{cid}/register/byteplus", headers=H, json={}).status_code == 200
    wait_jobs(c, None, timeout=60)
    state = _board_asset(c, cid)["meta"]["board"]
    assert state["status"] == "saved" and len(state["saved_asset_ids"]) == 7


def get_abs(rel: str):
    from app.storage import get_storage
    return get_storage().abs(rel)


def test_split_board_without_clean_layout_asks_the_vision_model(client: TestClient):
    c = client
    cid = ok(c.post("/api/characters", headers=H, json={"name": "Busy Board"}))["id"]
    g = Image.new("RGB", (800, 600))
    gd = ImageDraw.Draw(g)
    for y in range(600):
        gd.line([(0, y), (800, y)], fill=(y % 255, 120, 255 - y % 255))
    up = ok(c.post(f"/api/characters/{cid}/board", headers=H, files={"file": ("b.png", _png(g), "image/png")}))
    assert not up["board"]["clean"] and up["board"]["panels"] == []
    assert up["jobs"]["jobs"][0]["payload"]["find_boxes"] is True
    wait_jobs(c, None, timeout=120)
    state = _board_asset(c, cid)["meta"]["board"]
    assert state["status"] == "ready" and state["method"] == "vision"
    assert [(p["x"], p["w"], p["kind"]) for p in state["panels"]] == [(16, 368, "front"), (416, 368, "three_quarter")]
    bad = c.post(f"/api/characters/{cid}/board", headers=H, files={"file": ("x.png", b"not an image", "image/png")})
    assert bad.status_code == 400
    # only a board can be split: an ordinary photo can't
    photo = ok(c.post(f"/api/characters/{cid}/upload", headers=H, files={"file": ("me.png", _png(g), "image/png")}))
    pid = next(a["id"] for a in photo["assets"] if a["kind"] == "source" and a["origin"] == "")
    one = {"x": 0, "y": 0, "w": 100, "h": 100, "kind": "front"}
    assert c.post(f"/api/character-assets/{pid}/board/save", headers=H, json={"panels": [one]}).status_code == 400
    board_id = _board_asset(c, cid)["id"]
    off = {"x": 790, "y": 590, "w": 100, "h": 100, "kind": "front"}  # outside the board
    assert c.post(f"/api/character-assets/{board_id}/board/save", headers=H, json={"panels": [off]}).status_code == 400


# ── a whole board in one Seedream request ────────────────────────────────────

def _seedream(key: str) -> AIModel:
    b = next(x for x in model_hub.BUILTINS if x["id"] == f"byteplus:{key}")
    return AIModel(id=b["id"], provider="byteplus", endpoint=b["endpoint"], task="image", display_name=b["display_name"],
                   capabilities=b["capabilities"], price_usd=b["price_usd"], price_unit="image", builtin=True,
                   price_source=b["price_source"], status="enabled")


def test_seedream_group_request_shape(tmp_path, monkeypatch):
    png = mock.image("board", "2:3", "out")
    ref = tmp_path / "ref.png"
    ref.write_bytes(png)
    bodies: list[dict] = []

    def handle(req: httpx.Request) -> httpx.Response:
        if req.url.host == "cdn.example":
            return httpx.Response(200, content=png)
        assert req.headers["authorization"] == "Bearer ark-key" and req.url.path.endswith("/images/generations")
        bodies.append(json.loads(req.content))
        return httpx.Response(200, json={"model": "seedream-5-0-260128", "data": [
            {"url": "https://cdn.example/1.png", "size": "1664x2496"},
            {"error": {"code": "OutputImageSensitiveContentDetected", "message": "refused"}},
            {"url": "https://cdn.example/3.png", "size": "1664x2496"}], "usage": {"generated_images": 2}})

    monkeypatch.setattr(services_mod, "provider_mode", lambda p: "live")
    monkeypatch.setattr(model_hub, "provider_mode", lambda p: "live")
    svc = services_mod.Services()
    monkeypatch.setattr(svc, "ark", lambda: byteplus.ArkClient("ark-key", http=httpx.Client(transport=httpx.MockTransport(handle))))
    m = _seedream("seedream-5.0-lite")
    outs, usage = svc.seedream_group(m, "1. Front view.\n2. Profile.\n3. Back view.", [ref], "2:3", 3)
    body = bodies[0]
    assert body["model"] == "seedream-5-0-260128" and body["sequential_image_generation"] == "auto"
    assert body["sequential_image_generation_options"] == {"max_images": 3}
    assert body["size"] == "1664x2496" and body["watermark"] is False and body["response_format"] == "url"
    assert body["image"].startswith("data:image/png;base64,")  # one reference: a single image, not a list
    assert [r is not None for r, _ in outs] == [True, False, True] and "refused" in outs[1][1]
    assert outs[0][0].data == png and usage.units == 2 and usage.usd == pytest.approx(2 * 0.035)
    # never more than the engine's limit minus the references (BytePlus: references + images ≤ 15)
    svc.seedream_group(m, "x", [ref], "2:3", 40)
    assert bodies[1]["sequential_image_generation_options"]["max_images"] == 14
    # a single image (any Seedream) leaves the group parameter out: Seedream 5.0 Pro doesn't take it
    single = {"data": [{"url": "https://cdn.example/1.png"}]}
    seen: list[dict] = []

    def one(req: httpx.Request) -> httpx.Response:
        if req.url.host == "cdn.example":
            return httpx.Response(200, content=png)
        seen.append(json.loads(req.content))
        return httpx.Response(200, json=single)

    monkeypatch.setattr(svc, "ark", lambda: byteplus.ArkClient("ark-key", http=httpx.Client(transport=httpx.MockTransport(one))))
    from app.providers.schema_map import GenRequest
    svc._seedream(_seedream("seedream-5.0-pro"), GenRequest(mode="i2i", prompt="front", refs=[ref], aspect="3:4"))
    assert "sequential_image_generation" not in seen[0] and seen[0]["model"] == "seedream-5-0-pro-260628"


def test_board_in_one_request_maps_outputs_and_fills_missing(client: TestClient, monkeypatch):
    c = client
    cid = ok(c.post("/api/characters", headers=H, json={"name": "Kavya Board", "dna_text": "Kavya: 25, long black hair"}))["id"]
    opts = ok(c.get(f"/api/characters/{cid}/sheet/board"))
    assert opts["default_engine"] == "byteplus:seedream-5.0-lite" and opts["references"] == 0
    assert [e["id"] for e in opts["engines"]] == ["byteplus:seedream-5.0-lite"]  # Pro makes one image per request
    # Pro can't make a board in one request; outfit panels need the outfit; panels must be known ones
    assert c.post(f"/api/characters/{cid}/sheet/board", headers=H, json={"engine": "byteplus:seedream-5.0-pro"}).status_code == 400
    faces = ["front", *(f"expression:{e}" for e in ("neutral", "happy", "angry", "sad", "surprised"))]
    assert c.post(f"/api/characters/{cid}/sheet/board", headers=H, json={"panels": ["outfit:front"]}).status_code == 400
    assert c.post(f"/api/characters/{cid}/sheet/board", headers=H, json={"panels": ["sideways"]}).status_code == 400
    other = ok(c.post("/api/characters", headers=H, json={"name": "Dup Board"}))["id"]
    dup = ok(c.post(f"/api/characters/{other}/sheet/board", headers=H, json={
        "panels": ["front"] + [f"outfit:{v}" for v in ("front", "back")] * 8, "outfit_name": "x", "outfit_description": "y"}))
    assert dup["jobs"][0]["payload"]["panels"] == ["front", "outfit:front", "outfit:back"]  # duplicates dropped
    wait_jobs(c, None, timeout=120)

    asked: list[dict] = []

    def group(self, m, prompt, refs, aspect, max_images, labels=None):
        # BytePlus returns fewer images than asked, and refuses one: they are made one by one afterwards
        asked.append({"engine": m.id, "prompt": prompt, "n": max_images, "aspect": aspect})
        img = mock.image("x", "2:3", "board")
        res = [(MediaResult(img, "png", Usage("byteplus", m.endpoint, "image", 1, "images", 0.0, mock=True)), "") for _ in range(4)]
        res[1] = (None, "OutputImageSensitiveContentDetected: refused")
        return res, Usage("byteplus", m.endpoint, "image", 3, "images", 0.0, mock=True)

    monkeypatch.setattr(services_mod.Services, "seedream_group", group)
    panels = [*faces, "outfit:front", "outfit:full_body"]
    out = ok(c.post(f"/api/characters/{cid}/sheet/board", headers=H,
                    json={"panels": panels, "outfit_name": "wedding", "outfit_description": "red silk saree"}))
    assert out["jobs"][0]["type"] == "sheet_board" and out["jobs"][0]["payload"]["engine"] == "byteplus:seedream-5.0-lite"
    wait_jobs(c, None, timeout=180)
    with SessionLocal() as db:
        job = db.get(Job, out["jobs"][0]["id"])
        assert job.status == "succeeded", job.error
        r = job.result
        assert r["from_one_request"] == 3 and r["made_one_by_one"] == 5 and r["missing"] == []
        assets = {a.meta.get("board_panel"): a for a in db.query(CharacterAsset).filter(CharacterAsset.character_id == cid).all()}
        assert set(assets) == set(panels)
        # outputs map to the panels in the order the prompt listed them
        assert [assets[k].meta["one_request"] for k in panels] == [True, False, True, True, False, False, False, False]
        assert assets["front"].kind == "front" and assets["expression:happy"].kind == "expression"
        assert assets["expression:happy"].label == "happy" and assets["outfit:full_body"].outfit == "wedding"
        assert assets["outfit:full_body"].view == "full_body" and assets["front"].origin == ""
        assert all(a.meta["engine"] == "byteplus:seedream-5.0-lite" for a in assets.values())
        assert db.query(Costume).filter(Costume.character_id == cid, Costume.name == "wedding").count() == 1
    assert asked[0]["n"] == 8 and asked[0]["aspect"] == "2:3"
    lines = [ln for ln in asked[0]["prompt"].splitlines() if ln[:2] in {f"{i}." for i in range(1, 9)}]
    assert len(lines) == 8 and "Front view" in lines[0] and "happy" in lines[2] and "red silk saree" in lines[6]


# ── the image engine picked per character ───────────────────────────────────

def test_engine_override_for_sheets(client: TestClient, monkeypatch):
    c = client
    cid = ok(c.post("/api/characters", headers=H, json={"name": "Arjun Engine"}))["id"]
    engines = ok(c.get("/api/engines/image"))
    ids = [e["id"] for e in engines["engines"]]
    assert "byteplus:seedream-5.0-pro" in ids and "google:image" in ids and engines["chain"][0] == "google:image"
    pro = next(e for e in engines["engines"] if e["id"] == "byteplus:seedream-5.0-pro")
    assert pro["group_max"] == 0 and next(e for e in engines["engines"] if e["id"] == "byteplus:seedream-5.0-lite")["group_max"] == 15
    # only image engines can be picked
    assert c.patch(f"/api/characters/{cid}", headers=H, json={"sheet_engine": "google:video_saver"}).status_code == 400
    assert c.post(f"/api/characters/{cid}/sheet", headers=H, json={"engine": "nope:engine"}).status_code == 400
    ch = ok(c.patch(f"/api/characters/{cid}", headers=H, json={"sheet_engine": "byteplus:seedream-5.0-pro"}))
    assert ch["sheet_engine"] == "byteplus:seedream-5.0-pro"
    out = ok(c.post(f"/api/characters/{cid}/sheet", headers=H, json={"kinds": ["front", "profile"]}))  # remembered pick
    assert out["jobs"][0]["payload"]["engine"] == "byteplus:seedream-5.0-pro"
    with SessionLocal() as db:  # the Director, the MCP tools and "build from script" use the remembered pick too
        from app.core import generation
        spec = generation.outfit_spec(db, None, db.get(Character, cid), "kurta", "white kurta", None)
        assert spec["payload"]["engine"] == "byteplus:seedream-5.0-pro" and spec["label"].endswith("on seedream-5.0-pro")
    wait_jobs(c, None, timeout=120)
    with SessionLocal() as db:
        made = db.query(CharacterAsset).filter(CharacterAsset.character_id == cid).all()
        # a hand-picked engine is used as picked: "Google first" doesn't take over
        assert sorted(a.kind for a in made) == ["front", "profile"]
        assert all(a.meta["engine"] == "byteplus:seedream-5.0-pro" for a in made)
    for path, body in ((f"/api/characters/{cid}/expressions", {}), (f"/api/characters/{cid}/lighting", {"variants": ["day"]}),
                       (f"/api/characters/{cid}/outfits", {"name": "kurta", "description": "white kurta"}),
                       (f"/api/characters/{cid}/costumes", {"name": "jacket", "description": "denim jacket"})):
        res = ok(c.post(path, headers=H, json=body))
        job = (res.get("jobs") or {}).get("jobs", [None])[0] if "costume" in res else res["jobs"][0]
        assert job["payload"]["engine"] == "byteplus:seedream-5.0-pro", path
    wait_jobs(c, None, timeout=180)

    # a picked engine runs on its own route only: the same model through fal is never tried behind the user's back
    with SessionLocal() as db:
        fal = db.get(AIModel, "fal:bytedance/seedream/v5/pro/edit") or AIModel(id="fal:bytedance/seedream/v5/pro/edit")
        fal.provider, fal.endpoint, fal.task, fal.status = "fal", "bytedance/seedream/v5/pro/edit", "image", "enabled"
        fal.display_name, fal.capabilities = "Seedream v5 Pro Edit (fal)", {"modes": ["i2i", "t2i"], "max_refs": 10}
        db.merge(fal)
        db.commit()
        routes = [m.id for m, _ in model_hub.candidates(db, "image", ["t2i"], explicit="byteplus:seedream-5.0-pro")]
        assert routes == ["byteplus:seedream-5.0-pro", "fal:bytedance/seedream/v5/pro/edit"]  # what `only` narrows
    tried: list[str] = []
    real = services_mod.Services.run_model

    def failing(self, m, req, **kw):
        if m.task == "image":
            tried.append(m.id)
            raise ProviderError("BytePlus said no", provider=m.provider)
        return real(self, m, req, **kw)

    monkeypatch.setattr(services_mod.Services, "run_model", failing)
    try:
        out = ok(c.post(f"/api/characters/{cid}/sheet", headers=H, json={"kinds": ["back"]}))
        wait_jobs(c, None, timeout=120)
        with SessionLocal() as db:
            assert db.get(Job, out["jobs"][0]["id"]).status == "failed"
        assert tried and set(tried) == {"byteplus:seedream-5.0-pro"}
    finally:
        monkeypatch.setattr(services_mod.Services, "run_model", real)
        with SessionLocal() as db:
            db.get(AIModel, "fal:bytedance/seedream/v5/pro/edit").status = "disabled"
            db.commit()
    # Auto goes back to the team's chain
    assert ok(c.patch(f"/api/characters/{cid}", headers=H, json={"sheet_engine": "auto"}))["sheet_engine"] == ""
    out = ok(c.post(f"/api/characters/{cid}/sheet", headers=H, json={"kinds": ["front"]}))
    assert out["jobs"][0]["payload"]["engine"] is None
    # a remembered engine that was switched off is reported, never swapped for another one
    ok(c.patch(f"/api/characters/{cid}", headers=H, json={"sheet_engine": "byteplus:seedream-5.0-pro"}))
    with SessionLocal() as db:
        db.get(AIModel, "byteplus:seedream-5.0-pro").status = "disabled"
        db.commit()
    try:
        r = c.post(f"/api/characters/{cid}/sheet", headers=H, json={})
        assert r.status_code == 400 and "switched off" in r.json()["detail"]
    finally:
        with SessionLocal() as db:
            db.get(AIModel, "byteplus:seedream-5.0-pro").status = "enabled"
            db.commit()
    wait_jobs(c, None, timeout=120)


# ── database upgrade ─────────────────────────────────────────────────────────

def test_migration_adds_board_columns(client: TestClient):
    if not is_sqlite():
        return
    with engine.begin() as conn:  # an older database: no origin/meta on assets, no sheet engine on characters
        conn.execute(text('ALTER TABLE character_assets DROP COLUMN "origin"'))
        conn.execute(text('ALTER TABLE character_assets DROP COLUMN "meta"'))
        conn.execute(text('ALTER TABLE characters DROP COLUMN "sheet_engine"'))
    changed = migrate()
    assert {"character_assets.origin", "character_assets.meta", "characters.sheet_engine"} <= set(changed)
    assert migrate() == []
    cols = {c["name"] for c in inspect(engine).get_columns("character_assets")}
    assert {"origin", "meta"} <= cols
    with SessionLocal() as db:
        a = db.query(CharacterAsset).first()
        assert a is not None and a.origin == "" and a.meta == {}
        assert db.query(Character).first().sheet_engine == ""
