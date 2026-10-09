"""OpenRouter and BytePlus providers, and one model through several routes (cheapest live route first)."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

from app import settings_store
from app.core import model_hub
from app.db import SessionLocal
from app.models import AIModel, Character, CharacterAsset
from app.providers import byteplus, mock, openrouter
from app.providers import services as services_mod
from app.providers.base import ProviderBlocked, ProviderError, RetryableProviderError
from app.providers.schema_map import GenRequest
from app.storage import get_storage
from conftest import H, TMP, ok, wait_jobs


def _mp4(tmp: Path, seconds: float = 2) -> bytes:
    out = tmp / "clip.mp4"
    mock.video_from(None, "test", out, seconds, "9:16")
    return out.read_bytes()


def _png(tmp: Path, name: str = "frame.png") -> Path:
    p = tmp / name
    p.write_bytes(mock.image("frame", "9:16", "test"))
    return p


# ── OpenRouter catalog and prices ────────────────────────────────────────────

def test_openrouter_prices_prefer_sound_and_read_tokens():
    kling = openrouter.price_table({"duration_seconds": "0.112", "duration_seconds_with_audio": "0.168",
                                    "image_to_video_duration_seconds_720p": "0.112"}, ["720p"])
    assert kling == {"720p": 0.168, "default": 0.168}  # the studio asks for sound
    seedance = openrouter.price_table({"video_tokens": "0.000007", "video_tokens_1080p": "0.0000077",
                                       "video_tokens_with_video_input": "0.0000043"}, ["480p", "720p", "1080p", "4K"])
    assert seedance["720p"] == pytest.approx(0.1512) and seedance["1080p"] == pytest.approx(0.37422)
    assert "4k" in seedance  # the catalog writes "4K"
    grok = openrouter.price_table({"cents_per_image_input": "1", "cents_per_video_output_second_720p": "3"}, ["720p"])
    assert grok == {"720p": 0.03}


def test_openrouter_model_row():
    row = openrouter.model_row({"id": "bytedance/seedance-2.0", "name": "ByteDance: Seedance 2.0", "created": 1780000000,
                                "supported_frame_images": ["first_frame", "last_frame"], "supported_durations": [4, 8, 15],
                                "supported_resolutions": ["480p", "720p"], "supported_aspect_ratios": ["16:9", "9:16"],
                                "pricing_skus": {"video_tokens": "0.000007"}})
    assert row["id"] == "openrouter:bytedance/seedance-2.0" and row["task"] == "video"
    assert row["capabilities"]["modes"] == ["flf", "i2v", "ref2v", "t2v"] and row["capabilities"]["native_audio"]
    assert row["price_unit"] == "second" and row["price_usd"] == pytest.approx(0.1512)
    upscale = openrouter.model_row({"id": "black-forest-labs/flux-video-upscale", "name": "Flux Upscale",
                                    "pricing_skus": {"cents_per_megapixel_second_precise": "7.5"}})
    assert upscale["capabilities"]["usable"] is False and upscale["task"] == "other"


# ── OpenRouter video ─────────────────────────────────────────────────────────

def _or_model(**caps) -> AIModel:
    return AIModel(id="openrouter:bytedance/seedance-2.0", provider="openrouter", endpoint="bytedance/seedance-2.0",
                   task="video", display_name="Seedance 2.0 (OpenRouter)", price_usd=0.15, price_unit="second",
                   capabilities={"modes": ["t2v", "i2v", "flf", "ref2v"], "durations": [4, 8], "resolutions": ["720p"],
                                 "aspects": ["16:9", "9:16"], "native_audio": True, "max_refs": 3, **caps})


def test_openrouter_video_job(client, monkeypatch, tmp_path):
    video = _mp4(tmp_path)
    calls: list[tuple[str, str, dict | None]] = []
    polls = iter([{"id": "v1", "status": "in_progress"},
                  {"id": "v1", "status": "completed", "usage": {"cost": 0.84}}])

    def handle(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content) if req.content else None
        calls.append((req.method, req.url.path, body))
        assert req.headers["authorization"] == "Bearer or-key"
        if req.method == "POST" and req.url.path.endswith("/videos"):
            return httpx.Response(202, json={"id": "v1", "status": "pending"})
        if req.url.path.endswith("/videos/v1"):
            return httpx.Response(200, json=next(polls))
        if req.url.path.endswith("/videos/v1/content"):
            return httpx.Response(200, content=video)
        return httpx.Response(404)

    client = openrouter.OpenRouterClient("or-key", http=httpx.Client(transport=httpx.MockTransport(handle)))
    monkeypatch.setattr(openrouter.time, "sleep", lambda s: None)
    svc = services_mod.Services()
    monkeypatch.setattr(svc, "openrouter", lambda: client)
    frame = _png(tmp_path)
    saved = []
    req = GenRequest(mode="i2v", prompt="A boy runs", negative="text", first_frame=frame, duration=8, aspect="9:16")
    res = svc._openrouter_video(_or_model(), req, 8, None, saved.append, None)
    post = calls[0][2]
    assert post["model"] == "bytedance/seedance-2.0" and post["duration"] == 8 and post["aspect_ratio"] == "9:16"
    assert post["resolution"] == "720p" and post["generate_audio"] is True and "Avoid: text" in post["prompt"]
    first = post["frame_images"][0]
    assert first["frame_type"] == "first_frame" and first["image_url"]["url"].startswith("data:image/png;base64,")
    assert saved == ["v1"] and res.usage.usd == 0.84 and res.usage.provider == "openrouter" and res.data == video


def test_openrouter_errors():
    def client(resp: httpx.Response) -> openrouter.OpenRouterClient:
        return openrouter.OpenRouterClient("k", http=httpx.Client(transport=httpx.MockTransport(lambda r: resp)))

    with pytest.raises(ProviderError, match="credit"):
        client(httpx.Response(402, json={"error": {"message": "Insufficient credits"}})).start_video({})
    with pytest.raises(ProviderBlocked):
        client(httpx.Response(400, json={"error": {"message": "Request flagged by content moderation"}})).start_video({})
    with pytest.raises(RetryableProviderError) as e:
        client(httpx.Response(429, json={"error": {"message": "slow down"}})).start_video({})
    assert e.value.rate_limited
    failed = client(httpx.Response(200, json={"id": "v", "status": "failed", "error": "Output blocked by safety filter"}))
    with pytest.raises(ProviderBlocked):
        failed.wait_video("v")


# ── BytePlus ─────────────────────────────────────────────────────────────────

def test_byteplus_signature_vector():
    # same result as BytePlus's reference signer (byteplus-sa/ark-mcp signing.py) for these inputs
    h = byteplus.sign(access_key="AKLTtest", secret_key="secret/key+x==", method="POST",
                      host="ark.ap-southeast-1.byteplusapi.com", query={"Action": "CreateAssetGroup", "Version": "2024-01-01"},
                      payload=b'{"Name":"tatvam-char-1","GroupType":"AIGC"}', region="ap-southeast-1",
                      now=datetime(2026, 10, 9, 12, 34, 56, tzinfo=timezone.utc))
    assert h["X-Date"] == "20261009T123456Z"
    assert h["Authorization"] == ("HMAC-SHA256 Credential=AKLTtest/20261009/ap-southeast-1/ark/request, "
                                  "SignedHeaders=content-type;host;x-content-sha256;x-date, "
                                  "Signature=83a529f22b4aee6a750040bbbc72a35da56c5e8ca6c647346d661d93aab2cc28")


def _bp_model() -> AIModel:
    b = next(x for x in model_hub.BUILTINS if x["id"] == "byteplus:seedance-2.0")
    return AIModel(id=b["id"], provider="byteplus", endpoint=b["endpoint"], task="video", display_name=b["display_name"],
                   capabilities=b["capabilities"], price_usd=b["price_usd"], price_unit="second", builtin=True)


def _ark(handle) -> byteplus.ArkClient:
    return byteplus.ArkClient("ark-key", http=httpx.Client(transport=httpx.MockTransport(handle)))


def test_seedance_task(client, monkeypatch, tmp_path):
    video = _mp4(tmp_path)
    bodies: list[dict] = []
    polls = iter([{"id": "t1", "status": "running"},
                  {"id": "t1", "status": "succeeded", "content": {"video_url": "https://cdn.example/v.mp4"},
                   "usage": {"completion_tokens": 100_000}, "resolution": "720p"}])

    def handle(req: httpx.Request) -> httpx.Response:
        if req.url.host == "cdn.example":
            return httpx.Response(200, content=video)
        assert req.headers["authorization"] == "Bearer ark-key"
        if req.method == "POST":
            bodies.append(json.loads(req.content))
            return httpx.Response(200, json={"id": "t1"})
        return httpx.Response(200, json=next(polls))

    monkeypatch.setattr(byteplus.time, "sleep", lambda s: None)
    svc = services_mod.Services()
    monkeypatch.setattr(svc, "ark", lambda: _ark(handle))
    req = GenRequest(mode="i2v", prompt="A boy runs", first_frame=_png(tmp_path), duration=8, aspect="9:16")
    res = svc._seedance(_bp_model(), req, 8, None, None, None)
    body = bodies[0]
    assert body["model"] == "dreamina-seedance-2-0-260128" and body["ratio"] == "adaptive" and body["duration"] == 8
    assert body["content"][0] == {"type": "text", "text": "A boy runs"}
    assert body["content"][1]["role"] == "first_frame" and body["watermark"] is False
    assert res.usage.usd == pytest.approx(100_000 * 7.0 / 1e6)  # billed tokens × rate
    assert res.remote_ref == "byteplus:t1"


def _registered_character(tmp_path) -> tuple[int, Path]:
    st = get_storage()
    rel = st.save_bytes("characters/test_bp_front.png", mock.image("Asha", "3:4", "front"))
    with SessionLocal() as db:
        ch = Character(name="Asha BP")
        db.add(ch)
        db.flush()
        a = CharacterAsset(character_id=ch.id, kind="front", path=rel, approved=True)
        db.add(a)
        db.flush()
        ch.provider_assets = {"byteplus": {"status": "ready", "assets": [
            {"asset_id": "asset-123", "source_id": a.id, "path": rel, "kind": "front", "status": "Active"}]}}
        db.commit()
        return ch.id, st.abs(rel)


def test_blocked_keyframe_retries_with_registered_character(client, monkeypatch, tmp_path):
    video = _mp4(tmp_path)
    cid, front = _registered_character(tmp_path)
    bodies: list[dict] = []

    def handle(req: httpx.Request) -> httpx.Response:
        if req.url.host == "cdn.example":
            return httpx.Response(200, content=video)
        if req.method == "POST":
            body = json.loads(req.content)
            bodies.append(body)
            if any(c.get("role") == "first_frame" for c in body["content"]):
                return httpx.Response(400, json={"error": {"code": "InputImageSensitiveContentDetected.PrivacyInformation",
                                                           "message": "The input image may contain real person"}})
            return httpx.Response(200, json={"id": "t2"})
        return httpx.Response(200, json={"id": "t2", "status": "succeeded", "content": {"video_url": "https://cdn.example/v.mp4"}})

    monkeypatch.setattr(byteplus.time, "sleep", lambda s: None)
    svc = services_mod.Services()
    monkeypatch.setattr(svc, "ark", lambda: _ark(handle))
    req = GenRequest(mode="i2v", prompt="Asha smiles", first_frame=_png(tmp_path), duration=8, aspect="9:16",
                     cast_refs=[("Asha BP (front)", front)])
    res = svc._seedance(_bp_model(), req, 8, None, None, None)
    assert len(bodies) == 2 and res.remote_ref == "byteplus:t2"
    second = bodies[1]
    refs = [c for c in second["content"] if c.get("role") == "reference_image"]
    assert refs == [{"type": "image_url", "image_url": {"url": "asset://asset-123"}, "role": "reference_image"}]
    assert second["ratio"] == "9:16" and second["content"][0]["text"].startswith("Image 1 is Asha BP.")


def test_asset_library_signed_calls():
    seen: list[httpx.Request] = []

    def handle(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        action = req.url.params["Action"]
        if action == "ListAssetGroups":
            return httpx.Response(200, json={"Result": {"Items": [{"Id": "group-9", "Name": "tatvam-1-asha"}]}})
        if action == "CreateAsset":
            return httpx.Response(200, json={"ResponseMetadata": {"Error": {"Code": "InvalidParameter", "Message": "bad URL"}}})
        return httpx.Response(404)

    lib = byteplus.AssetLibrary("AKLTtest:secret", http=httpx.Client(transport=httpx.MockTransport(handle)))
    assert lib.ensure_group("tatvam-1-asha") == "group-9"  # reused, not created again
    assert seen[0].headers["authorization"].startswith("HMAC-SHA256 Credential=AKLTtest/")
    assert seen[0].url.host == "ark.ap-southeast-1.byteplusapi.com" and seen[0].url.params["Version"] == "2024-01-01"
    with pytest.raises(ProviderError, match="InvalidParameter"):
        lib.create_asset("group-9", "https://x/y.png", "Asha front")


def test_register_character_with_byteplus(client):
    c = client
    cid, _ = _registered_character(None)
    with SessionLocal() as db:  # start from nothing registered
        ch = db.get(Character, cid)
        ch.provider_assets = {}
        db.commit()
    ok(c.post(f"/api/characters/{cid}/register/byteplus", headers=H, json={}))
    wait_jobs(c, None, timeout=60)
    with SessionLocal() as db:
        reg = db.get(Character, cid).provider_assets["byteplus"]
    assert reg["status"] == "ready" and reg["group_id"] == f"mock-group-{cid}"
    assert [a["status"] for a in reg["assets"]] == ["Active"] and reg["assets"][0]["asset_id"].startswith("asset-mock-")
    empty = ok(c.post("/api/characters", headers=H, json={"name": "No Sheet Yet"}))
    assert c.post(f"/api/characters/{empty['id']}/register/byteplus", headers=H, json={}).status_code == 400


# ── routes ───────────────────────────────────────────────────────────────────

def test_route_keys_match_across_providers():
    k = model_hub.route_key_of
    assert k("dreamina-seedance-2-0-260128") == k("bytedance/seedance-2.0") == "seedance-2"
    assert k("dreamina-seedance-2-5-premium-260915") == "seedance-2.5-premium"
    assert k("fal-ai/kling-video/v3/pro/image-to-video") == k("kwaivgi/kling-v3.0-pro") == "kling-3-pro"
    assert k("Veo 3.1 Fast") == k("google/veo-3.1-fast") == "veo-3.1-fast"
    assert k("bytedance/seedream/v5/pro/edit") == k("seedream-5-0-pro-260628")
    assert k("runway/gen-4.5") == ""  # unknown family: never merged


def test_cheapest_live_route_first(client, monkeypatch):
    monkeypatch.setattr(model_hub, "provider_mode", lambda p: "live")
    with SessionLocal() as db:
        orow = db.get(AIModel, "openrouter:bytedance/seedance-2.0") or AIModel(
            id="openrouter:bytedance/seedance-2.0", provider="openrouter", endpoint="bytedance/seedance-2.0")
        orow.task, orow.status, orow.display_name = "video", "enabled", "Seedance 2.0 (OpenRouter)"
        orow.capabilities = {"modes": ["i2v", "t2v"], "price_by_resolution": {"720p": 0.10}}
        orow.price_usd, orow.price_unit, orow.price_source = 0.10, "second", "live"
        db.merge(orow)
        settings_store.set_setting(db, "google_first", False)
        settings_store.set_setting(db, "engine_policy", {"video.balanced": ["byteplus:seedance-2.0"]})
        db.commit()
        try:
            ids = [m.id for m, _ in model_hub.candidates(db, "video.balanced", ["i2v"])]
            assert ids[:2] == ["openrouter:bytedance/seedance-2.0", "byteplus:seedance-2.0"]  # cheaper route first
            picked = [m.id for m, _ in model_hub.candidates(db, "video.balanced", ["i2v"], explicit="byteplus:seedance-2.0")]
            assert picked == ["byteplus:seedance-2.0", "openrouter:bytedance/seedance-2.0"]  # your pick first, then routes
            settings_store.set_setting(db, "cheapest_route", False)
            db.commit()
            assert model_hub.candidates(db, "video.balanced", ["i2v"])[0][0].id == "byteplus:seedance-2.0"
        finally:
            for key in ("google_first", "engine_policy", "cheapest_route"):
                settings_store.set_setting(db, key, settings_store.DEFAULTS[key])
            db.get(AIModel, "openrouter:bytedance/seedance-2.0").status = "disabled"
            db.commit()


def test_video_engines_lists_a_model_once(client, monkeypatch):
    with SessionLocal() as db:
        row = db.get(AIModel, "openrouter:bytedance/seedance-2.0")
        row.status = "enabled"
        db.commit()
    try:
        data = ok(client.get("/api/engines/video"))
        seed = [e for e in data["engines"] if e["route_key"] == "seedance-2"]
        assert len(seed) == 1 and {r["id"] for r in seed[0]["routes"]} >= {"byteplus:seedance-2.0",
                                                                          "openrouter:bytedance/seedance-2.0"}
        models = ok(client.get("/api/models?provider=byteplus"))["models"]
        bp = next(m for m in models if m["id"] == "byteplus:seedance-2.0")
        assert [r["id"] for r in bp["other_routes"]] == ["openrouter:bytedance/seedance-2.0"]
    finally:
        with SessionLocal() as db:
            db.get(AIModel, "openrouter:bytedance/seedance-2.0").status = "disabled"
            db.commit()


def test_openrouter_catalog_sync(client, monkeypatch):
    listed = [{"id": "kwaivgi/kling-v3.0-pro", "name": "Kling: Kling 3.0 Pro", "supported_frame_images": ["first_frame"],
               "supported_durations": [5, 10], "supported_resolutions": ["720p"], "pricing_skus": {"duration_seconds": "0.112"}},
              {"id": "black-forest-labs/flux-video-upscale", "name": "Flux Upscale", "pricing_skus": {}}]
    monkeypatch.setattr(openrouter, "list_video_models", lambda http=None: listed)
    monkeypatch.setattr(openrouter, "list_image_models", lambda http=None: [])
    real_key = settings_store.api_key
    monkeypatch.setattr(settings_store, "api_key", lambda p: "or-key" if p == "openrouter" else real_key(p))
    with SessionLocal() as db:
        for m in db.query(AIModel).filter(AIModel.provider == "openrouter", AIModel.id.like("%kling%")).all():
            db.delete(m)
        db.commit()
    out = model_hub.sync_openrouter()
    assert out["total"] == 2
    with SessionLocal() as db:
        kling = db.get(AIModel, "openrouter:kwaivgi/kling-v3.0-pro")
        assert kling.task == "video" and kling.price_usd == pytest.approx(0.112) and kling.price_source == "live"
        assert db.get(AIModel, "openrouter:black-forest-labs/flux-video-upscale").status in ("disabled", "new")


def test_text_route(client, monkeypatch):
    svc = services_mod.Services()
    modes = {"openrouter": "live", "gemini": "missing"}
    monkeypatch.setattr(services_mod, "provider_mode", lambda p: modes.get(p, "mock"))
    assert svc.text_route() == "openrouter"  # no Gemini key: OpenRouter writes
    modes["gemini"] = "live"
    assert svc.text_route() == "gemini"  # the team's default
    with SessionLocal() as db:
        settings_store.set_setting(db, "text_provider", "openrouter")
        db.commit()
    try:
        assert svc.text_route() == "openrouter" and svc.text_route(videos=True) == "gemini"  # Gemini watches clips
    finally:
        with SessionLocal() as db:
            settings_store.set_setting(db, "text_provider", "gemini")
            db.commit()
