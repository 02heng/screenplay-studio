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
from app.routers.episodes import router as episodes_router
from app.routers.storyboard import scene_router, shot_router, edit_router, srt_router
from app.routers.download import router as download_router
from app.routers.memory import router as memory_router
from app.routers.settings import router as settings_router
from app.routers.generation import router as generation_router
from app.routers.timeline import router as timeline_router
from app.routers.compliance import router as compliance_router
from app.routers.export import router as export_router
from app.routers.tts import router as tts_router
from app.routers.snapshots import router as snapshots_router
from app.routers.video import router as video_router
from app.llm_keys_store import get_for_preset
from app.agents.context import AgentContext
from app.agents.orchestrator import Orchestrator

API_REVISION = 5

_here = Path(__file__).resolve()
_backend = _here.parents[1]
load_dotenv(_backend / ".env", override=False)
_ud = Path(os.environ.get("SCREENPLAY_USER_DATA", "").strip()) if os.environ.get("SCREENPLAY_USER_DATA") else None
if _ud and _ud.is_dir():
    load_dotenv(_ud / ".env", override=False)


def _cleanup_orphan_records():
    """启动时清除已删除项目遗留的孤儿数据（批量 DELETE，避免旧表缺列时 ORM 读行失败）。"""
    from app.db import engine, Episode, GenerationJob, ProjectSnapshot, Timeline
    from app.db import Project, EditShot, StoryboardShot, Scene, Character, Script
    from sqlmodel import Session as _S, select as _sel, delete as _del
    try:
        with _S(engine) as s:
            live = list({p.id for p in s.exec(_sel(Project)).all()})
            n = 0
            for m in (EditShot, StoryboardShot, Scene, Character, Script,
                      Episode, GenerationJob, ProjectSnapshot, Timeline):
                stmt = _del(m).where(~m.project_id.in_(live)) if live else _del(m)
                res = s.execute(stmt)
                n += getattr(res, "rowcount", 0) or 0
            if n:
                s.commit()
    except Exception:
        pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()
    _cleanup_orphan_records()
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
app.include_router(generation_router)
app.include_router(episodes_router)
app.include_router(timeline_router)
app.include_router(srt_router)
app.include_router(compliance_router)
app.include_router(export_router)
app.include_router(tts_router)
app.include_router(snapshots_router)
app.include_router(video_router)


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
    target_episodes: int | None = Field(
        default=None,
        ge=1,
        le=120,
        description="短剧可选：用户指定的目标集数，写入提示词约束分集粗纲规模",
    )
    episode_range_start: int | None = Field(
        default=None,
        ge=1,
        description="增量生成：本次从第几集开始写（含）",
    )
    episode_range_end: int | None = Field(
        default=None,
        ge=1,
        description="增量生成：本次写到第几集（含）",
    )
    project_id: int | None = Field(
        default=None,
        description="项目 ID — 用于读取/写入项目记忆系统",
    )
    llm_api_key: str = Field(
        default="",
        description="Bearer token；非空时优先于用户数据目录中保存的 Key 与环境变量。",
    )
    pipeline: str = Field(
        default="auto",
        description="'legacy' 用旧线性流水线；'agents' 用多智能体；'auto' 自动选择（短剧/改编用 agents）。",
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

    use_agents = (
        payload.pipeline == "agents"
        or (payload.pipeline == "auto" and job in ("short_drama", "novel_adapt"))
    )

    def _build_drama_types() -> str:
        raw = payload.short_drama_types or []
        cleaned = [str(t).strip() for t in raw if str(t).strip()]
        if not cleaned:
            return "（用户未勾选类型标签，请结合梗概自行把握题材与受众）"
        return "、".join(cleaned)

    def _build_notes() -> str:
        base = (payload.notes or "").strip()
        hints: list[str] = []

        if payload.target_episodes is not None:
            hints.append(
                f"【目标集数 = {payload.target_episodes}】"
                f"全剧恰好 {payload.target_episodes} 集，不多不少。"
                f"episode_skeleton / adapt_outline 的 JSON episodes 数组"
                f"必须恰好包含 {payload.target_episodes} 条（ep_number 1…{payload.target_episodes}）。"
                f"节拍表和剧本正文也严格按此集数来写。"
                f"严禁自行增加或减少集数。"
            )

        ep_start = payload.episode_range_start
        ep_end = payload.episode_range_end
        if ep_start is not None and ep_end is not None:
            hints.append(
                f"【本次生成范围】本次只写第 {ep_start} 集到第 {ep_end} 集的剧本正文"
                f"（共 {ep_end - ep_start + 1} 集）。"
                "节拍表也只写这些集的。分集大纲仍需输出全部集。"
                "须延续已有集数的情节线索和角色发展。"
                "（若模型仍写出范围外的集，系统会在落稿前自动截断，仅保留本范围内的正文与节拍。）"
            )
        elif ep_start is not None:
            hints.append(
                f"【本次生成范围】本次从第 {ep_start} 集开始写，尽量多写。"
                "须延续已有集数的情节线索和角色发展。"
                "（从该集往后的多写内容会保留；若明确填写了结束集则仍会截断超出部分。）"
            )

        all_hints = "\n\n".join(hints)
        if base and all_hints:
            return f"{base}\n\n{all_hints}"
        return all_hints or base

    def _build_memory_context() -> str:
        if not payload.project_id:
            return ""
        try:
            from app.memory.memory_manager import MemoryManager
            mgr = MemoryManager(payload.project_id)
            ctx_str = mgr.build_context(max_chars=6000)
            return ctx_str
        except Exception:
            return ""

    def sse_gen_agents():
        try:
            mem_ctx = _build_memory_context()
            ctx = AgentContext(
                job_type=job,
                logline=payload.logline.strip(),
                novel_excerpt=payload.novel_excerpt.strip(),
                notes=_build_notes(),
                drama_types=_build_drama_types(),
                target_episodes=payload.target_episodes,
                episode_range_start=payload.episode_range_start,
                episode_range_end=payload.episode_range_end,
                project_id=payload.project_id,
                memory_context=mem_ctx,
            )
            orch = Orchestrator(
                preset, ctx,
                llm_api_key=effective_key,
            )
            for raw in orch.run():
                line = raw.rstrip("\n")
                yield f"data: {line}\n\n"
        except RuntimeError as e:
            msg = {"type": "error", "message": str(e)}
            yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
        except Exception as e:  # noqa: BLE001
            msg = {"type": "error", "message": str(e)}
            yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"

    def sse_gen_legacy():
        try:
            for raw in run_job_stream(
                preset,
                job,
                payload.logline.strip(),
                payload.novel_excerpt.strip(),
                _build_notes(),
                llm_api_key=effective_key,
                short_drama_types=payload.short_drama_types,
                target_episodes=payload.target_episodes,
                episode_range_start=payload.episode_range_start,
                episode_range_end=payload.episode_range_end,
                project_id=payload.project_id,
            ):
                line = raw.rstrip("\n")
                yield f"data: {line}\n\n"
        except RuntimeError as e:
            msg = {"type": "error", "message": str(e)}
            yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
        except Exception as e:  # noqa: BLE001
            msg = {"type": "error", "message": str(e)}
            yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"

    gen = sse_gen_agents if use_agents else sse_gen_legacy
    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/")
def root():
    return {"service": "screenplay-studio", "api_revision": API_REVISION}
