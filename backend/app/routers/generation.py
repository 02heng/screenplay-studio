from __future__ import annotations

import asyncio
import json
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlmodel import Session, select

from ..db.database import engine, get_session
from ..db.models import Character, GenerationJob, Scene, StoryboardShot

router = APIRouter(prefix="/api/projects/{project_id}", tags=["generation"])


def _prepend_unique_json_list(raw: str, item: str) -> str:
    arr = [x for x in json.loads(raw or "[]") if isinstance(x, str) and x != item]
    arr.insert(0, item)
    return json.dumps(arr, ensure_ascii=False)


# ── 单个生成 ──────────────────────────────────────────────────────────────────

@router.post("/characters/{char_id}/generate-three-view", status_code=202)
async def generate_character_three_view(
    project_id: int,
    char_id: int,
    session: Session = Depends(get_session),
):
    char = session.get(Character, char_id)
    if not char or char.project_id != project_id:
        raise HTTPException(status_code=404, detail="Character not found")
    if not char.ai_prompt:
        raise HTTPException(status_code=400, detail="ai_prompt is empty, please fill it first")

    char.three_view_status = "generating"
    session.add(char)
    session.commit()

    try:
        from ..providers.loader import get_image_provider
        provider = get_image_provider()
        url = await provider.generate_image(char.ai_prompt)
        char.three_view_image_path = url
        char.three_view_status = "done"
        char.updated_at = datetime.utcnow()
        session.add(char)
        session.commit()
        session.refresh(char)
        return {"three_view_image_path": url, "three_view_status": "done"}
    except NotImplementedError as e:
        char.three_view_status = "error"
        char.updated_at = datetime.utcnow()
        session.add(char)
        session.commit()
        raise HTTPException(status_code=501, detail=str(e))
    except Exception as e:
        char.three_view_status = "error"
        char.updated_at = datetime.utcnow()
        session.add(char)
        session.commit()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/shots/{shot_id}/generate-image", status_code=202)
async def generate_shot_image(
    project_id: int,
    shot_id: int,
    session: Session = Depends(get_session),
):
    shot = session.get(StoryboardShot, shot_id)
    if not shot or shot.project_id != project_id:
        raise HTTPException(status_code=404, detail="Shot not found")
    if not shot.ai_prompt:
        raise HTTPException(status_code=400, detail="ai_prompt is empty, please fill it first")
    try:
        from ..providers.loader import get_image_provider
        provider = get_image_provider()
        url = await provider.generate_image(shot.ai_prompt)
        shot.frame_images = _prepend_unique_json_list(shot.frame_images, url)
        shot.image_path = url
        session.add(shot)
        session.commit()
        session.refresh(shot)
        return {"image_path": url}
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/shots/{shot_id}/generate-video", status_code=202)
async def generate_shot_video(
    project_id: int,
    shot_id: int,
    session: Session = Depends(get_session),
):
    shot = session.get(StoryboardShot, shot_id)
    if not shot or shot.project_id != project_id:
        raise HTTPException(status_code=404, detail="Shot not found")
    try:
        frame_imgs: list[str] = json.loads(shot.frame_images or "[]")
        from ..providers.loader import get_video_provider
        provider = get_video_provider()
        url = await provider.generate_video(
            prompt=shot.animation_prompt or shot.ai_prompt,
            start_image=shot.image_path or None,
            frame_images=frame_imgs if frame_imgs else None,
            duration_sec=shot.duration_sec or 5.0,
        )
        vp_raw = getattr(shot, "video_paths", None) or "[]"
        shot.video_paths = _prepend_unique_json_list(vp_raw, url)
        shot.video_path = url
        session.add(shot)
        session.commit()
        session.refresh(shot)
        return {"video_path": url}
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── 批量后台任务 ───────────────────────────────────────────────────────────────

async def _run_image_batch(
    project_id: int,
    scene_id: int,
    job_id: int,
    shot_ids: list[int],
) -> None:
    """并发（最多 3）为每个 shot 生成图片，逐个写入 DB，完成后更新 job 状态。"""
    from ..providers.loader import get_image_provider
    provider = get_image_provider()
    sem = asyncio.Semaphore(3)
    results: list[dict[str, object]] = []
    success = 0
    failed = 0

    async def _one(shot_id: int) -> None:
        nonlocal success, failed
        async with sem:
            with Session(engine()) as sess:
                shot = sess.get(StoryboardShot, shot_id)
                if not shot or not shot.ai_prompt:
                    results.append({"shot_id": shot_id, "image_path": None, "error": "no ai_prompt"})
                    failed += 1
                    return
                try:
                    url = await provider.generate_image(shot.ai_prompt)
                    shot.frame_images = _prepend_unique_json_list(shot.frame_images, url)
                    shot.image_path = url
                    shot.updated_at = datetime.utcnow()
                    sess.add(shot)
                    sess.commit()
                    results.append({"shot_id": shot_id, "image_path": url, "error": None})
                    success += 1
                except (NotImplementedError, Exception) as e:
                    results.append({"shot_id": shot_id, "image_path": None, "error": str(e)})
                    failed += 1

    await asyncio.gather(*[_one(sid) for sid in shot_ids])

    with Session(engine()) as sess:
        job = sess.get(GenerationJob, job_id)
        if job:
            job.status = "done"
            job.success = success
            job.failed = failed
            job.result_json = json.dumps(results, ensure_ascii=False)
            job.updated_at = datetime.utcnow()
            sess.add(job)
            sess.commit()


async def _run_video_batch(
    project_id: int,
    scene_id: int,
    job_id: int,
    shot_ids: list[int],
) -> None:
    """并发（最多 3）为每个 shot 生成视频，逐个写入 DB，完成后更新 job 状态。"""
    from ..providers.loader import get_video_provider
    provider = get_video_provider()
    sem = asyncio.Semaphore(3)
    results: list[dict[str, object]] = []
    success = 0
    failed = 0

    async def _one(shot_id: int) -> None:
        nonlocal success, failed
        async with sem:
            with Session(engine()) as sess:
                shot = sess.get(StoryboardShot, shot_id)
                if not shot:
                    results.append({"shot_id": shot_id, "video_path": None, "error": "shot not found"})
                    failed += 1
                    return
                try:
                    frame_imgs: list[str] = json.loads(shot.frame_images or "[]")
                    url = await provider.generate_video(
                        prompt=shot.animation_prompt or shot.ai_prompt,
                        start_image=shot.image_path or None,
                        frame_images=frame_imgs if frame_imgs else None,
                        duration_sec=shot.duration_sec or 5.0,
                    )
                    vp_raw = getattr(shot, "video_paths", None) or "[]"
                    shot.video_paths = _prepend_unique_json_list(vp_raw, url)
                    shot.video_path = url
                    shot.updated_at = datetime.utcnow()
                    sess.add(shot)
                    sess.commit()
                    results.append({"shot_id": shot_id, "video_path": url, "error": None})
                    success += 1
                except (NotImplementedError, Exception) as e:
                    results.append({"shot_id": shot_id, "video_path": None, "error": str(e)})
                    failed += 1

    await asyncio.gather(*[_one(sid) for sid in shot_ids])

    with Session(engine()) as sess:
        job = sess.get(GenerationJob, job_id)
        if job:
            job.status = "done"
            job.success = success
            job.failed = failed
            job.result_json = json.dumps(results, ensure_ascii=False)
            job.updated_at = datetime.utcnow()
            sess.add(job)
            sess.commit()


# ── 批量路由 ──────────────────────────────────────────────────────────────────

@router.post("/scenes/{scene_id}/generate-images-batch", status_code=202)
async def batch_generate_images(
    project_id: int,
    scene_id: int,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
):
    scene = session.get(Scene, scene_id)
    if not scene or scene.project_id != project_id:
        raise HTTPException(status_code=404, detail="Scene not found")

    shots = session.exec(
        select(StoryboardShot)
        .where(StoryboardShot.scene_id == scene_id)
        .order_by(StoryboardShot.shot_number)
    ).all()
    shot_ids = [s.id for s in shots if s.id is not None]

    job = GenerationJob(
        project_id=project_id,
        job_type="image_batch",
        scene_id=scene_id,
        status="running",
        total=len(shot_ids),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    job_id = job.id

    background_tasks.add_task(_run_image_batch, project_id, scene_id, job_id, shot_ids)
    return {"job_id": job_id, "total": len(shot_ids)}


@router.post("/scenes/{scene_id}/generate-videos-batch", status_code=202)
async def batch_generate_videos(
    project_id: int,
    scene_id: int,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
):
    scene = session.get(Scene, scene_id)
    if not scene or scene.project_id != project_id:
        raise HTTPException(status_code=404, detail="Scene not found")

    shots = session.exec(
        select(StoryboardShot)
        .where(StoryboardShot.scene_id == scene_id)
        .order_by(StoryboardShot.shot_number)
    ).all()
    shot_ids = [s.id for s in shots if s.id is not None]

    job = GenerationJob(
        project_id=project_id,
        job_type="video_batch",
        scene_id=scene_id,
        status="running",
        total=len(shot_ids),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    job_id = job.id

    background_tasks.add_task(_run_video_batch, project_id, scene_id, job_id, shot_ids)
    return {"job_id": job_id, "total": len(shot_ids)}


# ── Job 状态查询 ──────────────────────────────────────────────────────────────

@router.get("/generation-jobs/{job_id}")
def get_generation_job(
    project_id: int,
    job_id: int,
    session: Session = Depends(get_session),
):
    job = session.get(GenerationJob, job_id)
    if not job or job.project_id != project_id:
        raise HTTPException(status_code=404, detail="Job not found")
    return {
        "id": job.id,
        "job_type": job.job_type,
        "scene_id": job.scene_id,
        "status": job.status,
        "total": job.total,
        "success": job.success,
        "failed": job.failed,
        "result_json": job.result_json,
        "created_at": job.created_at.isoformat(),
        "updated_at": job.updated_at.isoformat(),
    }
