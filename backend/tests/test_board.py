"""Script import + manual shot list + Produce all (mock providers)."""
from __future__ import annotations

import io
import zipfile

from fastapi.testclient import TestClient

from conftest import H, ok, wait_jobs

MARKED = """SCENE 1: INT. KITCHEN - MORNING
Ajji opens the pickle jar while sunlight streams in.
SHOT 1 (6s)
VISUAL: Close-up of wrinkled hands twisting the jar lid.
AJJI (proud): This recipe is fifty years old.
SHOT 2
VISUAL: Wide shot of the kitchen, steam rising.
VO: Some flavours never leave you.
SCENE 2: EXT. GARDEN - DAY
VISUAL: Mango trees sway in the breeze.
RAVI (smiling): I can smell it from here!
MEERA: Then come inside.
"""


def _docx(paragraphs: list[str]) -> bytes:
    ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = "".join(f"<w:p><w:r><w:t xml:space=\"preserve\">{p}</w:t></w:r></w:p>" for p in paragraphs)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>")
        z.writestr("word/document.xml", f"<w:document xmlns:w=\"{ns}\"><w:body>{body}</w:body></w:document>")
    return buf.getvalue()


def _project(c: TestClient, **kw) -> tuple[int, int]:
    p = ok(c.post("/api/projects", headers=H, json={"concept": "Imported script", "type": "ad", "auto_brief": False,
                                                    "languages": ["en"], **kw}))
    return p["id"], p["episodes"][0]["id"]


def test_import_marked_script_and_save_board(client: TestClient):
    c = client
    pid, eid = _project(c)
    out = ok(c.post(f"/api/episodes/{eid}/import/parse", headers=H, data={"text": MARKED}))
    assert out["method"] == "markers" and out["stats"] == {"scenes": 2, "shots": 4, "lines": 4}
    assert {ch["name"] for ch in out["characters"]} == {"Ajji", "Ravi", "Meera"}
    sc1, sc2 = out["draft"]["scenes"]
    assert sc1["location"] == "Kitchen" and sc1["shots"][0]["duration_s"] == 6
    assert sc1["shots"][1]["lines"] == [{"speaker": "VO", "text": "Some flavours never leave you.", "emotion": "", "changed": False}]
    assert [sh["lines"][0]["speaker"] for sh in sc2["shots"]] == ["Ravi", "Meera"]  # one on-screen speaker per shot

    # the wizard maps names to characters (here: create them), then saves the board
    ids = {n: ok(c.post("/api/characters", headers=H, json={"name": n, "project_id": pid}))["id"] for n in ("Ajji", "Ravi", "Meera")}
    scenes = []
    for sc in out["draft"]["scenes"]:
        scenes.append({**{k: sc[k] for k in ("title", "location", "time_of_day", "summary")}, "shots": [
            {"prompt": sh["prompt"], "duration_s": sh["duration_s"], "characters": [ids[n] for n in sh["characters"]],
             "lines": [{"speaker": l["speaker"] if l["speaker"] == "VO" else ids[l["speaker"]], "text": l["text"], "emotion": l["emotion"]}
                       for l in sh["lines"]]} for sh in sc["shots"]]})
    scenes[1]["shots"][0]["extend_to"] = 15
    b = ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": scenes}))
    shots = [sh for sc in b["scenes"] for sh in sc["shots"]]
    assert [sh["code"] for sh in shots] == ["E01-SH01", "E01-SH02", "E01-SH03", "E01-SH04"]
    assert shots[2]["extend_to"] == 15 and shots[1]["lines"][0]["speaker"] == "VO"

    vo = ok(c.get(f"/api/shots/{shots[1]['id']}"))
    assert vo["narration"]["en"] == "Some flavours never leave you." and not vo["dialogue"].get("en")
    ajji = ok(c.get(f"/api/shots/{shots[0]['id']}"))
    assert ajji["dialogue"]["en"][0]["character_id"] == ids["Ajji"] and ajji["characters"] == [ids["Ajji"]]
    ep = ok(c.get(f"/api/episodes/{eid}"))
    assert ep["script"]["scenes"][0]["lines"][1] == {"character": "NARRATOR", "line": "Some flavours never leave you.", "emotion": ""}
    cast = {ch["id"] for ch in ok(c.get(f"/api/characters?project_id={pid}"))}
    assert set(ids.values()) <= cast

    # edit: drop a shot, change a line, add a shot to a new scene
    b["scenes"][0]["shots"].pop(1)
    b["scenes"][0]["shots"][0]["lines"][0]["text"] = "Fifty years, and still the best."
    b["scenes"].append({"title": "Tag", "shots": [{"prompt": "Logo on a wooden table.", "duration_s": 4}]})
    b2 = ok(c.put(f"/api/episodes/{eid}/board", headers=H, json=b))
    assert [len(sc["shots"]) for sc in b2["scenes"]] == [1, 2, 1]
    assert b2["scenes"][0]["shots"][0]["lines"][0]["text"] == "Fifty years, and still the best."
    assert ok(c.post(f"/api/shots/{shots[0]['id']}/undo", headers=H))["dialogue"]["en"][0]["line"] == "This recipe is fifty years old."

    # bad input is refused
    bad = c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [{"title": "x", "shots": [{"prompt": "p", "duration_s": 5}]}]})
    assert bad.status_code == 400


def test_import_docx_and_ai_arrange(client: TestClient):
    c = client
    pid, eid = _project(c)
    doc = _docx(["SCENE 1: EXT. TEMPLE - NIGHT", "VISUAL: The lamp flickers.", "RAVI: Did you see that?"])
    out = ok(c.post(f"/api/episodes/{eid}/import/parse", headers=H,
                    files={"file": ("script.docx", doc, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}))
    assert out["source"] == "script.docx" and out["method"] == "markers"
    assert out["draft"]["scenes"][0]["shots"][0]["lines"][0]["text"] == "Did you see that?"

    prose = "Ravi walks into the temple at night.\nMeera: It has always moved.\n\nThey watch it together until dawn."
    ai = ok(c.post(f"/api/episodes/{eid}/import/parse", headers=H, data={"text": prose}))
    assert ai["method"] == "ai" and ai["stats"]["scenes"] == 2
    assert ai["draft"]["scenes"][0]["shots"][1]["lines"][0] == {"speaker": "Meera", "text": "It has always moved.", "emotion": "", "changed": False}
    bad = c.post(f"/api/episodes/{eid}/import/parse", headers=H, files={"file": ("old.doc", b"\xd0\xcf\x11\xe0", "application/msword")})
    assert bad.status_code == 400


def test_produce_all(client: TestClient):
    c = client
    pid, eid = _project(c, quality_mode="saver", languages=["hi"])  # Hindi dialogue → voice first, then lip-sync
    ravi =ok(c.post("/api/characters", headers=H, json={"name": "Ravi", "project_id": pid}))["id"]
    ok(c.put(f"/api/episodes/{eid}/board", headers=H, json={"scenes": [{"title": "One", "shots": [
        {"prompt": "Ravi lights the lamp.", "duration_s": 6, "characters": [ravi],
         "lines": [{"speaker": ravi, "text": "Tonight it moves again."}], "extend_to": 15},
        {"prompt": "The lamp glows.", "duration_s": 4, "lines": [{"speaker": "VO", "text": "Some lights never go out."}]},
    ]}]}))
    est = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "produce"}))
    labels = [i["label"] for i in est["items"]]
    assert labels[:3] == ["Keyframes · 2", "Videos · 2", "Extensions · 2"] and labels[-1] == "Final export · 1"
    res = ok(c.post(f"/api/episodes/{eid}/generate", headers=H, json={"action": "produce"}))
    assert res["jobs"][0]["type"] == "produce"
    jobs = wait_jobs(c, pid, timeout=600)
    prod = next(j for j in jobs if j["type"] == "produce")
    assert prod["status"] == "succeeded", prod["error"]
    kinds = [j["type"] for j in jobs if j["status"] == "succeeded"]
    assert kinds.count("keyframe") == 2 and kinds.count("video") >= 3  # 2 shots + at least one extension
    assert "lipsync" in kinds and "voice" in kinds and "music" in kinds and "export" in kinds
    b = ok(c.get(f"/api/episodes/{eid}/board"))
    assert all(sh["has_video"] for sc in b["scenes"] for sh in sc["shots"])
    # running it again only makes what is missing
    again = ok(c.post(f"/api/episodes/{eid}/estimate", headers=H, json={"action": "produce", "steps": ["keyframes", "videos"]}))
    assert again["count"] == 0
