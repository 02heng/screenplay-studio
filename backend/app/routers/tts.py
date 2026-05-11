from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db.database import get_session
from ..db.models import StoryboardShot
from ..providers.loader import get_tts_provider

router = APIRouter(prefix="/api/projects/{project_id}", tags=["tts"])


class TTSRequest(BaseModel):
    text: str = ""
    voice: str = ""
    speed: float = 1.0
    pitch: float = 0.0


@router.post("/shots/{shot_id}/synthesize-voice")
async def synthesize_shot_voice(
    project_id: int,
    shot_id: int,
    payload: TTSRequest,
    session: Session = Depends(get_session),
):
    shot = session.get(StoryboardShot, shot_id)
    if not shot:
        raise HTTPException(404, "Shot not found")
    text = (
        payload.text.strip()
        or getattr(shot, "subtitle_text", "")
        or shot.dialogue
        or ""
    )
    if not text:
        raise HTTPException(400, "No text to synthesize")
    try:
        provider = get_tts_provider()
        out_path = f"D:/Screenplay-Studio-data/tts/shot_{shot_id}.mp3"
        audio_path = await provider.synthesize(
            text=text,
            voice=payload.voice,
            speed=payload.speed,
            pitch=payload.pitch,
            output_path=out_path,
        )
        if hasattr(shot, "audio_path"):
            shot.audio_path = audio_path
            session.add(shot)
            session.commit()
        return {"audio_path": audio_path, "shot_id": shot_id}
    except NotImplementedError as e:
        raise HTTPException(501, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/scenes/{scene_id}/synthesize-voice-batch")
async def batch_synthesize_scene(
    project_id: int,
    scene_id: int,
    payload: TTSRequest,
    session: Session = Depends(get_session),
):
    shots = session.exec(
        select(StoryboardShot)
        .where(StoryboardShot.scene_id == scene_id)
        .order_by(StoryboardShot.shot_number)
    ).all()
    provider = get_tts_provider()
    sem = asyncio.Semaphore(3)
    results: list[dict] = []

    async def _do(sh: StoryboardShot) -> None:
        text = (getattr(sh, "subtitle_text", "") or sh.dialogue or "").strip()
        if not text:
            return
        async with sem:
            try:
                out_path = f"D:/Screenplay-Studio-data/tts/shot_{sh.id}.mp3"
                audio_path = await provider.synthesize(
                    text=text,
                    voice=payload.voice,
                    speed=payload.speed,
                    pitch=payload.pitch,
                    output_path=out_path,
                )
                if hasattr(sh, "audio_path"):
                    sh.audio_path = audio_path
                    session.add(sh)
                results.append({"shot_id": sh.id, "audio_path": audio_path})
            except Exception as e:
                results.append({"shot_id": sh.id, "error": str(e)})

    await asyncio.gather(*[_do(sh) for sh in shots])
    try:
        session.commit()
    except Exception:
        session.rollback()
    return {"results": results, "total": len(results)}
