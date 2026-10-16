"""The Director's generate_videos makes shots that continue another shot in link order (core/scene_chain.py, as Autopilot
and the scene runs do): one run, wave by wave, so a linked shot starts from the finished clip before it. Mock providers."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.agents import tools as T
from app.db import SessionLocal
from app.models import Episode, Job, Project, Shot, Take, User
from app.pipeline.selection import current
from conftest import H, ok, wait_jobs
from test_director_claude import project


def _ctx(db, pid: int, eid: int) -> T.AgentCtx:
    user = db.query(User).filter(User.email == "admin@test.local").first()
    return T.AgentCtx(db=db, user=user, project=db.get(Project, pid), episode=db.get(Episode, eid))


def test_generate_videos_queues_linked_shots_in_link_order(client: TestClient):
    pid, eid = project(client, "Link order")
    codes = []
    for action in ("Ravi lifts the lamp", "Ravi turns to the door", "A crow on the roof"):
        codes.append(ok(client.post(f"/api/episodes/{eid}/shots", headers=H, json={"action": action, "framing": "medium"}))["code"])
    with SessionLocal() as db:
        c = _ctx(db, pid, eid)
        # no link between the shots: one job per shot, all at once (as before)
        free = T.run_tool(c, "generate_videos", {"shot_codes": [codes[0], codes[2]]})
        assert free["status"] == "proposed" and free["count"] == 2
        assert {j.type for j in db.query(Job).filter(Job.batch_id == free["batch_id"])} == {"video"}
        ok(client.post(f"/api/batches/{free['batch_id']}/cancel", headers=H))
        # the second shot continues the first: one run makes them wave by wave
        shot_b = c.shots([codes[1]])[0]
        shot_b.continuity_from_prev = True
        db.get(Project, pid).agent_mode = "autopilot"  # run it, within the (mock, free) budget
        db.commit()
        out = T.run_tool(c, "generate_videos", {})
        assert out["status"] == "queued" and out["order"] == [[codes[0], codes[2]], [codes[1]]]
        [job] = db.query(Job).filter(Job.batch_id == out["batch_id"]).all()
        assert job.type == "produce" and job.payload["steps"] == ["videos"] and job.payload["remake"] is False
        assert sorted(job.payload["shot_ids"]) == sorted(s.id for s in c.shots())
    wait_jobs(client, pid, timeout=300)
    with SessionLocal() as db:
        a, b = (db.query(Shot).filter(Shot.episode_id == eid, Shot.code == x).one() for x in codes[:2])
        va, vb, kb = current(db, a.id, "video"), current(db, b.id, "video"), current(db, b.id, "keyframe")
        assert va is not None and vb is not None and db.get(Job, job.id).status == "succeeded"
        assert kb.params.get("continuity_take_id") == va.id  # B's first frame is A's real last frame
        assert vb.created_at >= va.created_at
        assert db.query(Take).filter(Take.shot_id == b.id, Take.kind == "video").count() == 1
