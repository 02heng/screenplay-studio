"""项目版本快照 CRUD"""
from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db.database import get_session
from ..db.models import (
    Character,
    EditShot,
    Episode,
    Project,
    ProjectSnapshot,
    Scene,
    Script,
    StoryboardShot,
    Timeline,
)

router = APIRouter(prefix="/api/projects/{project_id}/snapshots", tags=["snapshots"])


class SnapshotCreate(BaseModel):
    label: str = ""


def _build_snapshot(project_id: int, session: Session) -> dict:
    """聚合项目当前状态为字典"""
    proj = session.get(Project, project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    scripts = session.exec(select(Script).where(Script.project_id == project_id)).all()
    chars = session.exec(select(Character).where(Character.project_id == project_id)).all()
    scenes = session.exec(select(Scene).where(Scene.project_id == project_id)).all()
    scene_ids = [s.id for s in scenes]

    shots: list = []
    for sid in scene_ids:
        shots += session.exec(
            select(StoryboardShot).where(StoryboardShot.scene_id == sid)
        ).all()

    timelines = session.exec(
        select(Timeline).where(Timeline.project_id == project_id)
    ).all()

    edit_shots = session.exec(
        select(EditShot).where(EditShot.project_id == project_id)
    ).all()

    episodes_data: list = []
    try:
        eps = session.exec(
            select(Episode).where(Episode.project_id == project_id)
        ).all()
        episodes_data = [e.model_dump() for e in eps]
    except Exception:  # noqa: BLE001
        pass

    return {
        "project": proj.model_dump(),
        "scripts": [s.model_dump() for s in scripts],
        "characters": [c.model_dump() for c in chars],
        "scenes": [s.model_dump() for s in scenes],
        "shots": [s.model_dump() for s in shots],
        "timelines": [t.model_dump() for t in timelines],
        "edit_shots": [e.model_dump() for e in edit_shots],
        "episodes": episodes_data,
    }


@router.get("")
def list_snapshots(project_id: int, session: Session = Depends(get_session)):
    snaps = session.exec(
        select(ProjectSnapshot)
        .where(ProjectSnapshot.project_id == project_id)
        .order_by(ProjectSnapshot.created_at.desc())  # type: ignore[arg-type]
    ).all()
    return {
        "snapshots": [
            {"id": s.id, "label": s.label, "created_at": s.created_at}
            for s in snaps
        ]
    }


@router.post("", status_code=201)
def create_snapshot(
    project_id: int,
    payload: SnapshotCreate,
    session: Session = Depends(get_session),
):
    data = _build_snapshot(project_id, session)
    snap = ProjectSnapshot(
        project_id=project_id,
        label=payload.label or datetime.utcnow().strftime("%Y-%m-%d %H:%M"),
        snapshot_json=json.dumps(data, ensure_ascii=False, default=str),
    )
    session.add(snap)
    session.commit()
    session.refresh(snap)
    return {"id": snap.id, "label": snap.label, "created_at": snap.created_at}


@router.get("/{snap_id}")
def get_snapshot(
    project_id: int,
    snap_id: int,
    session: Session = Depends(get_session),
):
    snap = session.get(ProjectSnapshot, snap_id)
    if not snap or snap.project_id != project_id:
        raise HTTPException(404, "Snapshot not found")
    return {
        "id": snap.id,
        "label": snap.label,
        "created_at": snap.created_at,
        "data": json.loads(snap.snapshot_json),
    }


@router.delete("/{snap_id}", status_code=204)
def delete_snapshot(
    project_id: int,
    snap_id: int,
    session: Session = Depends(get_session),
):
    snap = session.get(ProjectSnapshot, snap_id)
    if not snap or snap.project_id != project_id:
        raise HTTPException(404, "Snapshot not found")
    session.delete(snap)
    session.commit()
