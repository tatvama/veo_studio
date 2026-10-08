"""Own characters: uploaded photos lead the look references; voices cloned from samples need recorded consent."""
from __future__ import annotations

import io

from fastapi.testclient import TestClient
from PIL import Image

from app.db import SessionLocal
from app.models import AuditEntry, Character, CharacterAsset, Consent, Project
from app.pipeline.prompting import character_refs
from app.pipeline.voice import voice_for
from conftest import H, ok


def _png(color=(200, 120, 80)) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (64, 64), color).save(b, "PNG")
    return b.getvalue()


def test_uploaded_photo_is_the_first_reference(client: TestClient):
    c = client
    ch = ok(c.post("/api/characters", headers=H, json={"name": "Lakshmi", "gender": "female"}))
    cid = ch["id"]
    out = ok(c.post(f"/api/characters/{cid}/upload", headers=H, files={"file": ("me.png", _png(), "image/png")}, data={"label": "front"}))
    photo = next(a for a in out["assets"] if a["kind"] == "source")
    assert photo["approved"] and photo["label"] == "front" and out["avatar_url"] == photo["url"]
    # a generated sheet arrives later: the user's photo still leads, the generated view comes second
    with SessionLocal() as db:
        db.add(CharacterAsset(character_id=cid, kind="front", label="front", path=photo["url"].removeprefix("/media/"), approved=True))
        db.commit()
        refs = character_refs(db, db.get(Character, cid), max_n=2)
        assert [a.kind for a in refs] == ["source", "front"]
    # un-approving the photo hands the lead back to the generated view
    ok(c.patch(f"/api/character-assets/{photo['id']}", headers=H, json={"approved": False}))
    with SessionLocal() as db:
        assert [a.kind for a in character_refs(db, db.get(Character, cid), max_n=2)] == ["front"]
    bad = c.post(f"/api/characters/{cid}/upload", headers=H, files={"file": ("x.gif", b"GIF89a", "image/gif")})
    assert bad.status_code == 400


def test_clone_voice_needs_consent(client: TestClient):
    c = client
    cid = ok(c.post("/api/characters", headers=H, json={"name": "Raghav"}))["id"]
    sample = ("raghav.wav", b"RIFF" + b"\0" * 2000, "audio/wav")
    no = c.post(f"/api/characters/{cid}/voices/clone", headers=H, files=[("files", sample)], data={"subject_name": "Raghav K"})
    assert no.status_code == 400 and "permission" in no.json()["detail"]
    out = ok(c.post(f"/api/characters/{cid}/voices/clone", headers=H,
                    files=[("files", sample), ("files", ("two.mp3", b"ID3" + b"\0" * 900, "audio/mpeg")),
                           ("release", ("release.pdf", b"%PDF-1.4 signed", "application/pdf"))],
                    data={"subject_name": "Raghav K", "consent_confirmed": "true", "languages": "en,hi,kn"}))
    voices = {v["language"]: v for v in out["voices"]}
    assert set(voices) == {"en", "hi", "kn"}
    assert all(v["provider"] == "elevenlabs" and v["voice_id"].startswith("mock-clone-") for v in voices.values())
    assert voices["hi"]["sts_voice_id"] == voices["hi"]["voice_id"] and voices["en"]["sample_url"]
    with SessionLocal() as db:
        cons = db.query(Consent).filter(Consent.character_id == cid).one()
        assert cons.kind == "voice_replication" and cons.subject_name == "Raghav K" and cons.file_path
        assert db.query(AuditEntry).filter(AuditEntry.action == "voice.clone", AuditEntry.target == "Raghav").count() == 1
        project = db.query(Project).first() or Project(title="x")
        assert voice_for(db, cid, "kn", project)["voice_id"] == voices["kn"]["voice_id"]
        assert voice_for(db, cid, "te", project)["source"] == "profile-other-lang"  # reused in other languages
    bad = c.post(f"/api/characters/{cid}/voices/clone", headers=H, files=[("files", ("a.txt", b"hello", "text/plain"))],
                 data={"subject_name": "R", "consent_confirmed": "true"})
    assert bad.status_code == 400
