"""视频渲染 API — 将分镜数据通过 Hyperframes 渲染为 MP4。"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import Scene, StoryboardShot, get_session
from ..paths import project_asset_dir
from ..ffmpeg_check import get_ffmpeg_path, ffmpeg_available
from ..video.composer import ShotData, build_composition
from ..video.renderer import (
    find_windows_chrome_for_hyperframes,
    normalize_hyperframes_fps,
    render_composition,
)

router = APIRouter(
    prefix="/api/projects/{project_id}/video",
    tags=["video"],
)


class RenderRequest(BaseModel):
    scene_id: Optional[int] = None
    episode: Optional[int] = None
    width: int = 1080
    height: int = 1920
    fps: int = 30


def _load_shots(
    project_id: int,
    session: Session,
    scene_id: int | None = None,
    episode: int | None = None,
) -> list[tuple[StoryboardShot, Scene | None]]:
    """Load shots for the given scope, paired with their scene."""
    q = select(StoryboardShot).where(StoryboardShot.project_id == project_id)
    if scene_id is not None:
        q = q.where(StoryboardShot.scene_id == scene_id)
    q = q.order_by(StoryboardShot.shot_number)
    shots = session.exec(q).all()

    scene_cache: dict[int, Scene | None] = {}

    def get_scene(sid: int) -> Scene | None:
        if sid not in scene_cache:
            scene_cache[sid] = session.get(Scene, sid)
        return scene_cache[sid]

    pairs: list[tuple[StoryboardShot, Scene | None]] = []
    for s in shots:
        scene = get_scene(s.scene_id)
        if episode is not None and scene:
            loc = (scene.location or "").upper()
            if f"EP{episode:02d}" not in loc and f"EP{episode}" not in loc:
                continue
        pairs.append((s, scene))
    return pairs


def _to_shot_data(shot: StoryboardShot, scene: Scene | None) -> ShotData:
    return ShotData(
        shot_number=shot.shot_number,
        duration_sec=shot.duration_sec if shot.duration_sec > 0 else 3.0,
        shot_content=shot.shot_content or "",
        shot_type=shot.shot_type or "",
        camera_movement=shot.camera_movement or "",
        dialogue=shot.dialogue or "",
        subtitle_text=shot.subtitle_text or "",
        action=shot.action or "",
        color_tone=shot.color_tone or "",
        lighting=shot.lighting or "",
        image_path=shot.image_path,
        video_path=shot.video_path,
        audio_path=shot.audio_path or None,
        scene_location=scene.location if scene else "",
    )


@router.post("/render")
def start_render(
    project_id: int,
    req: RenderRequest,
    session: Session = Depends(get_session),
):
    """生成 HTML composition 并调用 Hyperframes 渲染为 MP4（SSE 流式返回进度）。"""
    pairs = _load_shots(project_id, session, req.scene_id, req.episode)
    if not pairs:
        raise HTTPException(status_code=404, detail="No shots found for the given scope")

    shot_data_list = [_to_shot_data(s, sc) for s, sc in pairs]
    asset_base = project_asset_dir(project_id)

    scope_label = "full"
    if req.scene_id is not None:
        scope_label = f"scene-{req.scene_id}"
    elif req.episode is not None:
        scope_label = f"ep{req.episode:02d}"

    comp_dir = asset_base / "video" / f"comp-{scope_label}"
    output_path = asset_base / "video" / f"{scope_label}-{int(time.time())}.mp4"

    hf_fps = normalize_hyperframes_fps(req.fps)
    build_composition(
        shot_data_list,
        output_dir=comp_dir,
        asset_base=asset_base,
        width=req.width,
        height=req.height,
        fps=hf_fps,
        title=f"project-{project_id}-{scope_label}",
    )

    def sse_stream():
        for ev in render_composition(
            comp_dir,
            output_path,
            width=req.width,
            height=req.height,
            fps=hf_fps,
        ):
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    return StreamingResponse(sse_stream(), media_type="text/event-stream")


@router.post("/preview-composition")
def preview_composition(
    project_id: int,
    req: RenderRequest,
    session: Session = Depends(get_session),
):
    """仅生成 HTML composition（不渲染），返回 HTML 内容供前端预览。"""
    pairs = _load_shots(project_id, session, req.scene_id, req.episode)
    if not pairs:
        raise HTTPException(status_code=404, detail="No shots found for the given scope")

    shot_data_list = [_to_shot_data(s, sc) for s, sc in pairs]
    asset_base = project_asset_dir(project_id)

    scope_label = "preview"
    comp_dir = asset_base / "video" / f"comp-{scope_label}"

    hf_fps = normalize_hyperframes_fps(req.fps)
    html_path = build_composition(
        shot_data_list,
        output_dir=comp_dir,
        asset_base=asset_base,
        width=req.width,
        height=req.height,
        fps=hf_fps,
        title=f"preview-{project_id}",
    )

    return {
        "html_path": str(html_path),
        "shots_count": len(shot_data_list),
        "total_duration": sum(s.duration_sec for s in shot_data_list),
    }


@router.get("/ffmpeg-check")
def ffmpeg_check():
    """诊断：后端进程能否找到 FFmpeg。"""
    import os
    import shutil
    path_val = os.environ.get("PATH", os.environ.get("Path", ""))
    ffmpeg_in_path = [p for p in path_val.split(os.pathsep) if "ffmpeg" in p.lower()]
    chrome_auto = find_windows_chrome_for_hyperframes()
    return {
        "get_ffmpeg_path": get_ffmpeg_path(),
        "ffmpeg_available": ffmpeg_available(),
        "shutil_which": shutil.which("ffmpeg"),
        "ffmpeg_path_entries": ffmpeg_in_path,
        "path_key_casing": [k for k in os.environ if k.upper() == "PATH"],
        "hyperframes_browser_env": (os.environ.get("HYPERFRAMES_BROWSER_PATH") or "").strip() or None,
        "producer_headless_env": (os.environ.get("PRODUCER_HEADLESS_SHELL_PATH") or "").strip() or None,
        "hyperframes_chrome_auto_windows": chrome_auto or None,
    }


@router.get("/list")
def list_videos(
    project_id: int,
):
    """列出项目已渲染的视频文件。"""
    video_dir = project_asset_dir(project_id) / "video"
    if not video_dir.exists():
        return {"videos": []}

    videos = []
    for f in sorted(video_dir.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True):
        stat = f.stat()
        videos.append({
            "name": f.name,
            "path": str(f),
            "relative": f"video/{f.name}",
            "size_mb": round(stat.st_size / (1024 * 1024), 2),
            "created_at": stat.st_mtime,
        })

    return {"videos": videos}
