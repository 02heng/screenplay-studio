from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import (
    Character,
    EditShot,
    Project,
    Scene,
    Script,
    StoryboardShot,
    get_session,
)
from ..paths import project_asset_dir, user_data_dir

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectCreate(BaseModel):
    name: str
    type: str = "feature"
    description: str = ""


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    description: Optional[str] = None


def _project_or_404(pid: int, session: Session) -> Project:
    proj = session.get(Project, pid)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    return proj


@router.get("")
def list_projects(session: Session = Depends(get_session)):
    projects = session.exec(select(Project).order_by(Project.created_at.desc())).all()
    return {"projects": [p.model_dump() for p in projects]}


@router.post("", status_code=201)
def create_project(payload: ProjectCreate, session: Session = Depends(get_session)):
    proj = Project(**payload.model_dump())
    session.add(proj)
    session.commit()
    session.refresh(proj)
    # ensure asset directory exists
    project_asset_dir(proj.id)
    return proj.model_dump()


@router.get("/{project_id}")
def get_project(project_id: int, session: Session = Depends(get_session)):
    return _project_or_404(project_id, session).model_dump()


@router.patch("/{project_id}")
def update_project(
    project_id: int,
    payload: ProjectUpdate,
    session: Session = Depends(get_session),
):
    proj = _project_or_404(project_id, session)
    data = payload.model_dump(exclude_none=True)
    for k, v in data.items():
        setattr(proj, k, v)
    proj.updated_at = datetime.utcnow()
    session.add(proj)
    session.commit()
    session.refresh(proj)
    return proj.model_dump()


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int, session: Session = Depends(get_session)):
    _project_or_404(project_id, session)
    # 子表有外键引用 project（及场景/分镜），需先删子行，避免约束失败或孤儿数据
    for row in session.exec(select(EditShot).where(EditShot.project_id == project_id)).all():
        session.delete(row)
    for row in session.exec(select(StoryboardShot).where(StoryboardShot.project_id == project_id)).all():
        session.delete(row)
    for row in session.exec(select(Scene).where(Scene.project_id == project_id)).all():
        session.delete(row)
    for row in session.exec(select(Character).where(Character.project_id == project_id)).all():
        session.delete(row)
    for row in session.exec(select(Script).where(Script.project_id == project_id)).all():
        session.delete(row)
    proj = session.get(Project, project_id)
    if proj:
        session.delete(proj)
    session.commit()

    asset_dir = project_asset_dir(project_id)
    if asset_dir.exists():
        shutil.rmtree(asset_dir, ignore_errors=True)

    memory_dir = user_data_dir() / "memory" / str(project_id)
    if memory_dir.exists():
        shutil.rmtree(memory_dir, ignore_errors=True)


@router.post("/{project_id}/cover")
def upload_cover(
    project_id: int,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
):
    proj = _project_or_404(project_id, session)
    asset_dir = project_asset_dir(project_id)
    dest = asset_dir / f"cover{Path(file.filename or '.jpg').suffix}"
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    proj.cover_image = str(dest)
    proj.updated_at = datetime.utcnow()
    session.add(proj)
    session.commit()
    return {"cover_image": str(dest)}
