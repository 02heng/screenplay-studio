from __future__ import annotations

import csv
import io
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session, Scene, StoryboardShot, EditShot
from ..editor.subtitle import shots_to_srt
from ..paths import project_asset_dir

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
    # 时间轴
    timecode_in: str = ""
    timecode_out: str = ""
    duration_sec: float = 3.0
    # 画面
    shot_content: str = ""
    shot_type: str = ""
    camera_movement: str = ""
    director_intent: str = ""
    # 摄影参数
    camera_params: str = ""
    lighting: str = ""
    color_tone: str = ""
    # 音效
    sound_design: str = ""
    # 台词与字幕
    dialogue: str = ""
    subtitle_text: str = ""
    # 动作与 AI
    action: str = ""
    ai_prompt: str = ""
    animation_prompt: str = ""
    # 参考帧图片
    frame_images: str = "[]"
    video_paths: str = "[]"


class ShotUpdate(BaseModel):
    shot_number: Optional[int] = None
    # 时间轴
    timecode_in: Optional[str] = None
    timecode_out: Optional[str] = None
    duration_sec: Optional[float] = None
    # 画面
    shot_content: Optional[str] = None
    shot_type: Optional[str] = None
    camera_movement: Optional[str] = None
    director_intent: Optional[str] = None
    # 摄影参数
    camera_params: Optional[str] = None
    lighting: Optional[str] = None
    color_tone: Optional[str] = None
    # 音效
    sound_design: Optional[str] = None
    # 台词与字幕
    dialogue: Optional[str] = None
    subtitle_text: Optional[str] = None
    # 动作与 AI
    action: Optional[str] = None
    ai_prompt: Optional[str] = None
    animation_prompt: Optional[str] = None
    frame_images: Optional[str] = None
    # 生成结果
    image_path: Optional[str] = None
    video_path: Optional[str] = None
    video_paths: Optional[str] = None


def _prepend_unique_json_list(raw: str, item: str) -> str:
    arr = [x for x in json.loads(raw or "[]") if isinstance(x, str) and x != item]
    arr.insert(0, item)
    return json.dumps(arr, ensure_ascii=False)


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


@shot_router.post("/{shot_id}/upload-keyframe")
def upload_shot_keyframe(
    project_id: int,
    scene_id: int,
    shot_id: int,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
):
    """上传关键帧图片，插入队首并设为主预览 image_path。"""
    shot = _shot_or_404(shot_id, scene_id, project_id, session)
    images_dir = project_asset_dir(project_id) / "images" / "storyboard"
    images_dir.mkdir(parents=True, exist_ok=True)
    ext = Path(file.filename or ".jpg").suffix or ".jpg"
    dest = images_dir / f"shot_{shot_id}_{int(datetime.utcnow().timestamp())}{ext}"
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    path = str(dest.resolve())
    shot.frame_images = _prepend_unique_json_list(shot.frame_images, path)
    shot.image_path = path
    shot.updated_at = datetime.utcnow()
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return shot.model_dump()


@shot_router.post("/{shot_id}/upload-video")
def upload_shot_video_file(
    project_id: int,
    scene_id: int,
    shot_id: int,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
):
    """上传镜头视频片段，插入队首并设为主预览 video_path。"""
    shot = _shot_or_404(shot_id, scene_id, project_id, session)
    videos_dir = project_asset_dir(project_id) / "video" / "shots"
    videos_dir.mkdir(parents=True, exist_ok=True)
    ext = Path(file.filename or ".mp4").suffix or ".mp4"
    if ext.lower() not in {".mp4", ".webm", ".mov", ".mkv"}:
        ext = ".mp4"
    dest = videos_dir / f"shot_{shot_id}_{int(datetime.utcnow().timestamp())}{ext}"
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    path = str(dest.resolve())
    raw_vp = getattr(shot, "video_paths", None) or "[]"
    shot.video_paths = _prepend_unique_json_list(raw_vp, path)
    shot.video_path = path
    shot.updated_at = datetime.utcnow()
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return shot.model_dump()


# ── Edit shots (cut list) ─────────────────────────────────────────────────────

edit_router = APIRouter(prefix="/api/projects/{project_id}/edit-shots")


class EditShotCreate(BaseModel):
    storyboard_shot_id: Optional[int] = None
    ep_number: Optional[int] = None
    order_index: int = 0
    clip_path: Optional[str] = None
    in_point: float = 0.0
    out_point: float = 0.0
    timecode: str = "00:00:00:00"
    note: str = ""


class EditShotUpdate(BaseModel):
    ep_number: Optional[int] = None
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
        fieldnames=["ep_number", "order_index", "timecode", "clip_path", "in_point", "out_point", "note"],
    )
    writer.writeheader()
    for s in shots:
        writer.writerow({
            "ep_number": s.ep_number if s.ep_number is not None else "",
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


# ── SRT 字幕导出 ──────────────────────────────────────────────────────────────

@scene_router.get("/{scene_id}/export-srt")
def export_scene_srt(
    project_id: int,
    scene_id: int,
    session: Session = Depends(get_session),
):
    """返回该场景所有 shot 的 SRT 字幕文本"""
    shots = session.exec(
        select(StoryboardShot)
        .where(StoryboardShot.scene_id == scene_id)
        .order_by(StoryboardShot.shot_number)
    ).all()
    srt_text = shots_to_srt(list(shots))
    return PlainTextResponse(
        srt_text,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="scene_{scene_id}.srt"'},
    )


srt_router = APIRouter(prefix="/api/projects/{project_id}", tags=["storyboard"])


@srt_router.get("/export-srt-full")
def export_project_srt(project_id: int, session: Session = Depends(get_session)):
    """合并项目所有 shot，输出完整 SRT"""
    scenes = session.exec(
        select(Scene).where(Scene.project_id == project_id).order_by(Scene.scene_number)
    ).all()
    all_shots: list[StoryboardShot] = []
    for sc in scenes:
        sc_shots = session.exec(
            select(StoryboardShot)
            .where(StoryboardShot.scene_id == sc.id)
            .order_by(StoryboardShot.shot_number)
        ).all()
        all_shots.extend(sc_shots)
    srt_text = shots_to_srt(all_shots)
    return PlainTextResponse(
        srt_text,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="project_{project_id}.srt"'},
    )
