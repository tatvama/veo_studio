"""Tiny auto-migration: create new tables, add new columns, and relax NOT NULL where a column became optional
(SQLite + Postgres). Runs on every start.

Handled changes: new tables, new columns, and nullable-ness relaxed (e.g. comments.user_id became optional for
guest review comments). SQLite can't drop NOT NULL in place, so that table is rebuilt with its data copied over.
"""
from __future__ import annotations

import json

from sqlalchemy import JSON, Boolean, Float, Integer, MetaData, inspect, text

from .db import Base, engine, is_sqlite


def _python_default(col):
    if col.default is None:
        return None
    arg = col.default.arg
    if not callable(arg):
        return arg
    for call in (lambda: arg(None), lambda: arg()):  # SQLAlchemy may or may not wrap the factory
        try:
            return call()
        except TypeError:
            continue
    return None


def _default_sql(col) -> str:
    d = _python_default(col)
    t = col.type
    if isinstance(t, JSON):
        return "'" + json.dumps(d if d is not None else {}).replace("'", "''") + "'"
    if isinstance(t, Boolean):
        v = bool(d)
        return ("1" if v else "0") if is_sqlite() else ("true" if v else "false")
    if isinstance(t, (Integer, Float)):
        return str(d if d is not None else 0) if not col.nullable else ("NULL" if d is None else str(d))
    if d is None:
        return "NULL" if col.nullable else "''"
    return "'" + str(d).replace("'", "''") + "'"


def _rebuild_sqlite_table(conn, table) -> None:
    """Recreate `table` from the current model and copy the rows across (SQLite has no ALTER COLUMN).

    Order follows SQLite's documented recipe (create new → copy → drop old → rename new), so foreign keys in other
    tables keep pointing at the right name."""
    new = table.to_metadata(MetaData(), name=f"_new_{table.name}")
    cols = ", ".join(f'"{c["name"]}"' for c in inspect(conn).get_columns(table.name) if c["name"] in table.columns)
    for (name,) in conn.execute(text("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=:t AND sql IS NOT NULL"),
                                {"t": table.name}).fetchall():
        conn.execute(text(f'DROP INDEX IF EXISTS "{name}"'))  # index names are global: free them for the new table
    new.create(conn)
    conn.execute(text(f'INSERT INTO "{new.name}" ({cols}) SELECT {cols} FROM "{table.name}"'))
    conn.execute(text(f'DROP TABLE "{table.name}"'))
    conn.execute(text(f'ALTER TABLE "{new.name}" RENAME TO "{table.name}"'))
    for (name,) in conn.execute(text("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=:t AND sql IS NOT NULL"),
                                {"t": table.name}).fetchall():
        conn.execute(text(f'DROP INDEX IF EXISTS "{name}"'))  # copies carry the temp name; restore the model's names
    for ix in table.indexes:
        ix.create(conn)


def migrate() -> list[str]:
    from . import models  # noqa: F401  (registers every table on Base.metadata)

    Base.metadata.create_all(bind=engine)
    added: list[str] = []
    relaxed: list[str] = []
    with engine.begin() as conn:
        # Inspect on the connection we alter. A statement first makes SQLite re-check its schema cookie, so a pooled
        # connection never answers PRAGMA table_info from a stale cached schema.
        conn.execute(text("SELECT 1"))
        insp = inspect(conn)
        for table in Base.metadata.sorted_tables:
            info = {c["name"]: c for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in info:
                    continue
                ddl_type = col.type.compile(dialect=engine.dialect)
                default = _default_sql(col)
                null = "" if col.nullable or default == "NULL" else " NOT NULL"
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {ddl_type} DEFAULT {default}{null}'))
                added.append(f"{table.name}.{col.name}")
            tighten = [c.name for c in table.columns
                       if c.name in info and c.nullable and not c.primary_key and not info[c.name]["nullable"]]
            if not tighten:
                continue
            if is_sqlite():
                _rebuild_sqlite_table(conn, table)
            else:
                for name in tighten:
                    conn.execute(text(f'ALTER TABLE "{table.name}" ALTER COLUMN "{name}" DROP NOT NULL'))
            relaxed += [f"{table.name}.{n}" for n in tighten]
    if added:
        print(f"[migrate] added columns: {', '.join(added)}")
    if relaxed:
        print(f"[migrate] made optional: {', '.join(relaxed)}")
    return added + relaxed
