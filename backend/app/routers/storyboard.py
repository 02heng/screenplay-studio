from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session, Scene, StoryboardShot, EditShot

router = APIRouter(tags=["storyboard"])

# ── Scenes ────────────────────────────────────────────────────────────────────

scene_router = APIRouter(prefix="/api/projects/{project_id}/scenes")


class SceneCreate(BaseModel):
    scene_number: int = 1
    location: str = ""
    time_of_day: str = ""
    description: str = ""
    script_id: Optional[int] = None


class SceneUpdate(BaseModel):
    scene_number: Optional[int] = None
    location: Optional[str] = None
    time_of_day: Optional[str] = None
    description: Optional[str] = None


def _scene_or_404(scene_id: int, project_id: int, session: Session) -> Scene:
    s = session.get(Scene, scene_id)
    if not s or s.project_id != project_id:
        raise HTTPException(status_code=404, detail="Scene not found")
    return s


@scene_router.get("")
def list_scenes(project_id: int, session: Session = Depends(get_session)):
    scenes = session.exec(
        select(Scene).where(Scene.project_id == project_id).order_by(Scene.scene_number)
    ).all()
    return {"scenes": [s.model_dump() for s in scenes]}


@scene_router.post("", status_code=201)
def create_scene(project_id: int, payload: SceneCreate, session: Session = Depends(get_session)):
    scene = Scene(project_id=project_id, **payload.model_dump())
    session.add(scene)
    session.commit()
    session.refresh(scene)
    return scene.model_dump()


@scene_router.patch("/{scene_id}")
def update_scene(
    project_id: int,
    scene_id: int,
    payload: SceneUpdate,
    session: Session = Depends(get_session),
):
    scene = _scene_or_404(scene_id, project_id, session)
    for k, v in payload.model_dump(exclude_none=True).items():
        setattr(scene, k, v)
    session.add(scene)
    session.commit()
    session.refresh(scene)
    return scene.model_dump()


@scene_router.delete("/{scene_id}", status_code=204)
def delete_scene(project_id: int, scene_id: int, session: Session = Depends(get_session)):
    scene = _scene_or_404(scene_id, project_id, session)
    session.delete(scene)
    session.commit()


# ── Storyboard shots ──────────────────────────────────────────────────────────

shot_router = APIRouter(prefix="/api/projects/{project_id}/scenes/{scene_id}/shots")


class ShotCreate(BaseModel):
    shot_number: int = 1
    shot_type: str = ""
    camera_movement: str = ""
    action: str = ""
    dialogue: str = ""
    ai_prompt: str = ""
    animation_prompt: str = ""
    duration_sec: float = 3.0


class ShotUpdate(BaseModel):
    shot_number: Optional[int] = None
    shot_type: Optional[str] = None
    camera_movement: Optional[str] = None
    action: Optional[str] = None
    dialogue: Optional[str] = None
    ai_prompt: Optional[str] = None
    animation_prompt: Optional[str] = None
    image_path: Optional[str] = None
    video_path: Optional[str] = None
    duration_sec: Optional[float] = None


def _shot_or_404(shot_id: int, scene_id: int, project_id: int, session: Session) -> StoryboardShot:
    shot = session.get(StoryboardShot, shot_id)
    if not shot or shot.scene_id != scene_id or shot.project_id != project_id:
        raise HTTPException(status_code=404, detail="Shot not found")
    return shot


@shot_router.get("")
def list_shots(project_id: int, scene_id: int, session: Session = Depends(get_session)):
    shots = session.exec(
        select(StoryboardShot)
        .where(StoryboardShot.scene_id == scene_id, StoryboardShot.project_id == project_id)
        .order_by(StoryboardShot.shot_number)
    ).all()
    return {"shots": [s.model_dump() for s in shots]}


@shot_router.post("", status_code=201)
def create_shot(
    project_id: int,
    scene_id: int,
    payload: ShotCreate,
    session: Session = Depends(get_session),
):
    shot = StoryboardShot(project_id=project_id, scene_id=scene_id, **payload.model_dump())
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return shot.model_dump()


@shot_router.patch("/{shot_id}")
def update_shot(
    project_id: int,
    scene_id: int,
    shot_id: int,
    payload: ShotUpdate,
    session: Session = Depends(get_session),
):
    shot = _shot_or_404(shot_id, scene_id, project_id, session)
    for k, v in payload.model_dump(exclude_none=True).items():
        setattr(shot, k, v)
    shot.updated_at = datetime.utcnow()
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return shot.model_dump()


@shot_router.delete("/{shot_id}", status_code=204)
def delete_shot(
    project_id: int,
    scene_id: int,
    shot_id: int,
    session: Session = Depends(get_session),
):
    shot = _shot_or_404(shot_id, scene_id, project_id, session)
    session.delete(shot)
    session.commit()


# ── Edit shots (cut list) ─────────────────────────────────────────────────────

edit_router = APIRouter(prefix="/api/projects/{project_id}/edit-shots")


class EditShotCreate(BaseModel):
    storyboard_shot_id: Optional[int] = None
    order_index: int = 0
    clip_path: Optional[str] = None
    in_point: float = 0.0
    out_point: float = 0.0
    timecode: str = "00:00:00:00"
    note: str = ""


class EditShotUpdate(BaseModel):
    order_index: Optional[int] = None
    clip_path: Optional[str] = None
    in_point: Optional[float] = None
    out_point: Optional[float] = None
    timecode: Optional[str] = None
    note: Optional[str] = None


@edit_router.get("")
def list_edit_shots(project_id: int, session: Session = Depends(get_session)):
    shots = session.exec(
        select(EditShot).where(EditShot.project_id == project_id).order_by(EditShot.order_index)
    ).all()
    return {"edit_shots": [s.model_dump() for s in shots]}


@edit_router.post("", status_code=201)
def create_edit_shot(project_id: int, payload: EditShotCreate, session: Session = Depends(get_session)):
    shot = EditShot(project_id=project_id, **payload.model_dump())
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return shot.model_dump()


@edit_router.patch("/{shot_id}")
def update_edit_shot(
    project_id: int,
    shot_id: int,
    payload: EditShotUpdate,
    session: Session = Depends(get_session),
):
    shot = session.get(EditShot, shot_id)
    if not shot or shot.project_id != project_id:
        raise HTTPException(status_code=404, detail="Edit shot not found")
    for k, v in payload.model_dump(exclude_none=True).items():
        setattr(shot, k, v)
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return shot.model_dump()


@edit_router.delete("/{shot_id}", status_code=204)
def delete_edit_shot(project_id: int, shot_id: int, session: Session = Depends(get_session)):
    shot = session.get(EditShot, shot_id)
    if not shot or shot.project_id != project_id:
        raise HTTPException(status_code=404, detail="Edit shot not found")
    session.delete(shot)
    session.commit()


@edit_router.get("/export/csv")
def export_csv(project_id: int, session: Session = Depends(get_session)):
    shots = session.exec(
        select(EditShot).where(EditShot.project_id == project_id).order_by(EditShot.order_index)
    ).all()
    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=["order_index", "timecode", "clip_path", "in_point", "out_point", "note"],
    )
    writer.writeheader()
    for s in shots:
        writer.writerow({
            "order_index": s.order_index,
            "timecode": s.timecode,
            "clip_path": s.clip_path or "",
            "in_point": s.in_point,
            "out_point": s.out_point,
            "note": s.note,
        })
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=edit_script_{project_id}.csv"},
    )
