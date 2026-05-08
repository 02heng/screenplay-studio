"""
改编项目记忆管理器
- 基于 SQLite 记忆宫殿模式（参照 AI-writer/backend/app/memory_store.py）
- 每个项目独立一套记忆，按「房间」分类存储：
  - 原著摘要（synopsis）：小说原文摘要、主要情节点
  - 人物设定（characters）：角色信息、关系、口癖
  - 世界设定（worldbuilding）：背景、规则、地点
  - 改编规则（adaptation）：用户偏好、改编风格
  - 生成历史（episodes）：已生成集数内容摘要
  - 伏笔钩子（hooks）：未解决的悬念、待收的伏笔
"""
from __future__ import annotations

import os
import sqlite3
import time
from enum import Enum
from pathlib import Path
from typing import Any, Optional

DB_NAME = "adaptation_memory.sqlite3"


class MemoryRoom(str, Enum):
    SYNOPSIS = "原著摘要"
    CHARACTERS = "人物设定"
    WORLDBUILDING = "世界设定"
    ADAPTATION = "改编规则"
    EPISODES = "生成历史"
    HOOKS = "伏笔钩子"


def _project_memory_dir(project_id: int) -> Path:
    raw = os.environ.get("SCREENPLAY_USER_DATA", "").strip()
    if raw:
        base = Path(raw)
    elif os.name == "nt":
        base = Path("D:/Screenplay-Studio-data/UserData")
    else:
        base = Path.home() / ".screenplay-studio"

    d = base / "memory" / str(project_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _db_path(project_id: int) -> Path:
    return _project_memory_dir(project_id) / DB_NAME


def _get_conn(project_id: int) -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path(project_id)))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def _init_db(project_id: int) -> None:
    conn = _get_conn(project_id)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS memory_entries (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at    REAL NOT NULL,
            updated_at    REAL NOT NULL,
            room          TEXT NOT NULL,
            title         TEXT NOT NULL,
            body          TEXT NOT NULL,
            episode_label TEXT,
            tags          TEXT DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_mem_room
            ON memory_entries(room, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mem_episode
            ON memory_entries(episode_label);

        CREATE TABLE IF NOT EXISTS project_summary (
            id         INTEGER PRIMARY KEY CHECK (id = 1),
            content    TEXT NOT NULL DEFAULT '',
            updated_at REAL NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO project_summary(id, content, updated_at)
        VALUES(1, '', 0);
    """)
    conn.commit()
    conn.close()


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "room": row["room"],
        "title": row["title"],
        "body": row["body"],
        "episode_label": row["episode_label"],
        "tags": row["tags"],
    }


class MemoryManager:
    """单项目记忆管理器"""

    def __init__(self, project_id: int) -> None:
        self.project_id = project_id
        _init_db(project_id)

    # ── 条目 CRUD ──────────────────────────────────────────────────

    def add_entry(
        self,
        *,
        room: str,
        title: str,
        body: str,
        episode_label: Optional[str] = None,
        tags: str = "",
    ) -> dict[str, Any]:
        ts = time.time()
        conn = _get_conn(self.project_id)
        try:
            conn.execute(
                "INSERT INTO memory_entries "
                "(created_at, updated_at, room, title, body, episode_label, tags) "
                "VALUES (?,?,?,?,?,?,?)",
                (ts, ts, room.strip() or "未分类", title.strip() or "无标题",
                 body.strip(), episode_label, tags),
            )
            conn.commit()
            cur = conn.execute(
                "SELECT * FROM memory_entries WHERE id = last_insert_rowid()"
            )
            row = cur.fetchone()
            return _row_to_dict(row) if row else {}
        finally:
            conn.close()

    def update_entry(
        self,
        entry_id: int,
        *,
        title: Optional[str] = None,
        body: Optional[str] = None,
        episode_label: Optional[str] = None,
        tags: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        ts = time.time()
        conn = _get_conn(self.project_id)
        try:
            row = conn.execute(
                "SELECT * FROM memory_entries WHERE id = ?", (entry_id,)
            ).fetchone()
            if not row:
                return None
            new_title = title if title is not None else row["title"]
            new_body = body if body is not None else row["body"]
            new_episode = episode_label if episode_label is not None else row["episode_label"]
            new_tags = tags if tags is not None else row["tags"]
            conn.execute(
                "UPDATE memory_entries SET title=?, body=?, episode_label=?, tags=?, updated_at=? "
                "WHERE id=?",
                (new_title, new_body, new_episode, new_tags, ts, entry_id),
            )
            conn.commit()
            row2 = conn.execute(
                "SELECT * FROM memory_entries WHERE id = ?", (entry_id,)
            ).fetchone()
            return _row_to_dict(row2) if row2 else None
        finally:
            conn.close()

    def delete_entry(self, entry_id: int) -> bool:
        conn = _get_conn(self.project_id)
        try:
            cur = conn.execute(
                "DELETE FROM memory_entries WHERE id = ?", (entry_id,)
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()

    def list_entries(
        self,
        *,
        room: Optional[str] = None,
        episode_label: Optional[str] = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        conn = _get_conn(self.project_id)
        try:
            if room and episode_label:
                rows = conn.execute(
                    "SELECT * FROM memory_entries WHERE room=? AND episode_label=? "
                    "ORDER BY created_at DESC LIMIT ?",
                    (room, episode_label, limit),
                ).fetchall()
            elif room:
                rows = conn.execute(
                    "SELECT * FROM memory_entries WHERE room=? "
                    "ORDER BY created_at DESC LIMIT ?",
                    (room, limit),
                ).fetchall()
            elif episode_label:
                rows = conn.execute(
                    "SELECT * FROM memory_entries WHERE episode_label=? "
                    "ORDER BY created_at DESC LIMIT ?",
                    (episode_label, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM memory_entries ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [_row_to_dict(r) for r in rows]
        finally:
            conn.close()

    def get_entry(self, entry_id: int) -> Optional[dict[str, Any]]:
        conn = _get_conn(self.project_id)
        try:
            row = conn.execute(
                "SELECT * FROM memory_entries WHERE id = ?", (entry_id,)
            ).fetchone()
            return _row_to_dict(row) if row else None
        finally:
            conn.close()

    # ── 项目总摘要 ────────────────────────────────────────────────

    def read_summary(self) -> str:
        conn = _get_conn(self.project_id)
        try:
            row = conn.execute("SELECT content FROM project_summary WHERE id=1").fetchone()
            return row["content"] if row else ""
        finally:
            conn.close()

    def write_summary(self, content: str) -> None:
        ts = time.time()
        conn = _get_conn(self.project_id)
        try:
            conn.execute(
                "UPDATE project_summary SET content=?, updated_at=? WHERE id=1",
                (content.strip(), ts),
            )
            conn.commit()
        finally:
            conn.close()

    # ── 构建上下文（注入 LLM）────────────────────────────────────

    def build_context(self, *, max_chars: int = 4000) -> str:
        """
        拼接项目总摘要 + 各房间近期条目，供注入 LLM 上下文。
        格式参照 AI-writer 的 build_memory_context。
        """
        parts: list[str] = []

        summary = self.read_summary().strip()
        if summary:
            parts.append("【改编项目记忆 · 总摘要】\n" + summary)

        rooms_priority = [
            MemoryRoom.CHARACTERS,
            MemoryRoom.SYNOPSIS,
            MemoryRoom.HOOKS,
            MemoryRoom.ADAPTATION,
            MemoryRoom.WORLDBUILDING,
            MemoryRoom.EPISODES,
        ]

        for room in rooms_priority:
            entries = self.list_entries(room=room.value, limit=20)
            if not entries:
                continue
            lines = [f"【{room.value}】"]
            for e in entries:
                ep_tag = f"（第{e['episode_label']}集）" if e.get("episode_label") else ""
                lines.append(
                    f"- {e['title']}{ep_tag}\n  {e['body']}"
                )
            parts.append("\n".join(lines))

        text = "\n\n".join(parts).strip()
        if len(text) > max_chars:
            return text[:max_chars - 20] + "\n…（已截断）"
        return text

    # ── 快捷批量写入 ──────────────────────────────────────────────

    def seed_from_novel_info(
        self,
        *,
        title: str,
        author: str,
        synopsis: str,
        characters: Optional[list[dict]] = None,
    ) -> None:
        """从小说基本信息快速填充记忆"""
        self.add_entry(
            room=MemoryRoom.SYNOPSIS.value,
            title=f"原著《{title}》基本信息",
            body=f"书名：{title}\n作者：{author}\n\n梗概：\n{synopsis}",
        )
        if characters:
            for ch in characters:
                name = ch.get("name", "未知")
                desc = ch.get("description", "")
                self.add_entry(
                    room=MemoryRoom.CHARACTERS.value,
                    title=f"人物：{name}",
                    body=desc,
                )
