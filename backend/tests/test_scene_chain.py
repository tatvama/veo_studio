"""Scene chain rules (core/scene_chain.py): link order, when a keyframe really starts from the clip before it, and
when a scene picks up straight from the previous one."""
from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient

from app.core import scene_chain as sc
from app.db import SessionLocal, utcnow
from app.models import Character, Episode, Location, Project, Scene, Shot, Take
from conftest import H, ok


def _setup(c: TestClient):
    p = ok(c.post("/api/projects", headers=H, json={"concept": "Scene chain rules", "auto_brief": False}))
    with SessionLocal() as db:
        ep = db.query(Episode).filter(Episode.project_id == p["id"]).first()
        loc = Location(name="Courtyard")
        ravi, meera = Character(name="Ravi"), Character(name="Meera")
        db.add_all([loc, ravi, meera])
        db.flush()
        s1 = Scene(episode_id=ep.id, order=0, title="One", location_id=loc.id, time_of_day="dusk")
        s2 = Scene(episode_id=ep.id, order=1, title="Two", location_id=loc.id, time_of_day="dusk")
        db.add_all([s1, s2])
        db.flush()
        a = Shot(episode_id=ep.id, scene_id=s1.id, order=1, code="T-A", characters=[ravi.id])
        b = Shot(episode_id=ep.id, scene_id=s1.id, order=2, code="T-B", characters=[ravi.id], continuity_from_prev=True)
        cc = Shot(episode_id=ep.id, scene_id=s1.id, order=3, code="T-C", characters=[ravi.id], continuity_from_prev=True)
        d = Shot(episode_id=ep.id, scene_id=s2.id, order=4, code="T-D", characters=[ravi.id, meera.id])
        db.add_all([a, b, cc, d])
        db.commit()
        return ep.id, [s1.id, s2.id], [a.id, b.id, cc.id, d.id]


def _take(db, shot_id: int, kind: str, **kw) -> Take:
    t = Take(shot_id=shot_id, kind=kind, provider=kw.pop("provider", "google"), path=f"x/{kind}.bin", **kw)
    db.add(t)
    db.flush()
    return t


def test_waves_follow_the_links(client: TestClient):
    _, _, (a, b, c, d) = _setup(client)
    with SessionLocal() as db:
        shots = [db.get(Shot, i) for i in (c, d, b, a)]
        waves = [[s.code for s in w] for w in sc.waves(db, shots)]
        assert waves == [["T-D", "T-A"], ["T-B"], ["T-C"]]
        # a source outside the set (already made) does not hold a shot back
        assert [[s.code for s in w] for w in sc.waves(db, [db.get(Shot, b), db.get(Shot, c)])] == [["T-B"], ["T-C"]]


def test_a_keyframe_follows_only_the_current_source_clip(client: TestClient):
    _, _, (a, b, _, _) = _setup(client)
    now = utcnow()
    with SessionLocal() as db:
        shot_b = db.get(Shot, b)
        assert sc.link_status(db, shot_b)["status"] == "waiting"  # the shot before has no clip yet
        kf_from_kf = _take(db, b, "keyframe", params={"continuity": True}, created_at=now - timedelta(minutes=5))
        va = _take(db, a, "video", created_at=now)
        db.commit()
        assert not sc.follows(kf_from_kf, va) and sc.needs_new_keyframe(db, shot_b)  # made before the clip existed
        assert sc.link_status(db, shot_b)["status"] == "broken"
        kf_ok = _take(db, b, "keyframe", params={"continuity": True, "continuity_take_id": va.id})
        db.commit()
        assert sc.follows(kf_ok, va) and not sc.needs_new_keyframe(db, shot_b)
        assert sc.link_status(db, shot_b)["status"] == "ok"
        va2 = _take(db, a, "video", created_at=now + timedelta(minutes=1))  # the shot before was redone
        db.commit()
        assert not sc.follows(kf_ok, va2) and sc.link_status(db, shot_b)["status"] == "broken"
        upload = _take(db, b, "keyframe", provider="upload", params={"uploaded": True})
        db.commit()
        assert sc.follows(upload, va2) and not sc.needs_new_keyframe(db, shot_b)  # your own picture is kept


def test_extend_links_check_the_parent_clip(client: TestClient):
    _, _, (a, b, _, _) = _setup(client)
    with SessionLocal() as db:
        shot_b = db.get(Shot, b)
        shot_b.continuity_from_prev, shot_b.continuity_from_shot_id, shot_b.continuity_mode = False, a, "extend"
        va = _take(db, a, "video")
        db.commit()
        assert sc.link_status(db, shot_b)["status"] == "pending" and not sc.needs_new_keyframe(db, shot_b)
        _take(db, b, "video", parent_take_id=va.id)
        db.commit()
        assert sc.link_status(db, shot_b)["status"] == "ok"


def test_a_scene_that_picks_up_straight_is_linked(client: TestClient):
    _, (s1, s2), (a, b, c, d) = _setup(client)
    with SessionLocal() as db:
        scene2 = db.get(Scene, s2)
        first, last = sc.scene_link_candidate(db, scene2, "auto")
        assert (first.code, last.code) == ("T-D", "T-C")
        assert sc.scene_link_candidate(db, scene2, "never") is None
        scene2.time_of_day = "night"  # a time jump is a cut, not a continuation
        db.commit()
        assert sc.scene_link_candidate(db, scene2, "auto") is None
        assert sc.scene_link_candidate(db, scene2, "always") is not None
        _take(db, d, "video")  # already made: never re-linked behind the user's back
        db.commit()
        assert sc.scene_link_candidate(db, scene2, "always") is None
        assert sc.scene_link_candidate(db, db.get(Scene, s1), "always") is None  # the first scene has nothing before it
