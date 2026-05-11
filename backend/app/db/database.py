from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Generator

from sqlmodel import Session, SQLModel, create_engine

from ..paths import user_data_dir

_engine_instance = None


def _db_path() -> Path:
    db_dir = user_data_dir()
    db_dir.mkdir(parents=True, exist_ok=True)
    return db_dir / "studio.db"


def engine():
    global _engine_instance
    if _engine_instance is None:
        url = f"sqlite:///{_db_path()}"
        _engine_instance = create_engine(url, connect_args={"check_same_thread": False})
    return _engine_instance


def _sqlite_existing_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {r[1] for r in rows}


def _ensure_sqlite_migrations() -> None:
    """SQLModel.metadata.create_all 不会给已有表加列；在此处补齐 ORM 已定义但库里缺失的列。"""
    path = _db_path()
    if not path.exists():
        return
    conn = sqlite3.connect(str(path))
    try:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='edit_shots'"
        ).fetchone()
        if not row:
            return
        cols = _sqlite_existing_columns(conn, "edit_shots")
        if "ep_number" not in cols:
            conn.execute("ALTER TABLE edit_shots ADD COLUMN ep_number INTEGER")
            conn.commit()
        conn.execute(
            "CREATE INDEX IF NOT EXISTS ix_edit_shots_ep_number ON edit_shots (ep_number)"
        )
        conn.commit()
    finally:
        conn.close()


def create_db_and_tables() -> None:
    SQLModel.metadata.create_all(engine())
    _ensure_sqlite_migrations()


def get_session() -> Generator[Session, None, None]:
    with Session(engine()) as session:
        yield session
