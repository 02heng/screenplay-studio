from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.db import create_db_and_tables
from app.llm.presets import load_presets
from app.pipelines.runner import run_job_stream
from app.paths import user_data_dir
from app.routers import projects, scripts, characters, assets
from app.routers.storyboard import scene_router, shot_router, edit_router
from app.routers.download import router as download_router
from app.routers.memory import router as memory_router
from app.routers.settings import router as settings_router
from app.llm_keys_store import get_for_preset

API_REVISION = 4

_here = Path(__file__).resolve()
_backend = _here.parents[1]
load_dotenv(_backend / ".env", override=False)
_ud = Path(os.environ.get("SCREENPLAY_USER_DATA", "").strip()) if os.environ.get("SCREENPLAY_USER_DATA") else None
if _ud and _ud.is_dir():
    load_dotenv(_ud / ".env", override=False)


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()
    yield


app = FastAPI(title="Screenplay Studio API", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ────────────────────────────────────────────────────────────────────
app.include_router(projects.router)
app.include_router(scripts.router)
app.include_router(characters.router)
app.include_router(scene_router)
app.include_router(shot_router)
app.include_router(edit_router)
app.include_router(assets.router)
app.include_router(download_router)
app.include_router(memory_router)
app.include_router(settings_router)


# ── Legacy LLM stream endpoint ─────────────────────────────────────────────────
class JobPayload(BaseModel):
    job_type: str = Field(..., description="feature | short_drama | novel_adapt")
    preset_id: str
    logline: str = ""
    novel_excerpt: str = ""
    notes: str = ""
    short_drama_types: list[str] = Field(
        default_factory=list,
        description="短剧项目时用户勾选的类型标签（可多选）",
    )
    llm_api_key: str = Field(
        default="",
        description="Bearer token；非空时优先于用户数据目录中保存的 Key 与环境变量。",
    )


@app.get("/api/health")
def health():
    ud = user_data_dir()
    return {
        "ok": True,
        "app": "screenplay-studio",
        "api_revision": API_REVISION,
        "pipeline_stream": True,
        "user_data": str(ud),
        "preset_count": len(load_presets()),
    }


@app.get("/api/llm/presets")
def list_presets():
    presets = load_presets()
    if not presets:
        return {"presets": [], "hint": "Copy backend/config/providers.example.yaml to UserData/providers.yaml"}
    return {"presets": [p.safe_dict for p in presets]}


@app.post("/api/jobs/stream")
def stream_job(payload: JobPayload):
    presets = load_presets()
    if not presets:
        raise HTTPException(
            status_code=400,
            detail="No presets loaded. Copy providers.example.yaml to UserData/providers.yaml",
        )

    pmap = {p.id: p for p in presets}
    preset = pmap.get(payload.preset_id.strip())
    if not preset:
        raise HTTPException(status_code=404, detail="Unknown preset_id")

    job = payload.job_type.strip()
    if job not in ("feature", "short_drama", "novel_adapt"):
        raise HTTPException(status_code=400, detail="Invalid job_type")

    if job != "novel_adapt" and not payload.logline.strip():
        raise HTTPException(status_code=400, detail="logline required for this job")

    if job == "novel_adapt" and not payload.novel_excerpt.strip():
        raise HTTPException(status_code=400, detail="novel_excerpt required for novel_adapt")

    stored_key = get_for_preset(payload.preset_id.strip())
    effective_key = (payload.llm_api_key.strip() or stored_key or "").strip()

    def sse_gen():
        try:
            for raw in run_job_stream(
                preset,
                job,
                payload.logline.strip(),
                payload.novel_excerpt.strip(),
                payload.notes.strip(),
                llm_api_key=effective_key,
                short_drama_types=payload.short_drama_types,
            ):
                line = raw.rstrip("\n")
                yield f"data: {line}\n\n"
        except RuntimeError as e:
            msg = {"type": "error", "message": str(e)}
            yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
        except Exception as e:  # noqa: BLE001
            msg = {"type": "error", "message": str(e)}
            yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"

    return StreamingResponse(sse_gen(), media_type="text/event-stream")


@app.get("/")
def root():
    return {"service": "screenplay-studio", "api_revision": API_REVISION}
