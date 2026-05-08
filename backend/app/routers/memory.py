"""
改编项目记忆 API 路由
提供项目级记忆的 CRUD 和上下文构建功能
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.memory.memory_manager import MemoryManager, MemoryRoom

router = APIRouter(prefix="/api/projects/{project_id}/memory", tags=["memory"])


def _mgr(project_id: int) -> MemoryManager:
    return MemoryManager(project_id)


# ── Pydantic 模型 ──────────────────────────────────────────────────

class EntryCreate(BaseModel):
    room: str
    title: str
    body: str
    episode_label: Optional[str] = None
    tags: str = ""


class EntryUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    episode_label: Optional[str] = None
    tags: Optional[str] = None


class SummaryWrite(BaseModel):
    content: str


class SeedFromNovel(BaseModel):
    title: str
    author: str
    synopsis: str
    characters: Optional[list[dict]] = None


# ── API 端点 ───────────────────────────────────────────────────────

@router.get("/rooms")
def list_rooms(project_id: int):
    """列出所有记忆房间及其条目数"""
    mgr = _mgr(project_id)
    result = []
    for room in MemoryRoom:
        entries = mgr.list_entries(room=room.value, limit=1000)
        result.append({
            "id": room.name.lower(),
            "name": room.value,
            "count": len(entries),
        })
    return {"rooms": result}


@router.get("/entries")
def list_entries(
    project_id: int,
    room: Optional[str] = None,
    episode_label: Optional[str] = None,
    limit: int = 100,
):
    """获取记忆条目列表"""
    mgr = _mgr(project_id)
    entries = mgr.list_entries(room=room, episode_label=episode_label, limit=limit)
    return {"entries": entries}


@router.post("/entries", status_code=201)
def create_entry(project_id: int, payload: EntryCreate):
    """新建记忆条目"""
    mgr = _mgr(project_id)
    entry = mgr.add_entry(
        room=payload.room,
        title=payload.title,
        body=payload.body,
        episode_label=payload.episode_label,
        tags=payload.tags,
    )
    return entry


@router.get("/entries/{entry_id}")
def get_entry(project_id: int, entry_id: int):
    """获取单条记忆"""
    mgr = _mgr(project_id)
    entry = mgr.get_entry(entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="记忆条目不存在")
    return entry


@router.patch("/entries/{entry_id}")
def update_entry(project_id: int, entry_id: int, payload: EntryUpdate):
    """更新记忆条目"""
    mgr = _mgr(project_id)
    entry = mgr.update_entry(
        entry_id,
        title=payload.title,
        body=payload.body,
        episode_label=payload.episode_label,
        tags=payload.tags,
    )
    if not entry:
        raise HTTPException(status_code=404, detail="记忆条目不存在")
    return entry


@router.delete("/entries/{entry_id}", status_code=204)
def delete_entry(project_id: int, entry_id: int):
    """删除记忆条目"""
    mgr = _mgr(project_id)
    ok = mgr.delete_entry(entry_id)
    if not ok:
        raise HTTPException(status_code=404, detail="记忆条目不存在")


@router.get("/summary")
def get_summary(project_id: int):
    """获取项目总摘要"""
    mgr = _mgr(project_id)
    return {"content": mgr.read_summary()}


@router.put("/summary")
def write_summary(project_id: int, payload: SummaryWrite):
    """更新项目总摘要"""
    mgr = _mgr(project_id)
    mgr.write_summary(payload.content)
    return {"ok": True, "content": payload.content}


@router.get("/context")
def build_context(project_id: int, max_chars: int = 4000):
    """构建 LLM 注入用的记忆上下文"""
    mgr = _mgr(project_id)
    context = mgr.build_context(max_chars=max_chars)
    return {"context": context, "length": len(context)}


@router.post("/seed-from-novel")
def seed_from_novel(project_id: int, payload: SeedFromNovel):
    """从小说基本信息快速填充记忆"""
    mgr = _mgr(project_id)
    mgr.seed_from_novel_info(
        title=payload.title,
        author=payload.author,
        synopsis=payload.synopsis,
        characters=payload.characters,
    )
    return {"ok": True, "message": f"已从《{payload.title}》填充记忆"}
