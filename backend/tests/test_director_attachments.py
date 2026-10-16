"""One long prompt with pictures: chat attachments (upload, tags, what Claude and Gemini see), @mentions in the chat,
the 30,000-character limit and a new thread's carry-over, and the Director tools that act on it (cast from a picture,
the user's script word for word, scenes in order, engines, character sheets).
Mock providers and fake AI clients only: nothing here calls a paid API."""
from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import shutil

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import text as sql

from app.agents import director
from app.agents import director_claude as DC
from app.agents import tools as T
from app.db import SessionLocal
from app.models import (AgentAttachment, AgentMessage, Character, CharacterAsset, Episode, Job, Location, LocationAsset, Project,
                        Prop, User)
from app.storage import get_storage
from conftest import H, ok
from test_director_agentic import FakeGemini, _with_takes
from test_director_claude import THINK, chat, claude, msg, project, segments, text, tool  # noqa: F401  (claude: fixture)

SCRIPT = """SCENE 1 - INT. TEMPLE COURTYARD - DUSK
VISUAL: Rows of brass lamps on worn stone. Ishvani walks in carrying an oil lamp.
ISHVANI: I saw the lamp move again.
TORLAK: Then it was not a dream.
SCENE 2 - INT. TEMPLE COURTYARD - DUSK
VISUAL: The lamp slides across the stone by itself. Ishvani steps back.
ISHVANI: Who is moving it?
"""


def _png(w: int = 1600, h: int = 1200, color: tuple[int, int, int] = (200, 80, 40)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def _upload(c: TestClient, pid: int, data: bytes, name: str = "photo.png", ctype: str = "image/png"):
    return c.post(f"/api/projects/{pid}/agent/attachments", headers=H, files={"file": (name, data, ctype)})


def _ctx(db, pid: int, eid: int | None = None, **kw) -> T.AgentCtx:
    user = db.query(User).filter(User.email == "admin@test.local").first()
    return T.AgentCtx(db=db, user=user, project=db.get(Project, pid), episode=db.get(Episode, eid) if eid else None, **kw)


def _character(c: TestClient, pid: int, name: str) -> int:
    return ok(c.post("/api/characters", headers=H, json={"name": name, "project_id": pid}))["id"]


def _jpeg_edge(b64: str) -> int:
    with Image.open(io.BytesIO(base64.b64decode(b64))) as im:
        assert im.format == "JPEG"
        return max(im.size)


def test_attachments_tags_and_mentions_reach_claude(client: TestClient, claude):  # noqa: F811
    pid, eid = project(client, "A lamp that walks at dusk")
    ravi = _character(client, pid, "Ravindranath Q")
    up = ok(_upload(client, pid, _png(), "ravi.png"))
    assert up["url"].startswith("/media/agent/") and up["thumb_url"].endswith("_t.jpg") and (up["width"], up["height"]) == (1600, 1200)
    new = ok(_upload(client, pid, _png(900, 1200, (10, 120, 200)), "her.jpg", "image/jpeg"))
    style = ok(_upload(client, pid, _png(640, 360, (20, 20, 20)), "look.webp", "image/webp"))
    # the bytes decide: not an image, an empty file or a fake extension are refused
    assert _upload(client, pid, b"hello, not a picture", "x.png").status_code == 400
    assert _upload(client, pid, b"\x89PNG\r\n\x1a\nbroken", "y.png").status_code == 400
    other, _ = project(client, "Someone else's project")
    assert client.post(f"/api/projects/{other}/agent/chat", headers=H,
                       json={"message": "hi", "attachments": [{"id": up["id"]}]}).status_code == 404

    fake = claude(msg([THINK, tool("t1", "add_cast_from_image", {"attachment_id": new["id"], "name": "Ishvani", "kind": "character",
                                                                 "description": "Woman, early 30s, oval face, long black braid"}),
                       tool("t2", "look_at_attachment", {"attachment_id": up["id"]})], "tool_use"),
                  msg([THINK, text("Ishvani is in the cast now.")]),
                  msg([text("You're welcome.")]))
    message = f"Make @[Ravindranath Q](character:{ravi}) meet @Ishvani at the temple. Keep the look of the third picture."
    out = ok(client.post(f"/api/projects/{pid}/agent/chat", headers=H, json={
        "message": message, "episode_id": eid,
        "attachments": [{"id": up["id"], "tag": {"kind": "character", "id": ravi}},
                        {"id": new["id"], "tag": {"kind": "character", "name": "Ishvani"}},
                        {"id": style["id"], "tag": {"kind": "style"}}]}))[0]
    assert out["content"] == "Ishvani is in the cast now."

    # the turn: context (message id, mentions with ids, how many pictures), each picture after its label, then the text
    user = fake.calls[0]["messages"][0]
    assert [b["type"] for b in user["content"]] == ["text", "text", "image", "text", "image", "text", "image", "text"]
    ctx = user["content"][0]["text"]
    assert "This message is chat message #" in ctx and "3 pictures attached to this message" in ctx
    assert f"@Ravindranath Q = character #{ravi} (in the cast, 0 approved reference images)" in ctx
    assert "@Ishvani: no character, location or prop with that name yet" in ctx
    labels = [b["text"] for b in user["content"][1:-1] if b["type"] == "text"]
    assert f"Attachment #{up['id']} (image 1 of 3, 'ravi.png', 1600×1200): the existing character 'Ravindranath Q' (#{ravi}" in labels[0]
    assert "a NEW character named 'Ishvani'" in labels[1] and "look / style reference" in labels[2]
    assert user["content"][-1]["text"] == message.replace(f"@[Ravindranath Q](character:{ravi})", "@Ravindranath Q")
    assert _jpeg_edge(user["content"][2]["source"]["data"]) == 1024  # downsized for the model, never the original

    # the tools ran: the new character exists with the picture as an approved reference; look_at_attachment showed one
    results = fake.calls[1]["messages"][2]["content"]
    added = json.loads(results[0]["content"])
    assert added["created"] is True and added["kind"] == "character" and added["mention"] == f"@[Ishvani]({'character'}:{added['id']})"
    assert [b["type"] for b in results[1]["content"]] == ["text", "text", "image"]
    with SessionLocal() as db:
        ish = db.get(Character, added["id"])
        assert ish.dna_text == "Woman, early 30s, oval face, long black braid" and not ish.shared
        refs = db.query(CharacterAsset).filter(CharacterAsset.character_id == ish.id).all()
        assert [(a.kind, a.approved) for a in refs] == [("source", True)]
        assert not refs[0].ai_made  # a real person's photo until the user marks it AI-made: never sent to BytePlus
        um = (db.query(AgentMessage).filter(AgentMessage.project_id == pid, AgentMessage.role == "user")
              .order_by(AgentMessage.id.desc()).first())
        rows = db.query(AgentAttachment).filter(AgentAttachment.message_id == um.id).order_by(AgentAttachment.id).all()
        assert [r.id for r in rows] == [up["id"], new["id"], style["id"]]
        assert rows[1].tag == {"kind": "character", "id": ish.id, "name": "Ishvani", "new": False}  # tagged after adding
        assert f"chat message #{um.id}" in ctx

    # the chat history shows the pictures with their tags (and never the raw API conversation)
    msgs = ok(client.get(f"/api/projects/{pid}/agent/messages"))
    mine = next(m for m in msgs if m["role"] == "user")
    assert [a["id"] for a in mine["data"]["attachments"]] == [up["id"], new["id"], style["id"]]
    assert mine["data"]["attachments"][0]["tag"] == {"kind": "character", "id": ravi, "name": "Ravindranath Q", "new": False}
    assert mine["data"]["attachments"][1]["tag"] == {"kind": "character", "name": "Ishvani", "new": True}
    assert mine["data"]["attachments"][2]["tag"] == {"kind": "style"} and mine["content"] == message
    assert all("claude" not in m["data"] for m in msgs)

    # the next turn replays the stored thread append-only, pictures included (editing it would void the thinking)
    chat(client, pid, eid, "thanks")
    turn1 = fake.calls[1]["messages"] + [{"role": "assistant", "content": [THINK, text("Ishvani is in the cast now.")]}]
    assert fake.calls[2]["messages"][: len(turn1)] == turn1


def test_long_messages_limit_and_new_thread_carry_over(client: TestClient, claude):  # noqa: F811
    pid, eid = project(client, "A long brief")
    long = ("Ravi walks to the temple at dusk and finds the lamp moving. " * 600)[:30_000]
    url = f"/api/projects/{pid}/agent/chat"
    assert client.post(url, headers=H, json={"message": long + "x", "episode_id": eid}).status_code == 422
    assert client.post(url, headers=H, json={"message": "   ", "episode_id": eid}).status_code == 422
    fake = claude(msg([text("One.")]), msg([text("Two.")]))
    chat(client, pid, eid, long)
    with SessionLocal() as db:
        first = (db.query(AgentMessage).filter(AgentMessage.project_id == pid, AgentMessage.role == "user")
                 .order_by(AgentMessage.id.desc()).first())
        assert first.content == long
        last = (db.query(AgentMessage).filter(AgentMessage.project_id == pid, AgentMessage.role == "assistant")
                .order_by(AgentMessage.id.desc()).first())
        last.data = {**last.data, "claude": {**last.data["claude"], "input_tokens": 70_000}}  # too big: next turn starts over
        db.commit()
    chat(client, pid, eid, "continue")
    new_thread = fake.calls[1]["messages"]
    assert len(new_thread) == 1
    ctx = new_thread[0]["content"][0]["text"]
    assert "Earlier in this chat (before this conversation thread started)" in ctx
    assert f"(chat message #{first.id}): Ravi walks to the temple" in ctx
    assert f"[trimmed: 30,000 characters; read_chat_message({first.id}) has all of it]" in ctx and "- Your last reply: One." in ctx
    assert len(ctx) < 6000  # the long message is not replayed in full
    with SessionLocal() as db:
        c = _ctx(db, pid, eid)
        piece = T.run_tool(c, "read_chat_message", {"message_id": first.id})
        assert piece["chars"] == 30_000 and len(piece["text"]) == 10_000 and piece["next_offset"] == 10_000
        assert T.run_tool(c, "read_chat_message", {"message_id": first.id, "offset": 20_000})["next_offset"] is None
        assert "error" in T.run_tool(c, "read_chat_message", {"message_id": 10 ** 9})


def test_gemini_gets_the_pictures_as_a_note(client: TestClient, monkeypatch):
    pid, eid = project(client, "Gemini sees notes")
    att = ok(_upload(client, pid, _png(), "temple.png"))
    fake = FakeGemini({"id": "i1", "text": "Noted."})

    class FakeServices:
        models = {"text": "gemini-test"}

        def gemini(self):
            return fake

        def text_cost(self, model, tin, tout):
            return 0.0

    monkeypatch.setattr(director, "Services", FakeServices)
    with SessionLocal() as db:
        p = db.get(Project, pid)
        from app.core import chat_attachments
        entries = chat_attachments.for_message(db, p, [{"id": att["id"], "tag": {"kind": "location", "name": "Old Temple Q"}}])
        c = _ctx(db, pid, eid, attachments=entries, turn=0)
        assert director._live_agent(c, "Use this as the temple", {}) == "Noted."
    content = fake.calls[0]["input"][0]["content"]
    assert content.startswith("Use this as the temple") and "1 picture attached to this message" in content
    assert "can't see them here" in content and "a NEW location named 'Old Temple Q'" in content


def test_cast_from_image_for_every_kind_and_the_shared_upload_helper(client: TestClient):
    pid, eid = project(client, "Cast from pictures")
    a = ok(_upload(client, pid, _png(), "ravi.png"))["id"]
    b = ok(_upload(client, pid, _png(800, 800, (0, 90, 0)), "lamp.png"))["id"]
    existing = _character(client, pid, "Kavya Q")
    with SessionLocal() as db:
        c = _ctx(db, pid, eid)
        same = T.run_tool(c, "add_cast_from_image", {"attachment_id": a, "name": "kavya q", "kind": "character"})
        assert same["created"] is False and same["id"] == existing
        loc = T.run_tool(c, "add_cast_from_image", {"attachment_id": f"#{a}", "name": "Riverside Ghat Q", "kind": "location",
                                                    "description": "Stone steps down to a wide river"})
        assert loc["created"] and db.get(Location, loc["id"]).description_text == "Stone steps down to a wide river"
        assert db.query(LocationAsset).filter(LocationAsset.location_id == loc["id"], LocationAsset.approved.is_(True)).count() == 1
        prop = T.run_tool(c, "add_cast_from_image", {"attachment_id": b, "name": "Brass Lamp Q", "kind": "prop"})
        assert prop["created"] and db.get(Prop, prop["id"]).path.startswith(f"props/{prop['id']}/")
        # a prop has one picture: replacing it asks first
        again = T.run_tool(c, "add_cast_from_image", {"attachment_id": a, "name": "Brass Lamp Q", "kind": "prop"})
        assert again["status"] == "waiting_for_user_confirmation" and c.confirmations[-1]["what"] == "Replace the picture of Brass Lamp Q"
        assert "error" in T.run_tool(c, "add_cast_from_image", {"attachment_id": 10 ** 9, "name": "X", "kind": "character"})
        assert "error" in T.run_tool(c, "add_cast_from_image", {"attachment_id": a, "name": "X", "kind": "dragon"})
        assert db.query(CharacterAsset).filter(CharacterAsset.character_id == existing, CharacterAsset.kind == "source").count() == 1
    # the Cast step's own upload goes through the same helper
    ok(client.post(f"/api/characters/{existing}/upload", headers=H, files={"file": ("me.png", _png(300, 300), "image/png")},
                   data={"label": "my photo"}))
    with SessionLocal() as db:
        rows = db.query(CharacterAsset).filter(CharacterAsset.character_id == existing).order_by(CharacterAsset.id).all()
        assert [(r.kind, r.approved, r.label) for r in rows] == [("source", True, "reference from the Director chat"),
                                                                ("source", True, "my photo")]


def test_import_script_word_for_word_then_scenes_in_order(client: TestClient):
    pid, eid = project(client, "Import the user's own script")
    msg_text = ("Make this on Seedance please. Here is my script:\n\n" + SCRIPT + "\nThat's all, thanks!")
    with SessionLocal() as db:
        p = db.get(Project, pid)
        um = director._save(db, p, db.query(User).filter(User.email == "admin@test.local").first(), "user", msg_text, {})
        c = _ctx(db, pid, eid, turn=um.id)
        bad = T.run_tool(c, "import_script", {"start": "SCENE 9"})
        assert "isn't in the message" in bad["error"]
        out = T.run_tool(c, "import_script", {"start": "SCENE 1 - INT.", "end": "Who is moving it?", "method": "markers"})
        assert out["scenes"] == 2 and out["shots"] >= 2 and {"Ishvani", "Torlak"} <= set(out["created_characters"])
        script = db.get(Episode, eid).script
        lines = [l["line"] for sc in script["scenes"] for l in sc["lines"]]
        assert lines == ["I saw the lamp move again.", "Then it was not a dream.", "Who is moving it?"]  # word for word
        assert "Seedance" not in json.dumps(script) and "thanks" not in json.dumps(script)  # the instructions stayed out
        # a second import would replace the shot list: it waits for the user's OK, with the message id kept on the card
        again = T.run_tool(c, "import_script", {})
        assert again["status"] == "waiting_for_user_confirmation" and c.confirmations[-1]["args"]["message_id"] == um.id

        # engines only on request: by name, checked against the Model Hub
        eng = T.run_tool(c, "set_video_engine", {"engine": "Seedance 2.0 BytePlus"})
        assert eng["engine"] == "byteplus:seedance-2.0" and eng["shots"] == [s.code for s in c.shots()]
        assert {s.engine for s in c.shots()} == {"byteplus:seedance-2.0"}
        assert "error" in T.run_tool(c, "set_video_engine", {"engine": "Totally Unknown Engine 9"})
        code = c.shots()[0].code
        assert "error" in T.run_tool(c, "update_shot", {"shot_code": code, "changes": {"engine": "nope nope"}})
        T.run_tool(c, "update_shot", {"shot_code": code, "changes": {"engine": "auto"}})
        assert c.shots()[0].engine == "auto"
        scene2 = T.run_tool(c, "set_video_engine", {"engine": "byteplus:seedance-2.5", "scene": 2})
        assert scene2["engine"] == "byteplus:seedance-2.5" and scene2["shots"] and code not in scene2["shots"]

        # scenes in order: a plan first, then one scene_chain run proposed (Co-pilot)
        plan = T.run_tool(c, "generate_scenes", {"plan_only": True})
        assert plan["submitted"] is False and [s["scene"] for s in plan["scenes"]] == [1, 2] and plan["shots_to_make"] >= 2
        assert "error" in T.run_tool(c, "generate_scenes", {"scenes": [7]})
        run = T.run_tool(c, "generate_scenes", {"scenes": [2, 1], "link_scenes": "always", "pause_after_each_scene": True})
        assert run["status"] == "proposed" and c.proposals[-1]["batch_id"] == run["batch_id"]
        job = db.query(Job).filter(Job.batch_id == run["batch_id"]).one()
        assert job.type == "scene_chain" and job.payload["link_scenes"] == "always" and job.payload["pause_after_each"] is True
        assert len(job.payload["scene_ids"]) == 2 and job.label == "Scenes 1, 2 in order"
        ok(client.post(f"/api/batches/{run['batch_id']}/cancel", headers=H))

        # write_script can take the user's brief word for word too (from this turn's message)
        prep = T._prepare(c, "write_script", {"from_message": True})
        assert prep["message_id"] == um.id


def test_character_sheets_for_cast_with_only_a_photo(client: TestClient):
    pid, eid = project(client, "Sheets from photos")
    att = ok(_upload(client, pid, _png(), "face.png"))["id"]
    with SessionLocal() as db:
        c = _ctx(db, pid, eid)
        T.run_tool(c, "add_cast_from_image", {"attachment_id": att, "name": "Photo Only Q", "kind": "character"})
        out = T.run_tool(c, "make_character_sheets", {})
        assert out["status"] == "proposed" and out["characters"] == ["Photo Only Q"] and out["views"] == ["front", "three_quarter", "full_body"]
        job = db.query(Job).filter(Job.batch_id == out["batch_id"]).one()
        assert job.type == "character_sheet" and job.payload["kinds"] == ["front", "three_quarter", "full_body"]
        assert "error" in T.run_tool(c, "make_character_sheets", {"characters": ["Nobody Here"]})
        ok(client.post(f"/api/batches/{out['batch_id']}/cancel", headers=H))


def test_mention_tokens_stay_fast_on_hostile_text():
    """A 30k-character chat line of "@[" with no closing "]" must not make the token regex rescan the line from
    every "@[" (polynomial time); names longer than NAME_MAX are never tokens anyway."""
    import time

    from app.core import mentions

    hostile = "@[" * 15_000
    t0 = time.perf_counter()
    assert mentions.find(hostile) == [] and mentions.plain(hostile) == hostile
    assert time.perf_counter() - t0 < 1.0
    ok_token = "@[" + "N" * mentions.NAME_MAX + "](character:7)"
    assert mentions.find(ok_token) == [("character", 7, "N" * mentions.NAME_MAX)]
    assert mentions.find("@[" + "N" * (mentions.NAME_MAX + 1) + "](character:7)") == []


# ── pictures in the stored Claude thread: files, not base64 in the database ──

def _images(messages: list[dict]) -> list[dict]:
    """Every image block of a thread: in user turns and inside tool results."""
    out = []
    for m in messages:
        for b in m["content"] if isinstance(m["content"], list) else []:
            if b.get("type") == "image":
                out.append(b)
            elif b.get("type") == "tool_result" and isinstance(b.get("content"), list):
                out += [x for x in b["content"] if x.get("type") == "image"]
    return out


def _send(c: TestClient, pid: int, eid: int, message: str, attachments: list[dict]) -> dict:
    return ok(c.post(f"/api/projects/{pid}/agent/chat", headers=H,
                     json={"message": message, "episode_id": eid, "attachments": attachments}))[0]


def _last_assistant(db, pid: int) -> AgentMessage:
    return (db.query(AgentMessage).filter(AgentMessage.project_id == pid, AgentMessage.role == "assistant")
            .order_by(AgentMessage.id.desc()).first())


def test_thread_pictures_are_stored_as_files_and_replayed_byte_for_byte(client: TestClient, claude):  # noqa: F811
    pid, eid, code, _ = _with_takes(client)
    up = ok(_upload(client, pid, _png(), "ravi.png"))
    fake = claude(msg([THINK, tool("l1", "look_at_shot", {"shot_code": code}),
                       tool("l2", "look_at_attachment", {"attachment_id": up["id"]})], "tool_use"),
                  msg([THINK, text("Seen them.")]),
                  msg([THINK, text("Again.")]))
    assert _send(client, pid, eid, "Look at this and the first shot", [{"id": up["id"]}])["content"] == "Seen them."
    turn1 = fake.calls[1]["messages"] + [{"role": "assistant", "content": [THINK, text("Seen them.")]}]
    sent = _images(turn1)
    # the attachment in the user turn, the keyframe + 3 video frames (look_at_shot), the attachment again (look_at_attachment)
    assert len(sent) == 6 and all(b["source"]["type"] == "base64" for b in sent)

    # the saved row holds references: no base64 in the database, each picture's exact bytes in a file named by its sha256
    with SessionLocal() as db:
        row = _last_assistant(db, pid)
        raw = db.execute(sql("SELECT data FROM agent_messages WHERE id = :i"), {"i": row.id}).scalar()
        stored = _images(row.data["claude"]["messages"])
    assert '"base64"' not in raw and not any(b["source"]["data"][:100] in raw for b in sent)
    assert len(raw) < 60_000 < sum(len(b["source"]["data"]) for b in sent)
    st = get_storage()
    for b, ref in zip(sent, stored):
        data = base64.b64decode(b["source"]["data"])
        sha = hashlib.sha256(data).hexdigest()
        assert ref == {"type": "image", "source": {"type": "tatvam_ref", "media_type": "image/jpeg",
                                                   "key": f"agent/{pid}/thread/{sha}.jpg", "sha256": sha}}
        assert st.abs(ref["source"]["key"]).read_bytes() == data
    assert stored[0] == stored[-1]  # the same picture twice: saved once
    assert len({r["source"]["key"] for r in stored}) == 5 == len(list(st.abs(f"agent/{pid}/thread").iterdir()))

    # the source picture changes later: the stored thread still has the bytes it sent
    with SessionLocal() as db:
        st.abs(db.get(AgentAttachment, up["id"]).path).write_bytes(_png(1600, 1200, (0, 0, 255)))
    assert chat(client, pid, eid, "and again")["content"] == "Again."
    replay, sent1 = fake.calls[2]["messages"], fake.calls[1]["messages"]
    assert json.dumps(replay[: len(sent1)]) == json.dumps(sent1)  # what went to the API, byte for byte, key order included
    assert replay[len(sent1)] == turn1[-1] and replay[: len(turn1)] == turn1
    assert len(replay) == len(turn1) + 1 and replay[-1]["content"][-1]["text"] == "and again"


@pytest.mark.parametrize("damage", ["missing", "changed"])
def test_a_thread_whose_picture_file_is_gone_starts_over(client: TestClient, claude, damage):  # noqa: F811
    pid, eid = project(client, f"A temple picture that goes {damage}")
    up = ok(_upload(client, pid, _png(), "temple.png"))
    fake = claude(msg([THINK, text("Nice temple.")]), msg([THINK, text("Fresh start.")]))
    _send(client, pid, eid, "Use this temple", [{"id": up["id"], "tag": {"kind": "location", "name": "Old Temple Q"}}])
    [seg] = segments(pid)
    [ref] = _images(seg["messages"])
    path = get_storage().abs(ref["source"]["key"])
    if damage == "missing":
        path.unlink()
    else:
        path.write_bytes(path.read_bytes() + b"\x00")
    assert chat(client, pid, eid, "and now?")["content"] == "Fresh start."
    # a new thread (as when the API rejects a stored conversation): only the new turn, the earlier chat carried over as text
    [first] = fake.calls[1]["messages"]
    ctx = first["content"][0]["text"]
    assert "Earlier in this chat (before this conversation thread started)" in ctx and f"look_at_attachment({up['id']})" in ctx
    assert first["content"][-1]["text"] == "and now?" and not _images(fake.calls[1]["messages"])
    s1, s2 = segments(pid)
    assert s2["thread"] != s1["thread"] and s2["turn"] == 0


def test_old_inline_thread_segments_still_replay(client: TestClient, claude):  # noqa: F811
    pid, eid = project(client, "A thread from before picture files")
    up = ok(_upload(client, pid, _png(), "lamp.png"))
    fake = claude(msg([THINK, text("Got it.")]), msg([THINK, text("Still here.")]))
    _send(client, pid, eid, "This is the lamp", [{"id": up["id"]}])
    turn1 = fake.calls[0]["messages"] + [{"role": "assistant", "content": [THINK, text("Got it.")]}]
    with SessionLocal() as db:  # stored the way earlier versions did: the picture inline, and no file
        row = _last_assistant(db, pid)
        row.data = {**row.data, "claude": {**row.data["claude"], "messages": turn1}}
        db.commit()
        old = row.id
    shutil.rmtree(get_storage().abs(f"agent/{pid}/thread"))
    assert chat(client, pid, eid, "more")["content"] == "Still here."
    assert json.dumps(fake.calls[1]["messages"][: len(turn1)]) == json.dumps(turn1)
    with SessionLocal() as db:  # nothing migrated: the old row is left as it was
        assert db.get(AgentMessage, old).data["claude"]["messages"] == turn1


def _small_jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (80, 60), (90, 30, 160)).save(buf, "JPEG", quality=82)
    return buf.getvalue()


def test_stash_and_load_images_round_trip():
    jpg = base64.b64encode(_small_jpeg()).decode()
    png = base64.b64encode(_png(64, 48)).decode()
    msgs = [{"role": "user", "content": [
                {"type": "text", "text": "hi"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": jpg}},
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "QR=="}},  # not canonical
                {"type": "image", "source": {"type": "base64", "media_type": "image/tiff", "data": jpg}},  # no file type for it
                {"type": "image", "source": {"type": "url", "url": "https://example.com/x.jpg"}}]},
            {"role": "assistant", "content": [THINK, tool("t1", "look_at_shot", {"shot_code": "E01-SH01"})]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": [
                    {"type": "text", "text": "{}"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": png}}]},
                {"type": "tool_result", "tool_use_id": "t2", "content": "plain", "is_error": True}]}]
    before = copy.deepcopy(msgs)
    stored = DC._stash_images(10 ** 6, msgs)
    assert msgs == before  # copies: what was sent is never edited
    assert [b["source"]["type"] for b in _images(stored)] == ["tatvam_ref", "base64", "base64", "url", "tatvam_ref"]
    assert stored[1] == msgs[1] and stored[2]["content"][1] == msgs[2]["content"][1]
    assert _images(stored)[-1]["source"]["key"].endswith(".png")
    assert json.dumps(DC._load_images(stored)) == json.dumps(msgs)
    assert json.dumps(DC._load_images(before)) == json.dumps(msgs)  # an inline thread passes through as it is
