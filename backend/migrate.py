"""
数据库迁移脚本 —— 给现有 SQLite 表补充新增字段，创建缺失的新表。
用法：
    cd backend
    py -3 migrate.py
"""
import sqlite3
from pathlib import Path
import sys
import os

# ── 定位数据库文件 ────────────────────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("SCREENPLAY_USER_DATA", "D:/Screenplay-Studio-data/UserData")

DB_PATH = Path("D:/Screenplay-Studio-data/UserData/studio.db")
if not DB_PATH.exists():
    print(f"[WARN] DB not found at {DB_PATH}, trying default path...")
    # fallback: search
    for candidate in [
        Path.home() / ".screenplay-studio" / "studio.db",
        Path("D:/Screenplay-Studio-data/UserData/studio.db"),
    ]:
        if candidate.exists():
            DB_PATH = candidate
            break

print(f"[INFO] Using DB: {DB_PATH}")

conn = sqlite3.connect(str(DB_PATH))
cur = conn.cursor()


def existing_columns(table: str) -> set[str]:
    cur.execute(f"PRAGMA table_info({table})")
    return {row[1] for row in cur.fetchall()}


def existing_tables() -> set[str]:
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    return {row[0] for row in cur.fetchall()}


def add_column_if_missing(table: str, col: str, col_def: str) -> None:
    cols = existing_columns(table)
    if col not in cols:
        sql = f"ALTER TABLE {table} ADD COLUMN {col} {col_def}"
        cur.execute(sql)
        print(f"  + {table}.{col}")
    else:
        print(f"  . {table}.{col} (already exists)")


# ═══════════════════════════════════════════════════════
# 1. storyboard_shots — 新增字段
# ═══════════════════════════════════════════════════════
print("\n[storyboard_shots]")
tables = existing_tables()
if "storyboard_shots" in tables:
    add_column_if_missing("storyboard_shots", "timecode_in",    "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing("storyboard_shots", "timecode_out",   "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing("storyboard_shots", "duration_sec",   "REAL NOT NULL DEFAULT 3.0")
    add_column_if_missing("storyboard_shots", "shot_content",   "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing("storyboard_shots", "director_intent","TEXT NOT NULL DEFAULT ''")
    add_column_if_missing("storyboard_shots", "camera_params",  "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing("storyboard_shots", "lighting",       "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing("storyboard_shots", "color_tone",     "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing("storyboard_shots", "sound_design",   "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing("storyboard_shots", "subtitle_text",  "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing("storyboard_shots", "frame_images",   "TEXT NOT NULL DEFAULT '[]'")
    add_column_if_missing("storyboard_shots", "video_paths",    "TEXT NOT NULL DEFAULT '[]'")
    add_column_if_missing("storyboard_shots", "audio_path",     "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing("storyboard_shots", "animation_prompt","TEXT NOT NULL DEFAULT ''")
    add_column_if_missing("storyboard_shots", "project_id",     "INTEGER")
    add_column_if_missing("storyboard_shots", "updated_at",     "TEXT")
else:
    print("  [SKIP] table not found")

# ═══════════════════════════════════════════════════════
# 1b. edit_shots — 按集分组剪辑
# ═══════════════════════════════════════════════════════
print("\n[edit_shots]")
if "edit_shots" in tables:
    add_column_if_missing("edit_shots", "ep_number", "INTEGER")
else:
    print("  [SKIP] table not found")

# ═══════════════════════════════════════════════════════
# 2. characters — 三视图字段
# ═══════════════════════════════════════════════════════
print("\n[characters]")
if "characters" in tables:
    add_column_if_missing("characters", "three_view_image_path", "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing("characters", "three_view_status",     "TEXT NOT NULL DEFAULT ''")
    add_column_if_missing("characters", "updated_at",            "TEXT")
else:
    print("  [SKIP] table not found")

# ═══════════════════════════════════════════════════════
# 3. 新建缺失的表
# ═══════════════════════════════════════════════════════

NEW_TABLES = {
    "episodes": """
        CREATE TABLE IF NOT EXISTS episodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id),
            ep_number INTEGER NOT NULL DEFAULT 1,
            title TEXT NOT NULL DEFAULT '',
            core_event TEXT NOT NULL DEFAULT '',
            opening_hook TEXT NOT NULL DEFAULT '',
            ending_hook TEXT NOT NULL DEFAULT '',
            hook_type TEXT NOT NULL DEFAULT '',
            emotion_arc TEXT NOT NULL DEFAULT '',
            special_note TEXT NOT NULL DEFAULT '',
            script_content TEXT NOT NULL DEFAULT '',
            word_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'planned',
            created_at TEXT,
            updated_at TEXT
        )
    """,
    "generation_jobs": """
        CREATE TABLE IF NOT EXISTS generation_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            job_type TEXT NOT NULL DEFAULT '',
            scene_id INTEGER,
            status TEXT NOT NULL DEFAULT 'running',
            total INTEGER NOT NULL DEFAULT 0,
            success INTEGER NOT NULL DEFAULT 0,
            failed INTEGER NOT NULL DEFAULT 0,
            result_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT,
            updated_at TEXT
        )
    """,
    "timelines": """
        CREATE TABLE IF NOT EXISTS timelines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id),
            name TEXT NOT NULL DEFAULT '主时间线',
            fps INTEGER NOT NULL DEFAULT 25,
            resolution TEXT NOT NULL DEFAULT '1080x1920',
            clips_json TEXT NOT NULL DEFAULT '[]',
            subtitles_json TEXT NOT NULL DEFAULT '[]',
            bgm_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'draft',
            export_path TEXT NOT NULL DEFAULT '',
            created_at TEXT,
            updated_at TEXT
        )
    """,
    "edit_shots": """
        CREATE TABLE IF NOT EXISTS edit_shots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id),
            storyboard_shot_id INTEGER REFERENCES storyboard_shots(id),
            order_index INTEGER NOT NULL DEFAULT 0,
            clip_path TEXT,
            in_point REAL NOT NULL DEFAULT 0.0,
            out_point REAL NOT NULL DEFAULT 0.0,
            timecode TEXT NOT NULL DEFAULT '00:00:00:00',
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT
        )
    """,
    "project_snapshots": """
        CREATE TABLE IF NOT EXISTS project_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id),
            label TEXT NOT NULL DEFAULT '',
            snapshot_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT
        )
    """,
}

print("\n[new tables]")
for tbl_name, ddl in NEW_TABLES.items():
    if tbl_name not in tables:
        cur.execute(ddl)
        print(f"  + created: {tbl_name}")
    else:
        print(f"  . exists:  {tbl_name}")

conn.commit()
conn.close()
print("\n[DONE] Migration complete.")
