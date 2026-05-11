from __future__ import annotations

import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Optional

from ..ffmpeg_check import get_ffmpeg_path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db.database import get_session
from ..db.models import Scene, StoryboardShot, Timeline

router = APIRouter(prefix="/api/projects/{project_id}/timelines", tags=["timeline"])


class TimelineCreate(BaseModel):
    name: str = "主时间线"
    fps: int = 25
    resolution: str = "1080x1920"


class TimelineUpdate(BaseModel):
    name: Optional[str] = None
    fps: Optional[int] = None
    resolution: Optional[str] = None
    clips_json: Optional[str] = None
    subtitles_json: Optional[str] = None
    bgm_json: Optional[str] = None


@router.get("")
def list_timelines(project_id: int, session: Session = Depends(get_session)):
    tls = session.exec(select(Timeline).where(Timeline.project_id == project_id)).all()
    return {"timelines": [t.model_dump() for t in tls]}


@router.post("", status_code=201)
def create_timeline(
    project_id: int,
    payload: TimelineCreate,
    session: Session = Depends(get_session),
):
    tl = Timeline(project_id=project_id, **payload.model_dump())
    session.add(tl)
    session.commit()
    session.refresh(tl)
    return tl.model_dump()


@router.get("/{tl_id}")
def get_timeline(project_id: int, tl_id: int, session: Session = Depends(get_session)):
    tl = session.get(Timeline, tl_id)
    if not tl or tl.project_id != project_id:
        raise HTTPException(404, "Timeline not found")
    return tl.model_dump()


@router.patch("/{tl_id}")
def update_timeline(
    project_id: int,
    tl_id: int,
    payload: TimelineUpdate,
    session: Session = Depends(get_session),
):
    tl = session.get(Timeline, tl_id)
    if not tl or tl.project_id != project_id:
        raise HTTPException(404, "Timeline not found")
    for k, v in payload.model_dump(exclude_none=True).items():
        setattr(tl, k, v)
    tl.updated_at = datetime.utcnow()
    session.add(tl)
    session.commit()
    session.refresh(tl)
    return tl.model_dump()


@router.delete("/{tl_id}", status_code=204)
def delete_timeline(
    project_id: int,
    tl_id: int,
    session: Session = Depends(get_session),
):
    tl = session.get(Timeline, tl_id)
    if not tl or tl.project_id != project_id:
        raise HTTPException(404, "Timeline not found")
    session.delete(tl)
    session.commit()


@router.post("/{tl_id}/build-from-storyboard", status_code=200)
def build_from_storyboard(
    project_id: int,
    tl_id: int,
    session: Session = Depends(get_session),
):
    """从分镜自动组装时间线 clips（video_path / image_path 非空的 shot 按顺序排列）"""
    tl = session.get(Timeline, tl_id)
    if not tl or tl.project_id != project_id:
        raise HTTPException(404, "Timeline not found")

    scenes = session.exec(
        select(Scene)
        .where(Scene.project_id == project_id)
        .order_by(Scene.scene_number)  # type: ignore[arg-type]
    ).all()

    clips: list[dict] = []
    idx = 0
    for sc in scenes:
        shots = session.exec(
            select(StoryboardShot)
            .where(StoryboardShot.scene_id == sc.id)
            .order_by(StoryboardShot.shot_number)  # type: ignore[arg-type]
        ).all()
        for sh in shots:
            if sh.video_path or sh.image_path:
                clips.append({
                    "id": f"clip_{sh.id}",
                    "shot_id": sh.id,
                    "video_path": sh.video_path or sh.image_path or "",
                    "in_point": 0,
                    "out_point": sh.duration_sec or 3.0,
                    "order_index": idx,
                    "transition": "cut",
                    "transition_duration": 0.0,
                })
                idx += 1

    tl.clips_json = json.dumps(clips, ensure_ascii=False)
    tl.updated_at = datetime.utcnow()
    session.add(tl)
    session.commit()
    session.refresh(tl)
    return {"clips_count": len(clips), "clips_json": tl.clips_json}


@router.post("/{tl_id}/export")
def export_timeline(
    project_id: int,
    tl_id: int,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
):
    """提交 FFmpeg 导出任务（后台执行）"""
    tl = session.get(Timeline, tl_id)
    if not tl or tl.project_id != project_id:
        raise HTTPException(404, "Timeline not found")
    tl.status = "exporting"
    session.add(tl)
    session.commit()
    background_tasks.add_task(_run_ffmpeg_export, tl_id)
    return {"status": "exporting", "timeline_id": tl_id}


def _run_ffmpeg_export(tl_id: int) -> None:
    """后台 FFmpeg 导出（concat demuxer 方式）"""
    session = next(get_session())
    tl = session.get(Timeline, tl_id)
    if not tl:
        return
    try:
        clips: list[dict] = json.loads(tl.clips_json or "[]")
        if not clips:
            tl.status = "error"
            tl.export_path = "no clips in timeline"
            session.add(tl)
            session.commit()
            return

        out_dir = Path("D:/Screenplay-Studio-data/exports")
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"project_{tl.project_id}_timeline_{tl_id}.mp4"

        concat_path = out_dir / f"concat_{tl_id}.txt"
        with open(concat_path, "w", encoding="utf-8") as f:
            for clip in clips:
                vp = clip.get("video_path", "")
                if vp:
                    f.write(f"file '{vp}'\n")
                    dur = clip.get("out_point", 3) - clip.get("in_point", 0)
                    if dur > 0:
                        f.write(f"duration {dur}\n")

        ffmpeg_bin = get_ffmpeg_path()
        if not ffmpeg_bin:
            tl.status = "error"
            tl.export_path = "FFmpeg 未安装，请安装 FFmpeg 或设置 FFMPEG_PATH 环境变量"
            tl.updated_at = datetime.utcnow()
            session.add(tl)
            session.commit()
            return

        w, h = tl.resolution.split("x") if "x" in tl.resolution else ("1080", "1920")
        cmd = [
            ffmpeg_bin, "-y", "-f", "concat", "-safe", "0",
            "-i", str(concat_path),
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-vf", f"scale={w}:{h}",
            "-r", str(tl.fps),
            str(out_path),
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=600)
        if result.returncode == 0:
            tl.status = "done"
            tl.export_path = str(out_path)
        else:
            tl.status = "error"
            tl.export_path = result.stderr.decode("utf-8", errors="replace")[-500:]
    except Exception as e:  # noqa: BLE001
        tl.status = "error"
        tl.export_path = str(e)[:500]
    finally:
        tl.updated_at = datetime.utcnow()
        session.add(tl)
        session.commit()
