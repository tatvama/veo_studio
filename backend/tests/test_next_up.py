"""TATVAM_PLAN 19.1 (mock providers): blocked-shot recovery and the safety / quota fallbacks, spend safety (credit holds,
balances, approval for pricier fallbacks), Seedance-ready characters, more from Seedance (dialogue from recorded audio,
extending a clip, 480p drafts), OpenRouter images, and one card per model in the Model Hub."""
from __future__ import annotations

import base64
import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from app import settings_store
from app.core import credit, jobs as jobs_core, model_hub
from app.db import SessionLocal
from app.models import AIModel, Approval, Character, CharacterAsset, Job, Shot, Take, User
from app.pipeline import ffmpeg as ff
from app.pipeline.selection import is_real
from app.providers import byteplus, mock, openrouter
from app.providers import services as services_mod
from app.providers.base import (MediaResult, NeedsApproval, ProviderBlocked, ProviderOutOfCredit, RetryableProviderError,
                                Usage)
from app.providers.schema_map import GenRequest
from app.storage import get_storage
from app.workers import handlers
from app.workers.worker import Worker
from conftest import H, ok, wait_jobs


class FakeCtx:
    """Just enough of a JobContext for run_chain."""

    def __init__(self, run_model, shot_id: int | None = None, result: dict | None = None):
        self.job_id, self.shot_id, self.project_id = 0, shot_id, None
        self.result = dict(result or {})
        self.services = SimpleNamespace(run_model=run_model)

    def check_cancel(self) -> None:
        pass

    def progress(self, p: float, message: str = "") -> None:
        pass

    def tick(self, label: str, expected_s: float = 90):
        return lambda elapsed: True

    def save_result(self, **kw) -> None:
        self.result.update(kw)


def _ok_result(m: AIModel) -> MediaResult:
    return MediaResult(b"clip", "mp4", Usage(m.provider, m.endpoint, m.task, 8, "seconds", 0.0, mock=True))


def _build(m: AIModel, mode: str) -> GenRequest:
    return GenRequest(mode=mode, prompt="Asha smiles", duration=8)


@pytest.fixture
def no_cooling(monkeypatch):
    monkeypatch.setattr(handlers.ratelimit, "cooling", lambda p: 0)
    monkeypatch.setattr(handlers.ratelimit, "google_spend_wait", lambda usd: 0)


def _setting(key: str, value) -> None:
    with SessionLocal() as db:
        settings_store.set_setting(db, key, value)
        db.commit()


def _reset(*keys: str) -> None:
    with SessionLocal() as db:
        for k in keys:
            settings_store.set_setting(db, k, settings_store.DEFAULTS[k])
        db.commit()


# ── run_chain: safety fallback, quota fallback, approval for pricier fallbacks ─

def _blocked_on_google(m: AIModel, req: GenRequest, **kw) -> MediaResult:
    if m.provider == "google":
        raise ProviderBlocked("Veo: the image may show a celebrity", provider="google")
    return _ok_result(m)


def test_safety_block_is_recorded_and_fallback_is_opt_in(client, no_cooling):
    ctx = FakeCtx(_blocked_on_google)
    with pytest.raises(ProviderBlocked):  # Google first, fallback off: nothing else is tried
        handlers.run_chain(ctx, "video.balanced", ["i2v"], _build)
    assert ctx.result["blocked_engines"] == ["google:video_balanced"]
    _setting("safety_fallback", True)
    try:
        m, mode, res, attempts = handlers.run_chain(FakeCtx(_blocked_on_google), "video.balanced", ["i2v"], _build)
        assert m.provider != "google" and attempts[0]["engine"] == "google:video_balanced"
    finally:
        _reset("safety_fallback")


def test_pricier_fallback_waits_for_approval(client, no_cooling, monkeypatch):
    monkeypatch.setattr(handlers, "_run_price", lambda m, req: 0.4 if m.provider == "google" else 3.0)
    _setting("safety_fallback", True)
    try:
        with pytest.raises(NeedsApproval) as e:
            handlers.run_chain(FakeCtx(_blocked_on_google), "video.balanced", ["i2v"], _build)
        assert e.value.extra_usd == pytest.approx(2.6)  # $3.00 against the $0.40 the job was priced at
        # once a producer approved the extra, the same fallback runs
        m, *_ = handlers.run_chain(FakeCtx(_blocked_on_google, result={"extra_ok_usd": 2.6}), "video.balanced", ["i2v"],
                                   _build)
        assert m.provider != "google"
    finally:
        _reset("safety_fallback")


def test_approval_for_extra_cost_requeues_the_job(client):
    with SessionLocal() as db:
        admin = db.query(User).filter(User.role == "admin").first()
        j = Job(type="test_noop", status="awaiting_approval", batch_id="extra-batch", requested_by=admin.id,
                label="Video S01", result={"extra_asked_usd": 1.25})
        db.add(j)
        db.commit()
        jid, admin_id = j.id, admin.id
    Worker._ask_extra(jid, NeedsApproval("Seedance costs more", extra_usd=1.25, engine="byteplus:seedance-2.5"))
    with SessionLocal() as db:
        a = db.query(Approval).filter(Approval.batch_id == "extra-batch").one()
        assert a.amount_usd == 1.25 and a.status == "pending" and a.needs_role == "producer"
        jobs_core.decide_approval(db, db.get(User, admin_id), a.id, True)
        job = db.get(Job, jid)
        assert job.result["extra_ok_usd"] == 1.25 and "extra_asked_usd" not in job.result


def test_quota_fallback_uses_the_same_model_elsewhere(client, monkeypatch):
    with SessionLocal() as db:
        row = db.get(AIModel, "openrouter:google/gemini-nano-banana-2.1") or AIModel(
            id="openrouter:google/gemini-nano-banana-2.1", provider="openrouter", endpoint="google/gemini-nano-banana-2.1")
        row.task, row.status, row.display_name = "image", "enabled", "Nano Banana 2.1 (OpenRouter)"
        row.capabilities = {"modes": ["t2i", "i2i"], "max_refs": 14}
        db.merge(row)
        db.commit()
    monkeypatch.setattr(handlers.ratelimit, "cooling", lambda p: 30 if p == "google" else 0)
    build = lambda m, mode: GenRequest(mode=mode, prompt="a keyframe")  # noqa: E731
    ran = FakeCtx(lambda m, req, **kw: _ok_result(m))
    with pytest.raises(RetryableProviderError):  # Google first stays strict by default: the job waits for Google
        handlers.run_chain(ran, "image", ["t2i"], build)
    _setting("quota_fallback_routes", True)
    try:
        m, *_ = handlers.run_chain(FakeCtx(lambda m, req, **kw: _ok_result(m)), "image", ["t2i"], build)
        assert m.provider != "google" and model_hub.route_key(m) == "nano-banana-2.1"
    finally:
        _reset("quota_fallback_routes")


# ── spend safety ─────────────────────────────────────────────────────────────

def test_no_credit_hold_skips_the_provider(client, no_cooling):
    def out_of_credit(m, req, **kw):
        if m.provider == "byteplus":
            raise ProviderOutOfCredit("BytePlus account has no balance", provider="byteplus")
        return _ok_result(m)

    try:
        m, *_ = handlers.run_chain(FakeCtx(out_of_credit), "video.balanced", ["i2v"], _build,
                                   explicit="byteplus:seedance-2.0")
        assert m.provider != "byteplus"  # another route of Seedance took the job
    except ProviderOutOfCredit:
        pass  # no other Seedance route is switched on in this test database: still held below
    with SessionLocal() as db:
        assert "byteplus" in credit.holds(db)
        ids = [x.id for x, _ in model_hub.candidates(db, "video.balanced", ["i2v"], explicit="byteplus:seedance-2.0")]
        assert not any(i.startswith("byteplus:") for i in ids)
        credit.release(db)
        db.commit()
        ids = [x.id for x, _ in model_hub.candidates(db, "video.balanced", ["i2v"], explicit="byteplus:seedance-2.0")]
        assert "byteplus:seedance-2.0" in ids


def test_byteplus_zero_cash_never_skips(client, monkeypatch):
    """BytePlus reports prepaid cash only: an account on card billing or a savings plan reads $0 and can still pay."""
    monkeypatch.setattr(services_mod, "provider_mode", lambda p: "live")
    monkeypatch.setattr(credit, "_read_balance", lambda p: {"usd": 0.0})
    with SessionLocal() as db:
        credit.release(db)
        db.commit()
    assert credit.balance("byteplus", refresh=True)["usd"] == 0.0
    assert credit.short_of("byteplus", 3.0) == ""
    with SessionLocal() as db:
        assert "byteplus" not in credit.holds(db)
    row = next(p for p in credit.status() if p["provider"] == "byteplus")
    assert row["cash_only"] is True and row["held"] is False
    credit.balance("openrouter", refresh=True)  # OpenRouter's balance is real credit: $0 still holds it
    with SessionLocal() as db:
        assert "openrouter" in credit.holds(db)
        credit.release(db)
        db.commit()


def test_byteplus_balance_names_the_billing_policy():
    denied = {"ResponseMetadata": {"Error": {"Code": "AccessDenied", "Message": "User is not authorized to perform: "
                                                                                "billing:QueryBalanceAcct on resource: "}}}
    lib = byteplus.AssetLibrary("AKAP:secret", http=httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(403, json=denied))))
    with pytest.raises(byteplus.ProviderError, match="BillingCenterReadOnlyAccess"):
        lib.balance()


def test_byteplus_asset_library_names_the_missing_plan():
    """Seen live: CreateAssetGroup answers SubscriptionRequired until Advanced Creation Rights is on. Not a key problem."""
    no_plan = {"ResponseMetadata": {"Error": {"Code": "SubscriptionRequired", "Message": "This API requires an active "
                                              "subscription. Please subscribe to an advanced or premium plan."}}}
    lib = byteplus.AssetLibrary("AKAP:secret", http=httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(403, json=no_plan))))
    with pytest.raises(byteplus.ProviderError, match="Advanced Creation Rights") as e:
        lib.ensure_group("Asha")
    assert "access key" not in str(e.value)


def test_openrouter_balance_and_providers_live_count(client):
    def handle(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/key"):
            return httpx.Response(200, json={"data": {"limit_remaining": 4.5, "usage": 1.2}})
        if req.url.path.endswith("/credits"):
            return httpx.Response(200, json={"data": {"total_credits": 10, "total_usage": 7.5}})
        return httpx.Response(404)

    c = openrouter.OpenRouterClient("k", http=httpx.Client(transport=httpx.MockTransport(handle)))
    assert c.balance()["usd"] == 2.5  # the smaller of the key's limit and the account's credit
    forbidden = openrouter.OpenRouterClient("k", http=httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(403) if r.url.path.endswith("/credits") else handle(r))))
    assert forbidden.balance()["usd"] == 4.5  # a normal key can't read the account credit
    providers = ok(client.get("/api/providers"))
    assert next(p for p in providers if p["provider"] == "byteplus_iam")["engine"] is False
    assert next(p for p in providers if p["provider"] == "byteplus")["engine"] is True
    assert {p["provider"] for p in ok(client.get("/api/providers/credit"))["providers"]} == {"openrouter", "byteplus"}


# ── OpenRouter images ────────────────────────────────────────────────────────

NANO = {"id": "google/gemini-nano-banana-2.1", "name": "Google: Nano Banana 2.1", "created": 1791300825,
        "architecture": {"input_modalities": ["image", "text"], "output_modalities": ["image", "text"]},
        "supported_parameters": {"aspect_ratio": {"type": "enum", "values": ["1:1", "9:16", "16:9"]},
                                 "input_references": {"type": "range", "min": 0, "max": 14}}}


def test_openrouter_image_rows_join_the_google_model():
    row = openrouter.image_model_row(NANO)
    assert row["task"] == "image" and row["capabilities"]["max_refs"] == 14 and row["capabilities"]["modes"] == ["t2i", "i2i"]
    assert model_hub.route_key_of(row["endpoint"]) == model_hub.route_key_of("Nano Banana 2.1") == "nano-banana-2.1"
    pro = openrouter.image_model_row({"id": "google/gemini-3-pro-image", "name": "Google: Nano Banana Pro (Gemini 3 Pro Image)"})
    assert model_hub.route_key_of(pro["display_name"]) == model_hub.route_key_of("Nano Banana Pro (Gemini 3 Pro Image)")
    assert model_hub.route_key_of("bytedance-seed/seedream-5-0-pro") == model_hub.route_key_of("seedream-5-0-pro-260628")

    def prices(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"endpoints": [{"pricing": [
            {"billable": "output_image", "unit": "image", "cost_usd": 0.045},
            {"billable": "output_image", "unit": "image", "cost_usd": 0.09, "variant": "high_resolution"},
            {"billable": "input_image", "unit": "image", "cost_usd": 0.003}]}]})

    assert openrouter.image_price("x/y", http=httpx.Client(transport=httpx.MockTransport(prices))) == 0.045


def test_openrouter_image_call_and_chat_fallback(tmp_path, monkeypatch):
    png = mock.image("frame", "9:16", "test")
    ref = tmp_path / "ref.png"
    ref.write_bytes(png)
    bodies: list[tuple[str, dict]] = []

    def images_api(req: httpx.Request) -> httpx.Response:
        bodies.append((req.url.path, json.loads(req.content)))
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png).decode(), "media_type": "image/png"}],
                                         "usage": {"cost": 0.04}})

    svc = services_mod.Services()
    m = AIModel(id="openrouter:google/gemini-nano-banana-2.1", provider="openrouter",
                endpoint="google/gemini-nano-banana-2.1", task="image", capabilities={"modes": ["t2i", "i2i"],
                                                                                      "max_refs": 14, "aspects": ["9:16"]})
    monkeypatch.setattr(svc, "openrouter", lambda: openrouter.OpenRouterClient(
        "k", http=httpx.Client(transport=httpx.MockTransport(images_api))))
    res = svc._openrouter_image(m, GenRequest(mode="i2i", prompt="Asha at the temple", refs=[ref], aspect="9:16"))
    path, body = bodies[0]
    assert path.endswith("/images") and body["aspect_ratio"] == "9:16" and body["model"] == m.endpoint
    assert body["input_references"][0]["image_url"]["url"].startswith("data:image/png;base64,")
    assert res.data == png and res.usage.usd == 0.04 and res.usage.provider == "openrouter"

    def chat_only(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/images"):
            return httpx.Response(404)
        body = json.loads(req.content)
        assert body["modalities"] == ["image", "text"]
        url = f"data:image/png;base64,{base64.b64encode(png).decode()}"
        return httpx.Response(200, json={"choices": [{"message": {"images": [{"image_url": {"url": url}}]}}],
                                         "usage": {"cost": 0.03}})

    data, mime, cost = openrouter.OpenRouterClient("k", http=httpx.Client(transport=httpx.MockTransport(chat_only))).image(
        "google/gemini-2.5-flash-image", "a lamp", [], "9:16")
    assert data == png and mime == "image/png" and cost == 0.03


# ── more from Seedance ───────────────────────────────────────────────────────

def _bp(key: str = "seedance-2.0") -> AIModel:
    b = next(x for x in model_hub.BUILTINS if x["id"] == f"byteplus:{key}")
    return AIModel(id=b["id"], provider="byteplus", endpoint=b["endpoint"], task="video", display_name=b["display_name"],
                   capabilities=b["capabilities"], price_usd=b["price_usd"], price_unit="second", builtin=True)


def _ark_with(tmp_path: Path, seconds: float, bodies: list[dict]):
    clip = tmp_path / "out_src.mp4"
    mock.video_from(None, "seedance", clip, seconds, "9:16")
    video = clip.read_bytes()

    def handle(req: httpx.Request) -> httpx.Response:
        if req.url.host == "cdn.example":
            return httpx.Response(200, content=video)
        if req.method == "POST":
            bodies.append(json.loads(req.content))
            return httpx.Response(200, json={"id": "t9"})
        return httpx.Response(200, json={"id": "t9", "status": "succeeded", "content": {"video_url": "https://cdn.example/v.mp4"},
                                         "usage": {"completion_tokens": 50_000}})

    return byteplus.ArkClient("ark-key", http=httpx.Client(transport=httpx.MockTransport(handle)))


def test_seedance_speaks_the_recorded_line(tmp_path, monkeypatch):
    bodies: list[dict] = []
    ark = _ark_with(tmp_path, 6, bodies)
    monkeypatch.setattr(byteplus.time, "sleep", lambda s: None)
    svc = services_mod.Services()
    monkeypatch.setattr(svc, "ark", lambda: ark)
    frame = tmp_path / "kf.png"
    frame.write_bytes(mock.image("kf", "9:16", "kf"))
    voice = tmp_path / "line.wav"
    mock.tts("I saw him again last night by the lamp.", "v", voice)
    req = GenRequest(mode="a2v", prompt="Asha speaks", first_frame=frame, audio=voice, aspect="9:16", generate_audio=False)
    res = svc._seedance(_bp(), req, 5.3, None, None, None)
    body = bodies[0]
    roles = [c.get("role") for c in body["content"]]
    assert roles == [None, "reference_image", "reference_audio"] and body["duration"] == 6  # long enough for the line
    assert body["content"][2]["audio_url"]["url"].startswith("data:audio/wav;base64,")
    assert "[Audio 1]" in body["content"][0]["text"] and body["ratio"] == "9:16"
    out = tmp_path / "spoken.mp4"
    out.write_bytes(res.data)
    assert ff.has_audio(out) and res.usage.usd == pytest.approx(50_000 * 7.0 / 1e6)


def test_seedance_extends_a_clip(tmp_path, monkeypatch):
    bodies: list[dict] = []
    ark = _ark_with(tmp_path, 3, bodies)
    monkeypatch.setattr(byteplus.time, "sleep", lambda s: None)
    monkeypatch.setattr("app.providers.links.media_link",
                        lambda path, data_uri_ok=True, provider="": f"https://bucket.example/{Path(path).name}")
    svc = services_mod.Services()
    monkeypatch.setattr(svc, "ark", lambda: ark)
    src = tmp_path / "shot.mp4"
    mock.video_from(None, "the shot", src, 8, "9:16")
    res = svc._seedance(_bp(), GenRequest(mode="extend", prompt="he keeps walking", video=src, aspect="9:16", duration=7),
                        7, None, None, None)
    ref = bodies[0]["content"][1]
    assert ref["role"] == "reference_video" and ref["video_url"]["url"].startswith("https://bucket.example/")
    assert bodies[0]["content"][0]["text"].startswith("Extend [Video 1]")
    assert res.duration_s == pytest.approx(11, abs=0.6)  # the 8 s shot plus the 3 s continuation


# ── blocked-shot recovery and drafts (API, mock engines) ─────────────────────

def _shot(c) -> tuple[int, int]:
    p = ok(c.post("/api/projects", headers=H, json={"concept": "A temple lamp", "type": "short", "languages": ["en"]}))
    eid = p["episodes"][0]["id"]
    s = ok(c.post(f"/api/episodes/{eid}/shots", headers=H, json={"action": "Asha lights the lamp", "duration_s": 8}))
    return p["id"], s["id"]


def test_blocked_shot_recovery_and_draft(client):
    c = client
    pid, sid = _shot(c)
    with SessionLocal() as db:
        db.add(Job(type="video", status="failed", project_id=pid, shot_id=sid, label="Video",
                   error="Blocked by safety filter: Veo: the image may show a celebrity",
                   result={"blocked_engines": ["google:video_balanced"]}))
        db.commit()
    shot = ok(c.get(f"/api/shots/{sid}"))
    assert shot["blocked"]["engines"] == ["google:video_balanced"] and "celebrity" in shot["blocked"]["error"]
    alt = ok(c.get(f"/api/shots/{sid}/alternatives?purpose=recover"))
    ids = [o["id"] for o in alt["options"]]
    assert ids and "google:video_balanced" not in ids
    assert all(model_hub.route_key_of(i.split(":", 1)[1]) != "veo-3.1-fast" for i in ids)  # not the same model elsewhere
    out = ok(c.post(f"/api/shots/{sid}/recover", headers=H, json={}))
    assert out["jobs"][0]["payload"]["engine"] == ids[0] and out["jobs"][0]["payload"]["skip_engines"] == ["google:video_balanced"]
    wait_jobs(c, pid, timeout=120)
    shot = ok(c.get(f"/api/shots/{sid}"))
    assert shot["blocked"] is None and shot["video"]["params"]["recovered_from"] == ["google:video_balanced"]
    final_id = shot["video"]["id"]
    # a 480p draft: made, kept in the takes, but it doesn't push aside the finished clip and isn't "real" work
    drafts = ok(c.get(f"/api/shots/{sid}/alternatives?purpose=draft"))["options"]
    assert drafts and all(o["resolution"] == "480p" for o in drafts)
    ok(c.post(f"/api/shots/{sid}/draft", headers=H, json={}))
    wait_jobs(c, pid, timeout=120)
    assert ok(c.get(f"/api/shots/{sid}"))["video"]["id"] == final_id
    with SessionLocal() as db:
        d = db.query(Take).filter(Take.shot_id == sid, Take.kind == "video").order_by(Take.id.desc()).first()
        assert d.params["draft"] is True and d.params["resolution"] == "480p" and not is_real(d)


# ── Seedance-ready characters ────────────────────────────────────────────────

def _character(c, name: str, *, photo: bool = False, approved: bool = False) -> tuple[int, int]:
    ch = ok(c.post("/api/characters", headers=H, json={"name": name}))
    st = get_storage()
    with SessionLocal() as db:
        if photo:
            db.add(CharacterAsset(character_id=ch["id"], kind="source", approved=True,
                                  path=st.save_bytes(f"characters/{name}_src.png", mock.image(name, "3:4", "photo"))))
        a = CharacterAsset(character_id=ch["id"], kind="front", approved=approved,
                           path=st.save_bytes(f"characters/{name}_front.png", mock.image(name, "3:4", "front")))
        db.add(a)
        db.commit()
        return ch["id"], a.id


def _register_jobs(cid: int) -> list[Job]:
    with SessionLocal() as db:
        return [j for j in db.query(Job).filter(Job.type == "byteplus_register").all()
                if (j.payload or {}).get("character_id") == cid]


def test_auto_registration_refresh_and_remove(client):
    c = client
    cid, aid = _character(c, "Auto Asha")
    ok(c.patch(f"/api/character-assets/{aid}", headers=H, json={"approved": True}))
    assert not _register_jobs(cid)  # off by default
    assert "off" in ok(c.get(f"/api/characters/{cid}"))["byteplus_auto"]
    _setting("byteplus_auto_register", True)
    try:
        ok(c.patch(f"/api/character-assets/{aid}", headers=H, json={"approved": True}))
        assert len(_register_jobs(cid)) == 1
        wait_jobs(c, None, timeout=60)
        ch = ok(c.get(f"/api/characters/{cid}"))
        assert ch["seedance_ready"] is True and ch["byteplus_auto"] == "Already registered"
        # a character made from someone's photo is never registered by itself
        pid_, paid = _character(c, "Photo Person", photo=True)
        ok(c.patch(f"/api/character-assets/{paid}", headers=H, json={"approved": True}))
        assert not _register_jobs(pid_) and "photo" in ok(c.get(f"/api/characters/{pid_}"))["byteplus_auto"]
        # locking an AI character registers it too
        lid, _ = _character(c, "Locked Lila", approved=True)
        ok(c.post(f"/api/characters/{lid}/lock", headers=H, json={"locked": True}))
        assert len(_register_jobs(lid)) == 1
        wait_jobs(c, None, timeout=60)
    finally:
        _reset("byteplus_auto_register")
    reg = ok(c.post(f"/api/characters/{cid}/byteplus/refresh", headers=H))
    assert reg["status"] == "ready" and reg["checked_at"]
    assert ok(c.delete(f"/api/characters/{cid}/byteplus", headers=H))["removed"] == 1
    ch = ok(c.get(f"/api/characters/{cid}"))
    assert ch["seedance_ready"] is False and not (ch.get("provider_assets") or {}).get("byteplus")


# ── one card per model ───────────────────────────────────────────────────────

def test_one_card_per_model_and_route_keys(client):
    c = client
    with SessionLocal() as db:
        for mid, prov, ep in (("openrouter:bytedance/seedance-2.0", "openrouter", "bytedance/seedance-2.0"),
                              ("fal:bytedance/seedance-2.0/image-to-video", "fal", "bytedance/seedance-2.0/image-to-video")):
            row = db.get(AIModel, mid) or AIModel(id=mid, provider=prov, endpoint=ep)
            row.task, row.status, row.display_name = "video", "enabled", f"Seedance 2.0 ({prov})"
            row.capabilities = {"modes": ["i2v", "t2v"]}
            row.param_overrides = {}
            db.merge(row)
        db.commit()
    cards = ok(c.get("/api/models?group=true&q=seedance&task=video&limit=50"))
    assert cards["grouped"] is True
    seed = [m for m in cards["models"] if m["route_key"] == "seedance-2"]
    assert len(seed) == 1 and {r["provider"] for r in seed[0]["routes"]} == {"byteplus", "openrouter", "fal"}
    assert seed[0]["routes_on"] == 3
    exact = ok(c.get("/api/models?group=true&route_key=seedance-2&task=video"))["models"]
    assert len(exact) == 1 and len(exact[0]["routes"]) == 3  # the model page asks for exactly its routes
    # an admin moves one route to another model, then back
    url = "/api/models/openrouter:bytedance/seedance-2.0"
    assert ok(c.patch(url, headers=H, json={"route_key": "seedance-2.5"}))["route_key"] == "seedance-2.5"
    assert ok(c.patch(url, headers=H, json={"route_key": None}))["route_key"] == "seedance-2"
    assert ok(c.patch(url, headers=H, json={"route_key": ""}))["route_key"] == ""  # never merged
    assert c.patch(url, headers=H, json={"route_key": "Not A Key!"}).status_code == 400
    ok(c.patch(url, headers=H, json={"route_key": None, "status": "disabled"}))
    with SessionLocal() as db:
        db.get(AIModel, "fal:bytedance/seedance-2.0/image-to-video").status = "disabled"
        db.commit()
