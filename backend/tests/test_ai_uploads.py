"""AI-made uploads and the BytePlus asset library: an upload is a real person's photo unless the user attests it is
AI-generated. Only AI-made images are registered; a real person's face never reaches the library (by hand, by itself,
by relabelling an upload, or after archiving). Mock providers only."""
from __future__ import annotations

import io
from types import SimpleNamespace

import pytest
from PIL import Image

from app import settings_store
from app.db import SessionLocal
from app.models import AuditEntry, Character, CharacterAsset, Job
from app.providers import byteplus, mock
from app.providers.base import ProviderError
from app.providers.services import byteplus_assets
from app.storage import get_storage
from app.workers import handlers_hub as hub
from conftest import H, ok, wait_jobs


def _png(w: int = 720, h: int = 1280, color=(180, 120, 90)) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (w, h), color).save(b, "PNG")
    return b.getvalue()


def _upload(c, cid: int, *, ai_made: bool | None = None, w: int = 720, h: int = 1280) -> dict:
    data = {} if ai_made is None else {"ai_made": "true" if ai_made else "false"}
    out = ok(c.post(f"/api/characters/{cid}/upload", headers=H, files={"file": ("x.png", _png(w, h), "image/png")}, data=data))
    return max((a for a in out["assets"] if a["kind"] == "source"), key=lambda a: a["id"])


def _character(c, name: str, *views: str, approved: bool = True) -> int:
    cid = ok(c.post("/api/characters", headers=H, json={"name": name}))["id"]
    st = get_storage()
    with SessionLocal() as db:
        for v in views:
            db.add(CharacterAsset(character_id=cid, kind=v, label=v, approved=approved,
                                  path=st.save_bytes(f"characters/{name}_{v}.png", mock.image(name, "3:4", v))))
        db.commit()
    return cid


def _setting(key: str, value) -> None:
    with SessionLocal() as db:
        settings_store.set_setting(db, key, value)
        db.commit()


def _reg(cid: int) -> dict:
    with SessionLocal() as db:
        return dict((db.get(Character, cid).provider_assets or {}).get("byteplus") or {})


def _audits(action: str, target: str) -> list[AuditEntry]:
    with SessionLocal() as db:
        return db.query(AuditEntry).filter(AuditEntry.action == action, AuditEntry.target == target).all()


def _register(c, cid: int) -> dict:
    ok(c.post(f"/api/characters/{cid}/register/byteplus", headers=H, json={}))
    wait_jobs(c, None, timeout=60)
    return _reg(cid)


# ── attestation ──────────────────────────────────────────────────────────────

def test_attested_upload_and_toggle_are_recorded(client):
    c = client
    cid = _character(c, "Attest Anu", "front")
    ai = _upload(c, cid, ai_made=True)
    assert ai["ai_made"] is True and ai["label"] == "AI-made" and ai["ai_attested_by"] and ai["ai_attested_at"]
    photo = _upload(c, cid)
    assert photo["ai_made"] is False and photo["label"] == "your photo" and photo["ai_attested_by"] is None
    attested = _audits("character.asset.ai_attested", "Attest Anu")
    assert [a.detail["asset_id"] for a in attested] == [ai["id"]] and attested[0].detail["via"] == "upload"

    # attest the photo later, then take it back: both recorded, the default label follows
    out = ok(c.put(f"/api/character-assets/{photo['id']}/ai-made", headers=H, json={"ai_made": True}))
    assert out["asset"]["ai_made"] is True and out["asset"]["label"] == "AI-made" and out["byteplus"] is None
    out = ok(c.put(f"/api/character-assets/{photo['id']}/ai-made", headers=H, json={"ai_made": False}))
    assert out["asset"]["ai_made"] is False and out["asset"]["label"] == "your photo"
    assert out["character"]["byteplus_block"].startswith("Made from a photo of a real person")
    assert len(_audits("character.asset.ai_attested", "Attest Anu")) == 2
    un = _audits("character.asset.ai_unattested", "Attest Anu")
    assert len(un) == 1 and un[0].detail == {"character_id": cid, "asset_id": photo["id"], "via": "toggle"}
    # only uploads carry the attestation
    front = next(a for a in ok(c.get(f"/api/characters/{cid}"))["assets"] if a["kind"] == "front")
    assert c.put(f"/api/character-assets/{front['id']}/ai-made", headers=H, json={"ai_made": True}).status_code == 400


def test_made_from_photo_and_auto_register_reason(client):
    c = client
    cid = _character(c, "Auto Aditi", "front")
    _setting("byteplus_auto_register", True)
    try:
        _upload(c, cid, ai_made=True)  # an AI-made upload registers the character by itself
        wait_jobs(c, None, timeout=60)
        with SessionLocal() as db:
            ch = db.get(Character, cid)
            assert not hub.made_from_photo(db, ch) and hub.auto_register_reason(db, ch) == "Already registered"
        reg = _reg(cid)
        assert reg["status"] == "ready" and [a["kind"] for a in reg["assets"]] == ["source", "front"]
        # a real person's photo next to it: made from a photo, never registered by itself again
        photo = _upload(c, cid)
        with SessionLocal() as db:
            ch = db.get(Character, cid)
            assert hub.made_from_photo(db, ch)
            assert hub.auto_register_reason(db, ch) == hub.PHOTO_REASON.rstrip(".")
        # archiving the photo doesn't clear it: views made from it still show that person
        ok(c.patch(f"/api/character-assets/{photo['id']}", headers=H, json={"archived": True}))
        with SessionLocal() as db:
            assert hub.made_from_photo(db, db.get(Character, cid))
    finally:
        _setting("byteplus_auto_register", settings_store.DEFAULTS["byteplus_auto_register"])


def test_register_images_order(client):
    c = client
    cid = _character(c, "Order Om", "profile", "full_body", "front", "three_quarter", "outfit")
    second = _upload(c, cid, ai_made=True)
    first = _upload(c, cid, ai_made=True)
    real = _upload(c, cid)
    hidden = _upload(c, cid, ai_made=True)
    ok(c.patch(f"/api/character-assets/{hidden['id']}", headers=H, json={"approved": False}))  # not used: not sent
    with SessionLocal() as db:
        ch = db.get(Character, cid)
        cands = hub.register_candidates(db, ch)
        ids = [a.id for a in cands]
        assert ids[:2] == [second["id"], first["id"]]  # attested uploads first, in upload order
        assert [a.kind for a in cands[2:]] == ["front", "three_quarter", "full_body", "profile", "outfit"]
        assert real["id"] not in ids and hidden["id"] not in ids  # a real person's photo never
        assert [a.id for a in hub.register_images(db, ch)] == ids[:hub.REGISTER_MAX]


# ── safety gaps ──────────────────────────────────────────────────────────────

def test_manual_register_refuses_a_real_persons_photo(client):
    c = client
    cid = _character(c, "Manual Meena", "front", "three_quarter")
    photo = _upload(c, cid)
    r = c.post(f"/api/characters/{cid}/register/byteplus", headers=H, json={})
    assert r.status_code == 409 and r.json()["detail"] == hub.PHOTO_REASON
    plan = ok(c.get(f"/api/characters/{cid}/byteplus/plan"))
    assert plan["blocked"] == hub.PHOTO_REASON and [i["kind"] for i in plan["images"]] == ["front", "three_quarter"]
    assert ok(c.get(f"/api/characters/{cid}"))["byteplus_block"] == hub.PHOTO_REASON
    # the user says it's AI-made after all: it goes first
    ok(c.put(f"/api/character-assets/{photo['id']}/ai-made", headers=H, json={"ai_made": True}))
    plan = ok(c.get(f"/api/characters/{cid}/byteplus/plan"))
    assert plan["blocked"] == "" and [i["id"] for i in plan["images"]][0] == photo["id"] and plan["images"][0]["ai_made"]
    reg = _register(c, cid)
    assert reg["status"] == "ready" and [a["source_id"] for a in reg["assets"]][0] == photo["id"]
    assert ok(c.get(f"/api/characters/{cid}/byteplus/plan"))["images"][0]["registered"] == "Active"


def test_asset_kind_cant_cross_the_upload_line(client):
    c = client
    cid = _character(c, "Kind Kavya", "front")
    photo = _upload(c, cid)
    front = next(a for a in ok(c.get(f"/api/characters/{cid}"))["assets"] if a["kind"] == "front")
    assert c.patch(f"/api/character-assets/{photo['id']}", headers=H, json={"kind": "front"}).status_code == 400
    assert c.patch(f"/api/character-assets/{front['id']}", headers=H, json={"kind": "source"}).status_code == 400
    assert ok(c.patch(f"/api/character-assets/{front['id']}", headers=H, json={"kind": "three_quarter"}))["kind"] == "three_quarter"
    assert ok(c.patch(f"/api/character-assets/{photo['id']}", headers=H, json={"kind": "source", "label": "me"}))["label"] == "me"
    with SessionLocal() as db:
        assert db.get(CharacterAsset, photo["id"]).kind == "source"


def test_marking_an_upload_real_removes_the_registration(client):
    c = client
    cid = _character(c, "Unattest Uma", "front")
    ai = _upload(c, cid, ai_made=True)
    assert len(_register(c, cid)["assets"]) == 2
    out = ok(c.put(f"/api/character-assets/{ai['id']}/ai-made", headers=H, json={"ai_made": False}))
    assert out["byteplus"] == {"removed": 2, "error": ""}
    assert out["character"]["seedance_ready"] is False and not (out["character"]["provider_assets"] or {}).get("byteplus")
    assert [a.detail["reason"] for a in _audits("character.unregister_byteplus", "Unattest Uma")] == ["real_person"]
    assert c.post(f"/api/characters/{cid}/register/byteplus", headers=H, json={}).status_code == 409


# ── image limits ─────────────────────────────────────────────────────────────

def test_byteplus_image_limits(monkeypatch, tmp_path):
    fit = byteplus.image_fit
    assert fit(720, 1280, 500_000) == ("ok", "")
    assert fit(299, 800, 1000)[0] == "skip" and "Too small" in fit(299, 800, 1000)[1]
    assert fit(300, 750, 1000)[0] == "ok" and fit(400, 1000, 1000)[0] == "ok"  # 0.4 is still fine
    assert fit(300, 1000, 1000)[0] == "skip" and "shape" in fit(300, 1000, 1000)[1]  # 0.3
    assert fit(2600, 1000, 1000)[0] == "skip" and fit(2500, 1000, 1000)[0] == "ok"
    assert fit(7000, 4000, 1000)[0] == "resize" and fit(1000, 1000, 30 * 1024 * 1024)[0] == "resize"
    assert fit(0, 0, 10)[0] == "skip"
    # a too-large image goes as a smaller copy of the same shape
    src = tmp_path / "big.png"
    Image.new("RGBA", (800, 600), (10, 200, 30, 255)).save(src)
    monkeypatch.setattr(byteplus, "ASSET_MAX_SIDE", 500)
    out = byteplus.library_copy(src, tmp_path)
    with Image.open(out) as im:
        assert im.format == "JPEG" and im.size == (500, 375)


def test_plan_skips_images_byteplus_cant_take(client):
    c = client
    cid = _character(c, "Small Sita", "front")
    tiny = _upload(c, cid, ai_made=True, w=200, h=260)
    thin = _upload(c, cid, ai_made=True, w=1200, h=400)
    plan = ok(c.get(f"/api/characters/{cid}/byteplus/plan"))
    assert [i["kind"] for i in plan["images"]] == ["front"]
    reasons = {s["id"]: s["reason"] for s in plan["skipped"]}
    assert "Too small" in reasons[tiny["id"]] and "shape" in reasons[thin["id"]]
    reg = _register(c, cid)
    assert [a["kind"] for a in reg["assets"]] == ["front"] and {s["source_id"] for s in reg["skipped"]} == {tiny["id"], thin["id"]}
    only_small = _character(c, "Only Small")
    _upload(c, only_small, ai_made=True, w=120, h=120)
    r = c.post(f"/api/characters/{only_small}/register/byteplus", headers=H, json={})
    assert r.status_code == 400 and "fits BytePlus" in r.json()["detail"]


# ── archive → removal ────────────────────────────────────────────────────────

def test_archiving_removes_from_byteplus(client, monkeypatch):
    c = client
    cid = _character(c, "Archive Asha", "front")
    _register(c, cid)
    with SessionLocal() as db:  # a registration waiting to run is stopped too
        j = Job(type="byteplus_register", status="proposed", payload={"character_id": cid}, label="Register")
        db.add(j)
        db.commit()
        jid = j.id
    out = ok(c.patch(f"/api/characters/{cid}", headers=H, json={"archived": True}))
    assert out["byteplus_removal"] == {"removed": 1, "error": ""} and not (out["provider_assets"] or {}).get("byteplus")
    with SessionLocal() as db:
        assert db.get(Job, jid).status == "cancelled"
    assert [a.detail["reason"] for a in _audits("character.unregister_byteplus", "Archive Asha")] == ["archived"]
    assert c.post(f"/api/characters/{cid}/register/byteplus", headers=H, json={}).status_code == 409

    # BytePlus can't be reached: the registration stays, marked and never used, until Remove goes through
    cid2 = _character(c, "Archive Bina", "front")
    reg = _register(c, cid2)
    path = get_storage().abs(reg["assets"][0]["path"])
    assert byteplus_assets([path])  # Seedance would use it now

    def down(db, ch):
        raise ProviderError("BytePlus asset library connection failed", provider="byteplus")

    monkeypatch.setattr(hub, "byteplus_remove", down)
    out = ok(c.patch(f"/api/characters/{cid2}", headers=H, json={"archived": True}))
    assert out["byteplus_removal"]["error"] == hub.REMOVE_FAILED and out["seedance_ready"] is False
    reg = out["provider_assets"]["byteplus"]
    assert reg["withdrawn"] == "archived" and reg["status"] == "failed" and "Couldn't remove" in reg["error"]
    assert byteplus_assets([path]) == {}  # never used again here
    still_down = c.delete(f"/api/characters/{cid2}/byteplus", headers=H)
    assert still_down.status_code == 502  # still down: still marked
    assert _reg(cid2)["withdrawn"] == "archived"
    monkeypatch.undo()
    removed = ok(c.delete(f"/api/characters/{cid2}/byteplus", headers=H))
    assert removed["removed"] == 1
    assert _reg(cid2) == {}


def test_a_withdrawn_registration_is_never_written_by_the_run(client):
    c = client
    cid = _character(c, "Race Rani", "front")
    with SessionLocal() as db:
        ch = db.get(Character, cid)
        ch.provider_assets = {"byteplus": {"job_id": 7, "status": "registering", "assets": []}}
        db.commit()
    ctx = SimpleNamespace(job_id=7, project_id=None)
    assert hub._save_reg(ctx, cid, status="ready")["status"] == "ready"
    assert hub._save_reg(SimpleNamespace(job_id=8, project_id=None), cid, status="failed") is None  # not its run
    with SessionLocal() as db:
        ch = db.get(Character, cid)
        ch.provider_assets = {"byteplus": {**ch.provider_assets["byteplus"], "withdrawn": "archived"}}
        db.commit()
    assert hub._save_reg(ctx, cid, assets=[{"asset_id": "late"}]) is None
    assert hub._save_reg(ctx, cid, claim=True, status="registering") is None
    assert _reg(cid)["assets"] == []


# ── database upgrade ─────────────────────────────────────────────────────────

def test_migration_adds_the_attestation_columns(client):
    from sqlalchemy import inspect, text

    from app.db import engine, is_sqlite
    from app.db_migrate import migrate
    if not is_sqlite():
        pytest.skip("SQLite only")
    try:
        with engine.begin() as conn:
            for col in ("ai_made", "ai_attested_by", "ai_attested_at"):
                conn.execute(text(f"ALTER TABLE character_assets DROP COLUMN {col}"))
    except Exception:
        pytest.skip("this SQLite can't drop columns")
    changed = migrate()
    assert {"character_assets.ai_made", "character_assets.ai_attested_by", "character_assets.ai_attested_at"} <= set(changed)
    assert {"ai_made", "ai_attested_at"} <= {col["name"] for col in inspect(engine).get_columns("character_assets")}
    with SessionLocal() as db:  # existing uploads count as a real person's photo
        assert db.query(CharacterAsset).filter(CharacterAsset.ai_made.is_(True)).count() == 0
