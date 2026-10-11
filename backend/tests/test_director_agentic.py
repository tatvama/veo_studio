"""The agentic Director (mock providers, no network): read tools, writers' room tools, the plan, project memory,
look_at_shot pictures, live progress and data["steps"], web search, the task budget and the step limit. Claude is a
fake client (test_director_claude.py) and Gemini a fake service; nothing here calls a paid API."""
from __future__ import annotations

import base64
import copy
import io
import json

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import inspect, text as sql

from app import settings_store
from app.agents import director, prompts
from app.agents import director_claude as DC
from app.agents import tools as T
from app.db import SessionLocal, engine, is_sqlite
from app.db_migrate import migrate
from app.models import AgentMessage, Episode, Event, Project, Revision, Shot, Take, User
from app.pipeline import ffmpeg as ff
from app.storage import get_storage
from conftest import H, ok
from test_director_claude import THINK, chat, claude, msg, project, segments, text, tool  # noqa: F401  (claude: fixture)


def _ctx(db, pid: int, eid: int, **kw) -> T.AgentCtx:
    user = db.query(User).filter(User.email == "admin@test.local").first()
    return T.AgentCtx(db=db, user=user, project=db.get(Project, pid), episode=db.get(Episode, eid), **kw)


def _scripted(c: TestClient, concept: str, languages: list[str] | None = None) -> tuple[int, int]:
    """A project with hooks, a script and a shot list (all from the mock writer)."""
    p = ok(c.post("/api/projects", headers=H, json={"concept": concept, "type": "short", "languages": languages or ["en"]}))
    pid, eid = p["id"], p["episodes"][0]["id"]
    ok(c.post(f"/api/episodes/{eid}/hooks/generate", headers=H, json={"n": 2}))
    ok(c.post(f"/api/episodes/{eid}/hooks/select", headers=H, json={"index": 0}))
    ok(c.post(f"/api/episodes/{eid}/script/generate", headers=H, json={}))
    ok(c.post(f"/api/episodes/{eid}/shots/breakdown", headers=H))
    return pid, eid


def test_read_tools_and_writers_room(client: TestClient):
    pid, eid = _scripted(client, "A lamp that remembers every prayer", ["en", "hi"])
    with SessionLocal() as db:
        c = _ctx(db, pid, eid)
        code = c.shots()[0].code

        sc = T.run_tool(c, "read_script", {})
        assert sc["scenes_total"] >= 1 and sc["hook"] and sc["scenes"][0]["lines"]
        one = T.run_tool(c, "read_script", {"scene": 1})
        assert [s["scene"] for s in one["scenes"]] == [1]
        assert "error" in T.run_tool(c, "read_script", {"scene": 99})

        shot = T.run_tool(c, "read_shot", {"shot_code": code.lower()})
        assert shot["code"] == code and set(shot["takes"]) == {"keyframe", "video"} and shot["quality"] == "saver"
        assert "error" in T.run_tool(c, "read_shot", {"shot_code": "E09-SH99"})
        bible = T.run_tool(c, "read_bible", {})
        assert {"cast", "locations", "style"} <= set(bible) and bible["cast"]  # breakdown linked the speakers

        crit = T.run_tool(c, "critique_script", {})
        assert crit["overall"] > 0 and crit["problems"] and db.get(Episode, eid).critic["overall"] == crit["overall"]
        cont = T.run_tool(c, "check_continuity", {})
        assert cont["issues_total"] == 1 and cont["issues"][0]["where"]

        cards = T.run_tool(c, "plan_scene_cards", {})  # the first plan replaces nothing, so it just runs
        assert cards["scenes"] and cards["scenes"][0]["goal"] and not c.confirmations
        again = T.run_tool(c, "plan_scene_cards", {})  # now the cards would be rewritten: ask first
        assert again["status"] == "waiting_for_user_confirmation" and c.confirmations[-1]["tool"] == "plan_scene_cards"
        assert [a.split(" (")[0] for a in c.actions] == ["script reviewed", "continuity checked", f"{len(cards['scenes'])} scene cards planned"]
        item = c.confirmations[-1]
        card_id = director._save(db, c.project, None, "assistant", "Confirm below.", {"confirmations": [item]}).id
    done = ok(client.post(f"/api/projects/{pid}/agent/messages/{card_id}/confirm", headers=H,
                          json={"id": item["id"], "approve": True}))
    assert done["status"] == "done" and done["result"].startswith("Scene cards re-planned:")
    with SessionLocal() as db:
        c = _ctx(db, pid, eid)

        # translation: new lines go in, existing ones are kept; redoing them asks first
        hi = T.run_tool(c, "localize_script", {"language": "Hindi"})
        assert hi["lines_translated"] > 0 and hi["language"] == "hi"
        assert T.run_tool(c, "localize_script", {"language": "hi"})["lines_translated"] == 0
        redo = T.run_tool(c, "localize_script", {"language": "hi", "overwrite": True})
        assert redo["status"] == "waiting_for_user_confirmation" and "Hindi" in redo["what"]
        assert "error" in T.run_tool(c, "localize_script", {"language": "en"})
        assert "error" in T.run_tool(c, "localize_script", {"language": "klingon"})
        yes = _ctx(db, pid, eid, confirmed=True)
        assert T.run_tool(yes, "localize_script", {"language": "hi", "overwrite": True})["lines_translated"] > 0

        revs = db.query(Revision).filter(Revision.entity_type == "shot").count()
        pol = T.run_tool(c, "polish_dialogue", {"language": "hi"})
        assert pol["lines_polished"] > 0 and db.query(Revision).filter(Revision.entity_type == "shot").count() > revs

        mk = T.run_tool(c, "marketing_copy", {"platforms": ["youtube_shorts", "nope"], "languages": ["hi"]})
        assert mk["copies"] and mk["thumbnails"][0]["overlay_text"]
        assert T.run_tool(c, "marketing_copy", {})["status"] == "waiting_for_user_confirmation"
        assert len(c.actions) == 3 and c.actions[0].endswith("lines translated into Hindi")


def test_plan_memory_and_turn_context(client: TestClient):
    pid, eid = project(client, "A boatman who ferries ghosts")
    with SessionLocal() as db:
        c = _ctx(db, pid, eid)
        out = T.run_tool(c, "update_plan", {"steps": [{"text": "Write the script", "status": "done"},
                                                      {"text": "Check it", "status": "doing"}, "Plan shots",
                                                      {"text": "", "status": "todo"}, {"text": "x", "status": "weird"}]})
        assert out == {"ok": True, "steps": 4, "done": 1}
        assert c.plan[2] == {"text": "Plan shots", "status": "todo"} and c.plan[3]["status"] == "todo"

        assert T.run_tool(c, "remember", {"note": "  No on-screen   text in keyframes "})["index"] == 1
        assert "Already" in T.run_tool(c, "remember", {"note": "no on-screen text in keyframes"})["message"]
        T.run_tool(c, "remember", {"note": "x" * 500})
        notes = db.get(Project, pid).agent_memory
        assert notes[0]["text"] == "No on-screen text in keyframes" and notes[0]["by"] and notes[0]["at"].endswith("Z")
        assert len(notes[1]["text"]) == T.MEMORY_CHARS
        assert "error" in T.run_tool(c, "remember", {"note": "   "})
        assert T.run_tool(c, "forget", {"index": 2})["notes"] == 1
        assert "error" in T.run_tool(c, "forget", {"index": 5})
        for i in range(T.MEMORY_MAX - 1):
            T.run_tool(c, "remember", {"note": f"note {i}"})
        assert "full" in T.run_tool(c, "remember", {"note": "one too many"})["error"]
        assert len(db.get(Project, pid).agent_memory) == T.MEMORY_MAX

        # the notes reach the turn's context text (the system prompt stays byte-stable for caching)
        turn = DC._turn(c, "hello", {}, [])
        ctx = turn["content"][0]["text"]
        assert "Project memory (notes you saved earlier" in ctx and "1. No on-screen text in keyframes" in ctx
        assert "Project memory" not in prompts.DIRECTOR_AGENT
        db.get(Project, pid).agent_memory = []
        db.commit()
        assert T.memory_text(db.get(Project, pid)) == ""


def _jpeg_size(data: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(data)) as im:
        assert im.format == "JPEG"
        return im.size


def _with_takes(client: TestClient) -> tuple[int, int, str, str]:
    """A project with two shots: the first has a big keyframe and a 2-second video; the second has nothing yet."""
    pid, eid = project(client, "A kite that carries letters")
    a = ok(client.post(f"/api/episodes/{eid}/shots", headers=H, json={"action": "Kite rises over rooftops", "framing": "wide"}))
    ok(client.post(f"/api/episodes/{eid}/shots", headers=H, json={"action": "A girl reads the letter", "framing": "close-up"}))
    st = get_storage()
    buf = io.BytesIO()
    Image.new("RGB", (1920, 1080), (200, 120, 40)).save(buf, "PNG")
    kf_rel = st.save_bytes(st.new_path(f"projects/{pid}/test", ".png"), buf.getvalue())
    tmp = st.tmp_dir()
    video = tmp / "clip.mp4"
    ff.run(["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=24", "-t", "2", "-pix_fmt", "yuv420p", video])
    vid_rel = st.save_file(st.new_path(f"projects/{pid}/test", ".mp4"), video)
    with SessionLocal() as db:
        db.add(Take(shot_id=a["id"], kind="keyframe", path=kf_rel, selected=True,
                    qc={"passed": False, "score": 0.4, "notes": "Kite is the wrong colour", "fix": ["kite must be red"],
                        "hand_issues": True}))
        db.add(Take(shot_id=a["id"], kind="video", path=vid_rel, selected=True, qc={"passed": True, "identity_match": 0.9}))
        db.commit()
        codes = [s.code for s in db.query(Shot).filter(Shot.episode_id == eid).order_by(Shot.order)]
    return pid, eid, codes[0], codes[1]


def test_look_at_shot_pictures(client: TestClient):
    pid, eid, code, empty = _with_takes(client)
    with SessionLocal() as db:
        c = _ctx(db, pid, eid)
        out = T.run_tool(c, "look_at_shot", {"shot_code": code})
        imgs = out["_images"]
        assert len(imgs) == 4 and len(imgs) <= T.LOOK_MAX  # the keyframe + 3 video frames
        assert imgs[0][0].startswith(f"{code} keyframe") and "frame 3 of 3" in imgs[3][0]
        assert all(max(_jpeg_size(data)) <= T.LOOK_EDGE for _, data in imgs)
        assert _jpeg_size(imgs[0][1]) == (768, 432) and all(len(data) < 120_000 for _, data in imgs)
        assert out["keyframe"]["qc"]["notes"] == "Kite is the wrong colour" and out["keyframe"]["qc"]["fix"] == "kite must be red"
        assert out["keyframe"]["qc"]["flags"] == ["hand issues"] and out["video"]["qc"]["passed"] is True
        assert out["pictures"] == [label for label, _ in imgs]

        nothing = T.run_tool(c, "look_at_shot", {"shot_code": empty})
        assert nothing["_images"] == [] and "Nothing to look at" in nothing["message"]

        # Claude: the JSON as text, then each picture after its label, as base64 JPEG image blocks
        r = DC._result(c, {"id": "tu1", "name": "look_at_shot", "input": {"shot_code": code}})
        assert r["tool_use_id"] == "tu1" and "is_error" not in r and isinstance(r["content"], list)
        body = json.loads(r["content"][0]["text"])
        assert "_images" not in body and body["code"] == code
        blocks = r["content"][1:]
        assert [b["type"] for b in blocks] == ["text", "image"] * 4
        for b in blocks[1::2]:
            assert b["source"]["type"] == "base64" and b["source"]["media_type"] == "image/jpeg"
            assert max(_jpeg_size(base64.b64decode(b["source"]["data"]))) <= 768
        plain = DC._result(c, {"id": "tu2", "name": "read_shot", "input": {"shot_code": code}})
        assert isinstance(plain["content"], str)  # no pictures: the usual string result

        # engines that only take text: the pictures are dropped and counted
        js = T.for_json(T.run_tool(c, "look_at_shot", {"shot_code": code}))
        assert "_images" not in js and js["pictures_omitted"].startswith("4 picture(s)")
        json.dumps(js)
        assert T.for_json({"a": 1}) == {"a": 1}


class FakeGemini:
    def __init__(self, *script):
        self.script, self.calls = list(script), []

    def agent_step(self, model, system, input_, tools, prev):
        self.calls.append({"system": system, "input": copy.deepcopy(input_), "tools": tools})
        return self.script.pop(0)

    def usage(self, resp):
        return 10, 5

    def function_calls(self, resp):
        return resp.get("calls") or []

    def output_text(self, resp):
        return resp.get("text", "")


def test_gemini_loop_drops_pictures_and_gets_memory(client: TestClient, monkeypatch):
    pid, eid, code, _ = _with_takes(client)
    fake = FakeGemini({"id": "i1", "calls": [{"name": "look_at_shot", "arguments": {"shot_code": code}, "id": "c1"}]},
                      {"id": "i2", "text": "The kite should be red."})

    class FakeServices:
        models = {"text": "gemini-test"}

        def gemini(self):
            return fake

        def text_cost(self, model, tin, tout):
            return 0.0

    monkeypatch.setattr(director, "Services", FakeServices)
    with SessionLocal() as db:
        c = _ctx(db, pid, eid)
        T.run_tool(c, "remember", {"note": "Kites are always red"})
        assert director._live_agent(c, "how does the first shot look?", {}) == "The kite should be red."
        first, second = fake.calls
        assert "Project memory" in first["system"] and "1. Kites are always red" in first["system"]
        assert first["tools"] is T.TOOL_DECLS
        result = json.loads(second["input"][0]["result"][0]["text"])
        assert "_images" not in result and result["pictures_omitted"].startswith("4 picture(s)") and result["code"] == code
        assert [(s["tool"], s["ok"]) for s in c.steps] == [("look_at_shot", True)]


def _progress(pid: int) -> list[dict]:
    with SessionLocal() as db:
        return [e.payload | {"user_id": e.user_id} for e in
                db.query(Event).filter(Event.project_id == pid, Event.type == "agent.progress").order_by(Event.id)]


def _last_user_msg(pid: int) -> int:
    with SessionLocal() as db:
        return (db.query(AgentMessage.id).filter(AgentMessage.project_id == pid, AgentMessage.role == "user")
                .order_by(AgentMessage.id.desc()).limit(1).scalar())


SEARCH = [{"type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {"query": "Diwali kite traditions"}},
          {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_1",
           "content": [{"type": "web_search_result", "url": "https://example.org/kites", "title": "Kites",
                        "encrypted_content": "enc", "page_age": None}]}]


def test_claude_steps_progress_plan_and_search(client: TestClient, claude):  # noqa: F811
    pid, eid = project(client, "A kite festival in Ahmedabad")
    plan = [{"text": "Read the script", "status": "done"}, {"text": "Research the festival", "status": "doing"}]
    fake = claude(msg([THINK, tool("p1", "update_plan", {"steps": plan}), tool("r1", "read_script")], "tool_use"),
                  msg([THINK, *SEARCH, tool("l1", "look_at_shot", {"shot_code": "E01-SH99"})], "tool_use"),
                  msg([THINK, text("Here is the plan.")]))
    out = chat(client, pid, eid, "research the festival and plan it")
    assert out["content"] == "Here is the plan." and out["data"]["plan"] == plan
    assert out["data"]["steps"] == [
        {"tool": "read_script", "label": "Reading the script", "ok": True},
        {"tool": "web_search", "label": "Searching the web: Diwali kite traditions", "ok": True},
        {"tool": "look_at_shot", "label": "Looking at E01-SH99", "ok": False},  # no such shot: the tool said so
    ]
    # the search came back inside the assistant turn and is replayed unchanged
    assert fake.calls[2]["messages"][3]["content"][1:3] == SEARCH
    # live progress: tagged with the user's message, a line before each call and its outcome after
    turn = _last_user_msg(pid)
    ev = _progress(pid)
    assert ev and all(e["turn"] == turn and e["user_id"] for e in ev)
    assert ev[0] == {"turn": turn, "step": None, "plan": plan, "user_id": ev[0]["user_id"]}
    assert [(e["step"], e.get("ok")) for e in ev[1:]] == [(0, None), (0, True), (1, None), (1, True), (2, None), (2, False)]
    assert ev[1]["label"] == "Reading the script"

    # a failed web search (an error object instead of a result list) shows as a failed step
    bad = [SEARCH[0] | {"id": "srvtoolu_2"}, {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_2",
                                              "content": {"type": "web_search_tool_result_error", "error_code": "max_uses_exceeded"}}]
    claude(msg([THINK, *bad, text("Couldn't search.")]))
    out = chat(client, pid, eid, "search again")
    assert out["data"]["steps"] == [{"tool": "web_search", "label": "Searching the web: Diwali kite traditions", "ok": False}]
    assert "plan" not in out["data"]


def test_claude_step_limit_memory_model_and_fingerprint(client: TestClient, claude, monkeypatch):  # noqa: F811
    pid, eid = project(client, "A tailor who sews wishes")
    with SessionLocal() as db:
        db.get(Project, pid).agent_memory = [{"text": "Keep every reply under 80 words", "at": "2026-10-01T00:00:00Z", "by": "Admin"}]
        db.commit()

    monkeypatch.setattr(DC, "CLAUDE_MAX_STEPS", 3)
    fake = claude(*[msg([THINK, tool(f"g{i}", "get_project_state")], "tool_use") for i in range(3)])
    out = chat(client, pid, eid, "do everything")
    assert len(fake.calls) == 3 and "I stopped after 3 steps" in out["content"] and 'Say "continue"' in out["content"]
    assert [s["tool"] for s in out["data"]["steps"]] == ["get_project_state"] * 2  # the third call was not run
    seg = segments(pid)[-1]
    last = seg["messages"][-1]
    assert last["role"] == "user" and last["content"][0]["tool_use_id"] == "g2" and last["content"][0]["is_error"] is True
    assert "step limit" in last["content"][0]["content"]
    # project memory is in the turn's context, never in the system prompt
    first = fake.calls[0]
    assert first["system"] == prompts.DIRECTOR_AGENT
    assert "1. Keep every reply under 80 words" in first["messages"][-1]["content"][0]["text"]

    # the team's Director model choice (Settings): Opus instead of the default Sonnet; it starts its own thread
    ok(client.patch("/api/settings", headers=H, json={"director_claude_model": "claude-opus-5-5", "director_claude_effort": "high"}))
    try:
        fake = claude(msg([text("Hi from Opus.")]))
        chat(client, pid, eid, "hello")
        [call] = fake.calls
        assert call["model"] == "claude-opus-5-5" and call["output_config"]["effort"] == "high" and len(call["messages"]) == 1
        assert segments(pid)[-1]["model"] == "claude-opus-5-5"
    finally:
        ok(client.patch("/api/settings", headers=H, json={"director_claude_model": "", "director_claude_effort": "medium"}))
    assert settings_store.DEFAULTS["director_claude_model"] == ""

    # the fingerprint covers the tools (web search included): a different tool list can't continue a stored thread
    fp = DC.fingerprint("claude-sonnet-5-5")
    assert DC.fingerprint("claude-opus-5-5") != fp
    monkeypatch.setattr(DC, "TOOLS", [t for t in DC.TOOLS if t["name"] != "web_search"])
    assert DC.fingerprint("claude-sonnet-5-5") != fp
    monkeypatch.setattr(DC, "TOOLS", DC.TOOLS + [{"name": "extra", "description": "x", "input_schema": {"type": "object"}}])
    assert DC.fingerprint("claude-sonnet-5-5") != fp


def test_keyless_mock_reports_steps(client: TestClient):
    pid, eid = project(client, "A clock that runs backwards")
    out = chat(client, pid, eid, "how is it going?")  # no keys in tests: the keyword mock answers
    assert out["data"]["engine"] == "mock"
    assert out["data"]["steps"] == [{"tool": "get_project_state", "label": "Checking the project", "ok": True}]
    assert [(e["step"], e.get("ok")) for e in _progress(pid)] == [(0, None), (0, True)]


def test_opus_prices_and_agent_memory_column_upgrade(client: TestClient):
    prices = settings_store.prices()["text_per_million"]
    assert prices["claude-opus-5-5"] == {"in": 4.00, "out": 20.00, "cache_write": 5.00, "cache_read": 0.20}
    assert {"claude-haiku-5-5", "claude-fable-5-1"} <= set(prices)
    if not is_sqlite():
        return
    pid, _ = project(client, "An old radio that plays tomorrow")
    with engine.begin() as conn:  # an older database: projects without the memory column
        conn.execute(sql('ALTER TABLE projects DROP COLUMN "agent_memory"'))
    assert "agent_memory" not in {c["name"] for c in inspect(engine).get_columns("projects")}
    assert "projects.agent_memory" in migrate()
    with SessionLocal() as db:
        assert db.get(Project, pid).agent_memory == []  # existing rows get an empty memory
