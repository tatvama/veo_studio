"""Upgrading a v1 database: columns that became optional (comments.user_id, for guest review comments) are relaxed
in place and the rows survive. On SQLite that means rebuilding the table."""
from __future__ import annotations

from sqlalchemy import inspect, text

from app.db import engine, is_sqlite
from app.db_migrate import migrate


def test_relax_not_null_keeps_rows(client):
    if not is_sqlite():
        return
    with engine.begin() as conn:  # put the table back to its v1 shape: user_id NOT NULL, no v2 columns
        conn.execute(text("DROP TABLE comments"))
        conn.execute(text(
            "CREATE TABLE comments (id INTEGER PRIMARY KEY, project_id INTEGER, target_type VARCHAR(20), target_id INTEGER, "
            "user_id INTEGER NOT NULL, body TEXT, mentions JSON, resolved BOOLEAN, created_at DATETIME)"))
        conn.execute(text("CREATE INDEX ix_comments_project_id ON comments (project_id)"))
        conn.execute(text("INSERT INTO comments (project_id, target_type, target_id, user_id, body, mentions, resolved, created_at) "
                          "VALUES (1, 'shot', 1, 1, 'keep me', '[]', 0, '2026-01-01 00:00:00')"))
    changed = migrate()
    assert "comments.user_id" in changed and "comments.guest_name" in changed
    assert migrate() == []  # idempotent
    cols = {c["name"]: c for c in inspect(engine).get_columns("comments")}
    assert cols["user_id"]["nullable"] and "timecode" in cols and "drawing" in cols
    with engine.begin() as conn:
        assert conn.execute(text("SELECT body FROM comments")).scalar() == "keep me"
        conn.execute(text("INSERT INTO comments (project_id, target_type, target_id, user_id, guest_name, body, drawing, "
                          "mentions, resolved, created_at) VALUES (1, 'export', 1, NULL, 'Client', 'guest note', '[]', '[]', 0, "
                          "'2026-01-01 00:00:00')"))
        names = [r[0] for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='comments'"))]
        assert "ix_comments_project_id" in names
        conn.execute(text("DELETE FROM comments"))


def test_indexes_added_later_are_created_on_existing_databases(client):
    """An index put on a column after the table first shipped (jobs.type here) is missing from a database made before
    it; migrate adds it, on both SQLite and Postgres (only the SQLite rebuild path created indexes before)."""
    with engine.begin() as conn:
        conn.execute(text("DROP INDEX ix_jobs_type"))
    assert "ix_jobs_type" not in {ix["name"] for ix in inspect(engine).get_indexes("jobs")}
    changed = migrate()
    assert "jobs.ix_jobs_type" in changed
    have = {ix["name"]: ix for ix in inspect(engine).get_indexes("jobs")}
    assert have["ix_jobs_type"]["column_names"] == ["type"]
    assert migrate() == []  # idempotent: nothing is created twice


def test_sqlite_rebuild_of_a_parent_table_keeps_its_children(client, tmp_path, monkeypatch):
    """Relaxing a NOT NULL on SQLite rebuilds the table (drop + rename). With foreign keys enforced inside the migration
    transaction that failed for a table other rows point at ("FOREIGN KEY constraint failed"): scenes with shots here.
    The rebuild runs with foreign keys off and checks them before committing; the shot still points at its scene.
    On a database of its own (with the app's foreign_keys=ON pragma), so the shared test database stays as it is."""
    if not is_sqlite():
        return
    from sqlalchemy import create_engine, event
    from sqlalchemy.orm import sessionmaker

    from app import db_migrate
    from app.db import Base
    from app.models import Episode, Project, Scene, Shot

    eng = create_engine(f"sqlite:///{(tmp_path / 'rebuild.db').as_posix()}", future=True)

    @event.listens_for(eng, "connect")
    def _fk_on(dbapi_conn, _):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    monkeypatch.setattr(db_migrate, "engine", eng)
    monkeypatch.setattr(db_migrate, "SessionLocal", sessionmaker(bind=eng, expire_on_commit=False))
    Base.metadata.create_all(bind=eng)
    with sessionmaker(bind=eng)() as db:
        p = Project(title="Rebuild parent")
        db.add(p)
        db.flush()
        ep = Episode(project_id=p.id, number=1, title="E1")
        db.add(ep)
        db.flush()
        sc = Scene(episode_id=ep.id, order=1, title="Kitchen")
        db.add(sc)
        db.flush()
        sh = Shot(episode_id=ep.id, scene_id=sc.id, order=1, code="R-1")
        db.add(sh)
        db.flush()
        sc.anchor_shot_id = sh.id
        db.commit()
        scene_id, shot_id = sc.id, sh.id
    # put `scenes` back to an "older" shape where anchor_shot_id was NOT NULL
    with eng.connect() as conn:
        conn = conn.execution_options(isolation_level="AUTOCOMMIT")
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
        (ddl,) = conn.exec_driver_sql("SELECT sql FROM sqlite_master WHERE type='table' AND name='scenes'").one()
        assert "anchor_shot_id INTEGER" in ddl and "anchor_shot_id INTEGER NOT NULL" not in ddl
        conn.exec_driver_sql("CREATE TABLE _keep_scenes AS SELECT * FROM scenes")
        conn.exec_driver_sql("DROP TABLE scenes")
        conn.exec_driver_sql(ddl.replace("anchor_shot_id INTEGER", "anchor_shot_id INTEGER NOT NULL", 1))
        conn.exec_driver_sql("INSERT INTO scenes SELECT * FROM _keep_scenes")
        conn.exec_driver_sql("DROP TABLE _keep_scenes")
        conn.exec_driver_sql("PRAGMA foreign_keys=ON")
    assert not {c["name"]: c for c in inspect(eng).get_columns("scenes")}["anchor_shot_id"]["nullable"]
    with eng.begin() as conn:  # the shot's row does point at the scene: a plain DROP TABLE scenes would be refused
        assert conn.execute(text("PRAGMA foreign_keys")).scalar() == 1
    changed = db_migrate.migrate()
    assert "scenes.anchor_shot_id" in changed and db_migrate.migrate() == []
    cols = {c["name"]: c for c in inspect(eng).get_columns("scenes")}
    assert cols["anchor_shot_id"]["nullable"]
    assert "ix_scenes_episode_id" in {ix["name"] for ix in inspect(eng).get_indexes("scenes")}
    with eng.begin() as conn:
        assert conn.execute(text("PRAGMA foreign_key_check")).fetchall() == []
        assert conn.execute(text("SELECT scene_id FROM shots WHERE id=:i"), {"i": shot_id}).scalar() == scene_id
        assert conn.execute(text("SELECT title, anchor_shot_id FROM scenes WHERE id=:i"), {"i": scene_id}).one() == ("Kitchen", shot_id)
        assert conn.execute(text("PRAGMA foreign_keys")).scalar() == 1  # enforcement is back on for pooled connections
    eng.dispose()
