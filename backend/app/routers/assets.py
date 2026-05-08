from __future__ import annotations

import mimetypes
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlmodel import Session

from ..db import get_session
from ..paths import project_asset_dir

router = APIRouter(prefix="/api/projects/{project_id}/assets", tags=["assets"])

ALLOWED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}
ALLOWED_VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".mkv", ".avi"}


def _asset_subdir(project_id: int, kind: str) -> Path:
    d = project_asset_dir(project_id) / kind
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.get("")
def list_assets(project_id: int, kind: str = "images"):
    subdir = _asset_subdir(project_id, kind)
    files = sorted(subdir.rglob("*")) if subdir.exists() else []
    result = []
    for f in files:
        if f.is_file():
            result.append({
                "name": f.name,
                "path": str(f),
                "relative": str(f.relative_to(project_asset_dir(project_id))),
                "size": f.stat().st_size,
            })
    return {"assets": result, "kind": kind}


@router.post("/upload")
def upload_asset(
    project_id: int,
    kind: str = "images",
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
):
    suffix = Path(file.filename or ".bin").suffix.lower()
    if kind == "images" and suffix not in ALLOWED_IMAGE_SUFFIXES:
        raise HTTPException(status_code=400, detail=f"Unsupported image format: {suffix}")
    if kind == "videos" and suffix not in ALLOWED_VIDEO_SUFFIXES:
        raise HTTPException(status_code=400, detail=f"Unsupported video format: {suffix}")

    subdir = _asset_subdir(project_id, kind)
    dest = subdir / file.filename
    counter = 1
    while dest.exists():
        dest = subdir / f"{Path(file.filename).stem}_{counter}{suffix}"
        counter += 1

    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    return {
        "path": str(dest),
        "relative": str(dest.relative_to(project_asset_dir(project_id))),
        "name": dest.name,
        "size": dest.stat().st_size,
    }


@router.get("/file")
def serve_asset(project_id: int, relative: str):
    base = project_asset_dir(project_id)
    full = (base / relative).resolve()
    # security: ensure resolved path stays inside base
    if not str(full).startswith(str(base.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")
    if not full.exists():
        raise HTTPException(status_code=404, detail="File not found")
    media_type = mimetypes.guess_type(str(full))[0] or "application/octet-stream"
    return FileResponse(str(full), media_type=media_type)


@router.delete("/file")
def delete_asset(project_id: int, relative: str):
    base = project_asset_dir(project_id)
    full = (base / relative).resolve()
    if not str(full).startswith(str(base.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")
    if full.exists():
        full.unlink()
    return {"deleted": relative}
