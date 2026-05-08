from __future__ import annotations

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


def create_db_and_tables() -> None:
    SQLModel.metadata.create_all(engine())


def get_session() -> Generator[Session, None, None]:
    with Session(engine()) as session:
        yield session
