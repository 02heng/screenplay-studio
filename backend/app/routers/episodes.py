from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session, Episode

router = APIRouter(prefix="/api/projects/{project_id}/episodes", tags=["episodes"])


class EpisodeCreate(BaseModel):
    ep_number: int = 1
    title: str = ""
    core_event: str = ""
    opening_hook: str = ""
    ending_hook: str = ""
    hook_type: str = ""
    emotion_arc: str = ""
    special_note: str = ""
    script_content: str = ""
    word_count: int = 0
    status: str = "planned"


class EpisodeUpdate(BaseModel):
    ep_number: Optional[int] = None
    title: Optional[str] = None
    core_event: Optional[str] = None
    opening_hook: Optional[str] = None
    ending_hook: Optional[str] = None
    hook_type: Optional[str] = None
    emotion_arc: Optional[str] = None
    special_note: Optional[str] = None
    script_content: Optional[str] = None
    word_count: Optional[int] = None
    status: Optional[str] = None


class BulkEpisodesPayload(BaseModel):
    episodes: list[EpisodeCreate]


def _ep_or_404(ep_id: int, project_id: int, session: Session) -> Episode:
    ep = session.get(Episode, ep_id)
    if not ep or ep.project_id != project_id:
        raise HTTPException(status_code=404, detail="Episode not found")
    return ep


def _text(v: str | None) -> str:
    return (v or "").strip()


def _choose_episode_keeper(group: list[Episode]) -> Episode:
    """同集多条时保留：优先剧本最长的一条，否则 id 最小。"""
    with_script = [e for e in group if _text(e.script_content)]
    if with_script:
        return max(with_script, key=lambda e: len(_text(e.script_content)))
    return min(group, key=lambda e: e.id or 0)


def _absorb_episode_fields(keeper: Episode, other: Episode) -> None:
    """将 other 的非空字段并入 keeper（不覆盖 keeper 已有更长正文）。"""
    for attr in (
        "title",
        "core_event",
        "opening_hook",
        "ending_hook",
        "hook_type",
        "emotion_arc",
        "special_note",
    ):
        ov = _text(getattr(other, attr))
        kv = _text(getattr(keeper, attr))
        if ov and (not kv or len(ov) > len(kv)):
            setattr(keeper, attr, getattr(other, attr))
    ok_sc = _text(keeper.script_content)
    oo_sc = _text(other.script_content)
    if oo_sc and len(oo_sc) > len(ok_sc):
        keeper.script_content = other.script_content
        keeper.word_count = other.word_count or len(oo_sc)
    st_ord = {"planned": 0, "scripted": 1, "storyboarded": 2, "done": 3}
    if st_ord.get(other.status, 0) > st_ord.get(keeper.status, 0):
        keeper.status = other.status
    elif oo_sc and not ok_sc:
        keeper.status = "scripted"


def _apply_bulk_item_to_episode(ep: Episode, item: EpisodeCreate) -> None:
    """流水线批量导入：规划字段以本次非空为准；仅当导入带正文时才覆盖 script_content。"""
    d = item.model_dump()
    for key in (
        "title",
        "core_event",
        "opening_hook",
        "ending_hook",
        "hook_type",
        "emotion_arc",
        "special_note",
    ):
        v = d.get(key)
        if isinstance(v, str) and v.strip():
            setattr(ep, key, v.strip())
    sc = d.get("script_content")
    if isinstance(sc, str) and sc.strip():
        t = sc.strip()
        ep.script_content = t
        wc = d.get("word_count")
        ep.word_count = int(wc) if isinstance(wc, int) and wc > 0 else len(t)
        ep.status = "scripted"
    ep.updated_at = datetime.utcnow()


@router.get("")
def list_episodes(project_id: int, session: Session = Depends(get_session)):
    eps = session.exec(
        select(Episode)
        .where(Episode.project_id == project_id)
        .order_by(Episode.ep_number)
    ).all()
    return {"episodes": [ep.model_dump() for ep in eps]}


@router.post("", status_code=201)
def create_episode(
    project_id: int,
    payload: EpisodeCreate,
    session: Session = Depends(get_session),
):
    ep = Episode(project_id=project_id, **payload.model_dump())
    session.add(ep)
    session.commit()
    session.refresh(ep)
    return ep.model_dump()


@router.patch("/{ep_id}")
def update_episode(
    project_id: int,
    ep_id: int,
    payload: EpisodeUpdate,
    session: Session = Depends(get_session),
):
    ep = _ep_or_404(ep_id, project_id, session)
    for k, v in payload.model_dump(exclude_none=True).items():
        setattr(ep, k, v)
    ep.updated_at = datetime.utcnow()
    session.add(ep)
    session.commit()
    session.refresh(ep)
    return ep.model_dump()


@router.delete("/{ep_id}", status_code=204)
def delete_episode(project_id: int, ep_id: int, session: Session = Depends(get_session)):
    ep = _ep_or_404(ep_id, project_id, session)
    session.delete(ep)
    session.commit()


@router.post("/bulk", status_code=200)
def bulk_upsert_episodes(
    project_id: int,
    payload: BulkEpisodesPayload,
    session: Session = Depends(get_session),
):
    """按 ep_number 更新或新建；若库内已有同集多条则先合并为一条再应用导入。"""
    created = 0
    updated = 0
    out_rows: list[dict] = []
    for item in payload.episodes:
        existing = session.exec(
            select(Episode).where(
                Episode.project_id == project_id,
                Episode.ep_number == item.ep_number,
            )
        ).all()
        if not existing:
            ep = Episode(project_id=project_id, **item.model_dump())
            session.add(ep)
            session.flush()
            out_rows.append(ep.model_dump())
            created += 1
            continue
        keeper = _choose_episode_keeper(existing)
        for d in existing:
            if d.id != keeper.id:
                _absorb_episode_fields(keeper, d)
                session.delete(d)
        _apply_bulk_item_to_episode(keeper, item)
        session.add(keeper)
        session.flush()
        out_rows.append(keeper.model_dump())
        updated += 1
    session.commit()
    return {
        "episodes": out_rows,
        "count": len(out_rows),
        "created": created,
        "updated": updated,
    }


@router.post("/deduplicate", status_code=200)
def deduplicate_episodes(project_id: int, session: Session = Depends(get_session)):
    """将同一项目下相同 ep_number 的多行合并为一行（保留剧本最长者，其余字段取非空补全）。"""
    all_eps = session.exec(select(Episode).where(Episode.project_id == project_id)).all()
    by_num: dict[int, list[Episode]] = {}
    for ep in all_eps:
        by_num.setdefault(ep.ep_number, []).append(ep)
    removed = 0
    merged_groups = 0
    for group in by_num.values():
        if len(group) <= 1:
            continue
        merged_groups += 1
        keeper = _choose_episode_keeper(group)
        for other in group:
            if other.id == keeper.id:
                continue
            _absorb_episode_fields(keeper, other)
            session.delete(other)
            removed += 1
        keeper.updated_at = datetime.utcnow()
        session.add(keeper)
    session.commit()
    return {"merged_groups": merged_groups, "removed_rows": removed}
