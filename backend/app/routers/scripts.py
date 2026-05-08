from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session, Script
from ..paths import project_asset_dir

router = APIRouter(prefix="/api/projects/{project_id}/scripts", tags=["scripts"])


class ScriptCreate(BaseModel):
    title: str = "untitled"
    content: str = ""
    stage: str = "draft"


class ScriptUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    stage: Optional[str] = None


def _script_or_404(script_id: int, project_id: int, session: Session) -> Script:
    s = session.get(Script, script_id)
    if not s or s.project_id != project_id:
        raise HTTPException(status_code=404, detail="Script not found")
    return s


@router.get("")
def list_scripts(project_id: int, session: Session = Depends(get_session)):
    scripts = session.exec(
        select(Script).where(Script.project_id == project_id).order_by(Script.created_at.desc())
    ).all()
    return {"scripts": [s.model_dump() for s in scripts]}


@router.post("", status_code=201)
def create_script(
    project_id: int,
    payload: ScriptCreate,
    session: Session = Depends(get_session),
):
    script = Script(project_id=project_id, **payload.model_dump())
    session.add(script)
    session.commit()
    session.refresh(script)
    return script.model_dump()


@router.get("/{script_id}")
def get_script(project_id: int, script_id: int, session: Session = Depends(get_session)):
    return _script_or_404(script_id, project_id, session).model_dump()


@router.patch("/{script_id}")
def update_script(
    project_id: int,
    script_id: int,
    payload: ScriptUpdate,
    session: Session = Depends(get_session),
):
    script = _script_or_404(script_id, project_id, session)
    data = payload.model_dump(exclude_none=True)
    for k, v in data.items():
        setattr(script, k, v)
    script.updated_at = datetime.utcnow()
    session.add(script)
    session.commit()
    session.refresh(script)
    # persist to disk
    _save_to_disk(script, project_id)
    return script.model_dump()


@router.delete("/{script_id}", status_code=204)
def delete_script(
    project_id: int,
    script_id: int,
    session: Session = Depends(get_session),
):
    script = _script_or_404(script_id, project_id, session)
    session.delete(script)
    session.commit()


@router.get("/{script_id}/fountain", response_class=PlainTextResponse)
def export_fountain(
    project_id: int,
    script_id: int,
    session: Session = Depends(get_session),
):
    script = _script_or_404(script_id, project_id, session)
    return PlainTextResponse(content=_to_fountain(script.content), media_type="text/plain")


def _save_to_disk(script: Script, project_id: int) -> None:
    """Persist script content to project assets/scripts directory."""
    scripts_dir = project_asset_dir(project_id) / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    safe_title = "".join(c if c.isalnum() or c in "-_ " else "_" for c in (script.title or "untitled"))
    path = scripts_dir / f"{script.id}_{safe_title}.md"
    path.write_text(script.content or "", encoding="utf-8")
    script.file_path = str(path)


def _to_fountain(markdown_content: str) -> str:
    """Very lightweight markdown-to-Fountain conversion for basic export."""
    lines = []
    for line in markdown_content.splitlines():
        stripped = line.strip()
        if stripped.startswith("===== 阶段：") or stripped.startswith("====="):
            lines.append(f"# {stripped.replace('=', '').strip()}")
        elif stripped.isupper() and stripped:
            lines.append(stripped)
        else:
            lines.append(line)
    return "\n".join(lines)
