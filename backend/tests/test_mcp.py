"""MCP server (mock providers): tokens and scopes, the /mcp endpoint over HTTP, OAuth sign-in for MCP clients, and the
whole pipeline driven through MCP tools — import → critique / improve → scenes → storyboard → videos scene by scene
with continuity carried forward (end states, linked shots start from the real last frame of the clip before)."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
from typing import Any
from urllib.parse import parse_qs, urlparse

import anyio
from fastapi.testclient import TestClient
from mcp import Client

from app.db import SessionLocal
from app.mcp_server.server import build
from app.models import Shot
from app.pipeline.selection import current
from conftest import H, ok, wait_jobs

SCRIPT = """SCENE 1 - INT. TEMPLE COURTYARD - DUSK
VISUAL: Rows of brass lamps on worn stone. Ravi walks in carrying an oil lamp.
RAVI: I saw the lamp move again.
MEERA: Then it was not a dream.
VISUAL: Ravi sets the lamp down on the steps.
MEERA: Leave it there. Watch.
SCENE 2 - INT. TEMPLE COURTYARD - DUSK
VISUAL: The lamp slides across the stone by itself. Ravi steps back.
RAVI: Who is moving it?
"""

ACCEPT = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


def _token(c: TestClient, scopes: list[str], name: str = "test") -> str:
    out = ok(c.post("/api/mcp/tokens", headers=H, json={"name": name, "scopes": scopes}))
    assert out["token"].startswith("tvm_") and set(out["scopes"]) == set(scopes) | {"read"}
    return out["token"]


def _rpc(c: TestClient, token: str | None, method: str, params: dict | None = None, rid: int = 1):
    headers = {**ACCEPT, **({"Authorization": f"Bearer {token}"} if token else {})}
    r = c.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
    return r


def _sse_json(text: str) -> dict:
    datas = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
    return json.loads(datas[-1]) if datas else json.loads(text)


class Mcp:
    """Calls tools on an in-process server as the token's user (the stdio way: TATVAM_TOKEN)."""

    def __init__(self, token: str):
        self.token = token
        self.server = build(with_auth=False)

    def read(self, uri: str) -> str:
        async def run():
            async with Client(self.server) as cl:
                return await cl.read_resource(uri)

        return self._as_user(run).contents[0].text

    def _as_user(self, run):
        old = os.environ.get("TATVAM_TOKEN")
        os.environ["TATVAM_TOKEN"] = self.token
        try:
            return anyio.run(run)
        finally:
            if old is None:
                os.environ.pop("TATVAM_TOKEN", None)
            else:
                os.environ["TATVAM_TOKEN"] = old

    def call(self, name: str, args: dict | None = None, *, error: bool = False) -> Any:
        async def run():
            async with Client(self.server) as cl:
                return await cl.call_tool(name, args or {})

        res = self._as_user(run)
        if error:
            assert res.is_error, f"{name} should have failed: {res.content}"
            return res.content[0].text
        assert not res.is_error, f"{name} failed: {res.content[0].text if res.content else res}"
        first = json.loads(res.content[0].text)
        return (first, res.content[1:]) if len(res.content) > 1 else first


# ── tokens & HTTP ────────────────────────────────────────────────────────────

def test_tokens_and_http_endpoint(client: TestClient):
    c = client
    info = ok(c.get("/api/mcp/info"))
    assert info["url"].endswith("/mcp") and "generate_scenes" in info["tools"] and len(info["tools"]) >= 45
    # no token: the endpoint refuses and points at the OAuth metadata
    r = _rpc(c, None, "initialize")
    assert r.status_code == 401 and "resource_metadata" in r.headers.get("www-authenticate", "")
    tok = _token(c, ["read"])
    init = _sse_json(_rpc(c, tok, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                                  "clientInfo": {"name": "pytest", "version": "1"}}).text)
    assert init["result"]["serverInfo"]["name"] == "tatvam" and "generate_scenes" in init["result"]["instructions"]
    tools = _sse_json(_rpc(c, tok, "tools/list", rid=2).text)["result"]["tools"]
    names = {t["name"] for t in tools}
    assert {"import_script", "improve_script", "plan_scenes", "get_storyboard", "generate_scenes", "approve_spend"} <= names
    paid = next(t for t in tools if t["name"] == "generate_scenes")
    assert paid["annotations"]["openWorldHint"] is True and "run_now" in paid["inputSchema"]["properties"]
    # a read-only token can look but not change anything
    res = _sse_json(_rpc(c, tok, "tools/call", {"name": "list_projects", "arguments": {}}, rid=3).text)["result"]
    assert not res.get("isError")
    res = _sse_json(_rpc(c, tok, "tools/call", {"name": "create_project", "arguments": {"concept": "x y z"}}, rid=4).text)["result"]
    assert res["isError"] and "'write' scope" in res["content"][0]["text"]
    # revoked tokens stop working at once
    row = next(t for t in ok(c.get("/api/mcp/tokens")) if t["prefix"] == tok[:10])
    ok(c.post(f"/api/mcp/tokens/{row['id']}/revoke", headers=H))
    assert _rpc(c, tok, "tools/list").status_code == 401


def test_signed_media_links(client: TestClient):
    from app.mcp_server.media import check_link, signed_link
    link = signed_link("projects/1/x.mp4")
    sig = parse_qs(urlparse(link).query)["sig"][0]
    assert check_link("projects/1/x.mp4", sig) and not check_link("projects/1/y.mp4", sig)
    anon = TestClient(client.app)  # no cookie
    assert anon.get("/media/projects/1/x.mp4").status_code == 401
    assert anon.get(f"/media/projects/1/x.mp4?sig={sig}").status_code == 404  # signature accepted; the file just isn't there


# ── OAuth (claude.ai custom connector) ───────────────────────────────────────

def test_oauth_sign_in_for_mcp_clients(client: TestClient):
    c = client
    meta = ok(c.get("/.well-known/oauth-authorization-server"))
    assert meta["authorization_endpoint"].endswith("/authorize") and "S256" in meta["code_challenge_methods_supported"]
    reg = c.post("/register", json={"redirect_uris": ["http://localhost:6274/callback"], "client_name": "Test client",
                                    "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"],
                                    "response_types": ["code"], "scope": "read write"})
    assert reg.status_code == 201, reg.text
    cid = reg.json()["client_id"]
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    r = c.get("/authorize", params={"response_type": "code", "client_id": cid, "redirect_uri": "http://localhost:6274/callback",
                                    "code_challenge": challenge, "code_challenge_method": "S256", "state": "st8",
                                    "scope": "read write"}, follow_redirects=False)
    assert r.status_code in (302, 307), r.text
    consent = urlparse(r.headers["location"])
    assert consent.path == "/oauth/consent"
    rid = parse_qs(consent.query)["request"][0]
    view = ok(c.get(f"/api/oauth/requests/{rid}"))
    assert view["client"] == "Test client" and view["scopes"] == ["read", "write"] and view["status"] == "pending"
    back = urlparse(ok(c.post(f"/api/oauth/requests/{rid}/decide", headers=H, json={"approve": True}))["redirect"])
    q = parse_qs(back.query)
    assert q["state"] == ["st8"] and back.netloc == "localhost:6274"
    tok = c.post("/token", data={"grant_type": "authorization_code", "code": q["code"][0], "client_id": cid,
                                 "redirect_uri": "http://localhost:6274/callback", "code_verifier": verifier})
    assert tok.status_code == 200, tok.text
    t = tok.json()
    assert t["access_token"].startswith("tvm_") and t["refresh_token"] and t["scope"] == "read write"
    assert _rpc(c, t["access_token"], "tools/list").status_code == 200
    # the code works once
    again = c.post("/token", data={"grant_type": "authorization_code", "code": q["code"][0], "client_id": cid,
                                   "redirect_uri": "http://localhost:6274/callback", "code_verifier": verifier})
    assert again.status_code == 400
    # refresh rotates: the new pair works, the old access token stops
    ref = c.post("/token", data={"grant_type": "refresh_token", "refresh_token": t["refresh_token"], "client_id": cid})
    assert ref.status_code == 200, ref.text
    assert _rpc(c, t["access_token"], "tools/list").status_code == 401
    assert _rpc(c, ref.json()["access_token"], "tools/list").status_code == 200
    # it shows on the Settings page and can be revoked there
    rows = [x for x in ok(c.get("/api/mcp/tokens")) if x["kind"] == "oauth_access" and x["client_id"] == cid]
    assert len(rows) == 1
    ok(c.post(f"/api/mcp/tokens/{rows[0]['id']}/revoke", headers=H))
    assert _rpc(c, ref.json()["access_token"], "tools/list").status_code == 401


# ── the pipeline through MCP ─────────────────────────────────────────────────

def test_script_to_scenes_with_continuity(client: TestClient):
    c = client
    m = Mcp(_token(c, ["read", "write", "spend"], "pipeline"))
    made = m.call("create_project", {"concept": "A temple lamp that moves by itself", "type": "short", "workflow": "script"})
    pid = made["project_id"]

    # script in, reviewed and improved
    imp = m.call("import_script", {"project_id": pid, "text": SCRIPT, "method": "markers"})
    assert imp["scenes"] == 2 and {"Ravi", "Meera"} <= set(imp["characters"])
    sc = m.call("get_script", {"project_id": pid})
    assert len(sc["script"]["scenes"]) == 2 and "@[" not in json.dumps(sc["script"])
    crit = m.call("critique_script", {"project_id": pid})
    assert "overall" in crit and crit["rewrite_instructions"]
    better = m.call("improve_script", {"project_id": pid, "notes": "Make Meera braver."})
    assert better["score_before"] is not None and len(better["versions"]) >= 2
    script = m.call("get_script", {"project_id": pid})["script"]
    script["scenes"][0]["lines"][0]["line"] = "The lamp moved again, I swear it."
    saved = m.call("save_script", {"project_id": pid, "script": script, "note": "tightened line 1"})
    assert saved["saved"] and saved["scenes"] == len(script["scenes"])

    # scenes, cast, shots (replacing work asks first)
    cards = m.call("plan_scenes", {"project_id": pid})
    cards = (cards if "scenes" in cards else m.call("plan_scenes", {"project_id": pid, "confirm": True}))["scenes"]
    assert len(cards) >= 2 and all("goal" in x for x in cards)
    m.call("update_scene", {"project_id": pid, "scene": 1, "changes": {"wardrobe": {"Ravi": "white dhoti"}, "approved": True}})
    assert m.call("list_scenes", {"project_id": pid})["scenes"][0]["wardrobe"] == {"Ravi": "white dhoti"}
    ask = m.call("breakdown_shots", {"project_id": pid})
    assert ask["status"] == "needs_confirmation"
    plan = m.call("breakdown_shots", {"project_id": pid, "confirm": True})
    assert len(plan["shots"]) >= 3
    board = m.call("get_storyboard", {"project_id": pid, "images": False})
    rows = board["storyboard"] if isinstance(board, dict) else board[0]["storyboard"]
    assert rows and {"code", "action", "continues_from", "keyframe"} <= set(rows[0])

    # storyboard pictures: a proposal first, nothing spent until approved
    kf = m.call("generate_keyframes", {"project_id": pid})
    assert kf["status"] == "proposed" and "approve_spend" in kf["next"]
    assert any(b["batch_id"] == kf["batch_id"] for b in m.call("list_pending", {"project_id": pid})["proposals"])
    m.call("approve_spend", {"project_id": pid, "batch_id": kf["batch_id"]})
    wait_jobs(c, pid)
    first, extra = m.call("get_storyboard", {"project_id": pid, "max_images": 2})
    assert first["with_keyframe"] == first["shots"] and any(getattr(x, "type", "") == "image" for x in extra)

    # the shot list links shots inside a scene; keyframes made before any video can't start from a real last frame
    with SessionLocal() as db:
        linked = [s for s in db.query(Shot).filter(Shot.episode_id == _episode_id(db, pid), Shot.include.is_(True))
                  .order_by(Shot.order).all() if s.continuity_from_prev]
        assert linked, "breakdown should link consecutive shots of a scene"
    links = m.call("get_continuity", {"project_id": pid})["links"]
    assert links and {l["status"] for l in links} <= {"waiting", "pending"}

    # videos scene by scene: plan, propose, approve
    sp = m.call("generate_scenes", {"project_id": pid, "plan_only": True})
    assert sp["submitted"] is False and [x["scene"] for x in sp["scenes"]][:2] == [1, 2] and sp["shots_to_make"] >= 3
    assert any(i["new_keyframe"] for x in sp["scenes"] for i in x["to_make"])  # linked storyboard frames get remade
    run = m.call("generate_scenes", {"project_id": pid})
    assert run["submitted"] and run["status"] == "proposed"
    m.call("approve_spend", {"project_id": pid, "batch_id": run["batch_id"]})
    wait_jobs(c, pid, timeout=400)
    st = m.call("job_status", {"project_id": pid, "batch_id": run["batch_id"]})
    chain = next(j for j in st["jobs"] if j["type"] == "scene_chain")
    assert chain["status"] == "succeeded" and [s["scene"] for s in chain["scenes"]][:2] == [1, 2]

    # continuity carried forward: every scene has its end state, every linked shot starts from its source's last frame
    cont = m.call("get_continuity", {"project_id": pid})
    assert all(s["end_state"] for s in cont["scenes"])
    assert cont["broken_links"] == [] and all(l["status"] == "ok" for l in cont["links"])
    with SessionLocal() as db:
        for s in db.query(Shot).filter(Shot.episode_id == _episode_id(db, pid), Shot.include.is_(True)).all():
            src = db.get(Shot, s.continuity_from_shot_id) if s.continuity_from_shot_id else None
            if s.continuity_from_prev and not src:
                src = (db.query(Shot).filter(Shot.episode_id == s.episode_id, Shot.include.is_(True), Shot.order < s.order)
                       .order_by(Shot.order.desc()).first())
            if src is not None and s.continuity_mode != "extend":
                assert current(db, s.id, "keyframe").params["continuity_take_id"] == current(db, src.id, "video").id, s.code
    bible = m.read(f"tatvam://projects/{pid}/continuity")
    assert "## Scene 1" in bible and "- end:" in bible
    assert "The lamp moved again, I swear it." in m.read(f"tatvam://projects/{pid}/screenplay")
    shot, img = m.call("get_shot", {"project_id": pid, "shot_code": "E01-SH02"})
    assert shot["video_link"].startswith("http") and "sig=" in shot["video_link"] and shot["prompt"]

    # running it again makes nothing new
    again = m.call("generate_scenes", {"project_id": pid})
    assert again["submitted"] is False and again["shots_to_make"] == 0


def test_money_needs_the_spend_scope(client: TestClient):
    c = client
    writer = Mcp(_token(c, ["read", "write"], "writer"))
    pid = writer.call("create_project", {"concept": "Two friends race kites on a windy beach", "workflow": "script"})["project_id"]
    writer.call("import_script", {"project_id": pid, "text": SCRIPT, "method": "markers"})
    prop = writer.call("generate_keyframes", {"project_id": pid})
    assert prop["status"] == "proposed"
    assert "'spend' scope" in writer.call("approve_spend", {"project_id": pid, "batch_id": prop["batch_id"]}, error=True)
    assert "'spend' scope" in writer.call("generate_keyframes", {"project_id": pid, "run_now": True}, error=True)
    # a token limited to one project can't see the others
    limited = ok(c.post("/api/mcp/tokens", headers=H, json={"name": "one", "scopes": ["read"], "project_ids": [pid]}))["token"]
    one = Mcp(limited)
    assert [p["id"] for p in one.call("list_projects")["projects"]] == [pid]
    assert "No project" in one.call("get_project", {"project_id": pid + 100000}, error=True)
    ok(c.post(f"/api/batches/{prop['batch_id']}/cancel", headers=H))


def _episode_id(db, pid: int) -> int:
    from app.models import Episode
    return db.query(Episode).filter(Episode.project_id == pid).order_by(Episode.number).first().id
