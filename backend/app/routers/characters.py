from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session, Character
from ..paths import project_asset_dir

router = APIRouter(prefix="/api/projects/{project_id}/characters", tags=["characters"])


class CharacterCreate(BaseModel):
    name: str
    description: str = ""
    ai_prompt: str = ""


class CharacterUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    ai_prompt: Optional[str] = None
    three_view_image_path: Optional[str] = None
    three_view_status: Optional[str] = None


def _char_or_404(char_id: int, project_id: int, session: Session) -> Character:
    c = session.get(Character, char_id)
    if not c or c.project_id != project_id:
        raise HTTPException(status_code=404, detail="Character not found")
    return c


@router.get("")
def list_characters(project_id: int, session: Session = Depends(get_session)):
    chars = session.exec(
        select(Character).where(Character.project_id == project_id).order_by(Character.created_at)
    ).all()
    return {"characters": [_char_dict(c) for c in chars]}


@router.post("", status_code=201)
def create_character(
    project_id: int,
    payload: CharacterCreate,
    session: Session = Depends(get_session),
):
    char = Character(project_id=project_id, **payload.model_dump())
    session.add(char)
    session.commit()
    session.refresh(char)
    return _char_dict(char)


@router.get("/{char_id}")
def get_character(project_id: int, char_id: int, session: Session = Depends(get_session)):
    return _char_dict(_char_or_404(char_id, project_id, session))


@router.patch("/{char_id}")
def update_character(
    project_id: int,
    char_id: int,
    payload: CharacterUpdate,
    session: Session = Depends(get_session),
):
    char = _char_or_404(char_id, project_id, session)
    for k, v in payload.model_dump(exclude_none=True).items():
        setattr(char, k, v)
    char.updated_at = datetime.utcnow()
    session.add(char)
    session.commit()
    session.refresh(char)
    return _char_dict(char)


@router.delete("/{char_id}", status_code=204)
def delete_character(project_id: int, char_id: int, session: Session = Depends(get_session)):
    char = _char_or_404(char_id, project_id, session)
    session.delete(char)
    session.commit()


@router.post("/{char_id}/reference-image")
def upload_reference_image(
    project_id: int,
    char_id: int,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
):
    char = _char_or_404(char_id, project_id, session)
    images_dir = project_asset_dir(project_id) / "images" / "characters"
    images_dir.mkdir(parents=True, exist_ok=True)
    ext = Path(file.filename or ".jpg").suffix
    dest = images_dir / f"char_{char_id}_{int(datetime.utcnow().timestamp())}{ext}"
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    paths = char.get_reference_images()
    # 新图作为「当前主参考」：插入队首；界面用大图绑的是 reference_images[0]，旧逻辑 append 会导致更换后仍显示旧图。
    paths.insert(0, str(dest))
    char.set_reference_images(paths)
    char.updated_at = datetime.utcnow()
    session.add(char)
    session.commit()
    return {"path": str(dest), "reference_images": paths}


def _char_dict(char: Character) -> dict:
    d = char.model_dump()
    try:
        d["reference_images"] = json.loads(char.reference_image_paths or "[]")
    except Exception:
        d["reference_images"] = []
    return d
