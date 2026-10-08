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
