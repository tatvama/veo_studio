"""Tiny auto-migration: create new tables, add new columns, and relax NOT NULL where a column became optional
(SQLite + Postgres). Runs on every start.

Handled changes: new tables, new columns, indexes added to a table after it first shipped, longer strings (Postgres;
SQLite ignores lengths), and nullable-ness relaxed (e.g. comments.user_id became optional for guest review comments).
SQLite can't drop NOT NULL in place, so that table is rebuilt with its data copied over (with foreign keys switched
off for the copy, so a parent table with child rows can be rebuilt too).
"""
from __future__ import annotations

import json

from sqlalchemy import JSON, Boolean, Float, Integer, MetaData, String, inspect, text

from .db import Base, SessionLocal, engine, is_sqlite


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
    tables keep pointing at the right name. The caller has foreign keys switched off: with them on, dropping a table
    that other tables' rows point at fails ("FOREIGN KEY constraint failed")."""
    meta = MetaData()  # with the tables this one points at, so its FOREIGN KEY clauses can be written out
    for t in table.metadata.sorted_tables:
        if t is not table:
            t.to_metadata(meta)
    new = table.to_metadata(meta, name=f"_new_{table.name}")
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


def _rebuild_sqlite_tables(tables: list) -> None:
    """Rebuild these tables on a connection of their own. `PRAGMA foreign_keys` is a no-op inside a transaction, so
    the connection runs in autocommit mode: foreign keys off, one explicit transaction around all the rebuilds, a
    `foreign_key_check` before the commit, and foreign keys back on before the connection returns to the pool."""
    with engine.connect() as conn:
        conn = conn.execution_options(isolation_level="AUTOCOMMIT")
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
        try:
            conn.exec_driver_sql("BEGIN")
            try:
                for table in tables:
                    _rebuild_sqlite_table(conn, table)
                bad = conn.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
                if bad:
                    raise RuntimeError(f"foreign keys broken after rebuilding {[t.name for t in tables]}: {bad[:5]}")
                conn.exec_driver_sql("COMMIT")
            except Exception:
                conn.exec_driver_sql("ROLLBACK")
                raise
        finally:
            conn.exec_driver_sql("PRAGMA foreign_keys=ON")


def _missing_indexes(insp, table) -> list:
    """The model's indexes this database doesn't have yet (by name, or by the same columns under another name)."""
    have = insp.get_indexes(table.name)
    names = {ix["name"] for ix in have}
    cols = {tuple(ix["column_names"]) for ix in have}
    return [ix for ix in table.indexes
            if ix.name not in names and tuple(c.name for c in ix.columns) not in cols]


def _backfill(added: list[str]) -> None:
    """Values for new columns that older rows kept somewhere else."""
    from .models import Project
    with SessionLocal() as db:
        n = 0
        for p in db.query(Project).filter(Project.type == "edit", Project.edit_id.is_(None)).all():
            eid = (p.brief or {}).get("edit_id")  # api/edits.py kept the edit's id only in the brief before projects.edit_id
            if eid:
                p.edit_id = str(eid)[:80]
                n += 1
        db.commit()
    if n:
        added.append(f"projects.edit_id <- brief ({n} rows)")


def migrate() -> list[str]:
    from . import models  # noqa: F401  (registers every table on Base.metadata)

    Base.metadata.create_all(bind=engine)
    added: list[str] = []
    relaxed: list[str] = []
    indexed: list[str] = []
    rebuild: list = []  # SQLite tables whose NOT NULL must go (rebuilt after this transaction, see _rebuild_sqlite_tables)
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
            if not is_sqlite():  # a longer String(n) in the model widens the column (SQLite ignores lengths)
                for col in table.columns:
                    have = getattr(info.get(col.name, {}).get("type"), "length", None)
                    want = getattr(col.type, "length", None)
                    if isinstance(col.type, String) and have and want and want > have:
                        conn.execute(text(f'ALTER TABLE "{table.name}" ALTER COLUMN "{col.name}" TYPE VARCHAR({want})'))
                        added.append(f"{table.name}.{col.name} → {want} chars")
            tighten = [c.name for c in table.columns
                       if c.name in info and c.nullable and not c.primary_key and not info[c.name]["nullable"]]
            if tighten:
                if is_sqlite():
                    rebuild.append(table)  # the rebuild recreates every index of the table as well
                else:
                    for name in tighten:
                        conn.execute(text(f'ALTER TABLE "{table.name}" ALTER COLUMN "{name}" DROP NOT NULL'))
                relaxed += [f"{table.name}.{n}" for n in tighten]
            if table not in rebuild:  # indexes added to the model after the table first shipped
                for ix in _missing_indexes(insp, table):
                    ix.create(conn)
                    indexed.append(f"{table.name}.{ix.name}")
    if rebuild:
        _rebuild_sqlite_tables(rebuild)
    _backfill(added)
    if added:
        print(f"[migrate] added columns: {', '.join(added)}")
    if relaxed:
        print(f"[migrate] made optional: {', '.join(relaxed)}")
    if indexed:
        print(f"[migrate] added indexes: {', '.join(indexed)}")
    return added + relaxed + indexed
