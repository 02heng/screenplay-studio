"""
小说下载器数据库模块
- 基于 SQLite，存储书籍、章节、下载进度
- 数据目录优先存到 D:/Screenplay-Studio-data/downloads/，回退到 ~/.screenplay-studio/downloads/
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Optional


def _data_dir() -> Path:
    raw = os.environ.get("SCREENPLAY_USER_DATA", "").strip()
    if raw:
        d = Path(raw) / "downloads"
    elif os.name == "nt":
        d = Path("D:/Screenplay-Studio-data/downloads")
    else:
        d = Path.home() / ".screenplay-studio" / "downloads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _db_path() -> Path:
    return _data_dir() / "novels.db"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path()))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db() -> None:
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS books (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT NOT NULL,
            author      TEXT DEFAULT '',
            url         TEXT UNIQUE NOT NULL,
            cover_path  TEXT DEFAULT '',
            added_at    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chapters (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            title         TEXT NOT NULL,
            url           TEXT NOT NULL,
            content       TEXT DEFAULT '',
            chapter_index INTEGER NOT NULL,
            downloaded    INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_chapters_book
            ON chapters(book_id, chapter_index);
    """)
    conn.commit()
    conn.close()


# ── Books ──────────────────────────────────────────────

def add_book(title: str, author: str, url: str) -> int:
    init_db()
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO books(title, author, url, added_at) VALUES(?, ?, ?, ?)",
        (title, author, url, datetime.now().isoformat()),
    )
    book_id = cur.lastrowid
    conn.commit()
    conn.close()
    return book_id


def get_book_by_url(url: str) -> Optional[dict]:
    init_db()
    conn = get_conn()
    row = conn.execute("SELECT * FROM books WHERE url = ?", (url,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_book_by_id(book_id: int) -> Optional[dict]:
    init_db()
    conn = get_conn()
    row = conn.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_all_books() -> list[dict]:
    init_db()
    conn = get_conn()
    rows = conn.execute("SELECT * FROM books ORDER BY added_at DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def search_books(keyword: str) -> list[dict]:
    init_db()
    conn = get_conn()
    like = f"%{keyword}%"
    rows = conn.execute(
        "SELECT * FROM books WHERE title LIKE ? OR author LIKE ? ORDER BY added_at DESC",
        (like, like),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_book(book_id: int) -> None:
    init_db()
    conn = get_conn()
    conn.execute("DELETE FROM books WHERE id = ?", (book_id,))
    conn.commit()
    conn.close()


def reset_all_chapter_contents(book_id: int) -> None:
    """清空该书所有章节正文并标记为未下载（用于重新抓取番茄解密后修复乱码）。"""
    init_db()
    conn = get_conn()
    conn.execute(
        "UPDATE chapters SET content = '', downloaded = 0 WHERE book_id = ?",
        (book_id,),
    )
    conn.commit()
    conn.close()


# ── Chapters ───────────────────────────────────────────

def add_chapters(book_id: int, chapters: list[dict]) -> None:
    """chapters: [{'title': ..., 'url': ..., 'chapter_index': ...}, ...]"""
    init_db()
    conn = get_conn()
    conn.executemany(
        "INSERT OR IGNORE INTO chapters(book_id, title, url, chapter_index) "
        "VALUES(?, ?, ?, ?)",
        [(book_id, c["title"], c["url"], c.get("chapter_index", i))
         for i, c in enumerate(chapters)],
    )
    conn.commit()
    conn.close()


def update_chapter_content(chapter_id: int, content: str) -> None:
    init_db()
    conn = get_conn()
    conn.execute(
        "UPDATE chapters SET content = ?, downloaded = 1 WHERE id = ?",
        (content, chapter_id),
    )
    conn.commit()
    conn.close()


def get_chapters(book_id: int, include_content: bool = False) -> list[dict]:
    init_db()
    conn = get_conn()
    if include_content:
        rows = conn.execute(
            "SELECT * FROM chapters WHERE book_id = ? ORDER BY chapter_index",
            (book_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, book_id, title, url, chapter_index, downloaded "
            "FROM chapters WHERE book_id = ? ORDER BY chapter_index",
            (book_id,),
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_chapter(chapter_id: int) -> Optional[dict]:
    init_db()
    conn = get_conn()
    row = conn.execute("SELECT * FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_book_chapter_count(book_id: int) -> tuple[int, int]:
    """Return (total, downloaded)."""
    init_db()
    conn = get_conn()
    total = conn.execute(
        "SELECT COUNT(*) FROM chapters WHERE book_id = ?", (book_id,)
    ).fetchone()[0]
    downloaded = conn.execute(
        "SELECT COUNT(*) FROM chapters WHERE book_id = ? AND downloaded = 1",
        (book_id,),
    ).fetchone()[0]
    conn.close()
    return total, downloaded


def get_book_content_char_count(book_id: int) -> int:
    init_db()
    conn = get_conn()
    row = conn.execute(
        "SELECT COALESCE(SUM(LENGTH(content)), 0) AS n FROM chapters WHERE book_id = ?",
        (book_id,),
    ).fetchone()
    conn.close()
    return int(row["n"]) if row else 0
