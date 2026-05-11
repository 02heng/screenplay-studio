"""
项目 ZIP 导出/导入
导出内容：project 元数据 + episodes + characters + scenes + shots + timelines
不包含媒体文件（图片/视频），仅导出路径引用
"""
from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select

from ..db.database import get_session
from ..db.models import Character, Episode, Project, Scene, StoryboardShot, Timeline

router = APIRouter(prefix="/api", tags=["export"])


def _model_list(items) -> list:
    return [item.model_dump() for item in items]


@router.get("/projects/{project_id}/export-zip")
def export_project_zip(project_id: int, session: Session = Depends(get_session)):
    """将项目数据打包为 ZIP，供备份或迁移"""
    proj = session.get(Project, project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    chars = session.exec(
        select(Character).where(Character.project_id == project_id)
    ).all()
    scenes = session.exec(
        select(Scene).where(Scene.project_id == project_id)
    ).all()
    scene_ids = [s.id for s in scenes if s.id is not None]
    shots: list[StoryboardShot] = []
    for sid in scene_ids:
        shots += session.exec(
            select(StoryboardShot).where(StoryboardShot.scene_id == sid)
        ).all()
    timelines = session.exec(
        select(Timeline).where(Timeline.project_id == project_id)
    ).all()
    episodes = session.exec(
        select(Episode).where(Episode.project_id == project_id)
    ).all()

    bundle = {
        "version": "1.0",
        "exported_at": datetime.utcnow().isoformat(),
        "project": proj.model_dump(),
        "characters": _model_list(chars),
        "scenes": _model_list(scenes),
        "shots": _model_list(shots),
        "timelines": _model_list(timelines),
        "episodes": _model_list(episodes),
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "project_bundle.json",
            json.dumps(bundle, ensure_ascii=False, indent=2, default=str),
        )
    buf.seek(0)

    safe_name = proj.name.replace(" ", "_").replace("/", "_")[:40]
    filename = f"{safe_name}_backup_{datetime.now().strftime('%Y%m%d')}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/import-zip", status_code=201)
async def import_project_zip(
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
):
    """从 ZIP 文件导入项目（创建新项目，ID 重新分配）"""
    data = await file.read()
    try:
        buf = io.BytesIO(data)
        with zipfile.ZipFile(buf) as zf:
            bundle = json.loads(zf.read("project_bundle.json").decode("utf-8"))
    except Exception as e:
        raise HTTPException(400, f"无效的 ZIP 文件: {e}") from e

    # 创建新项目（去除原 id、created_at、updated_at）
    proj_data = {
        k: v
        for k, v in bundle["project"].items()
        if k not in ("id", "created_at", "updated_at")
    }
    proj_data["name"] = proj_data.get("name", "导入项目") + "（导入）"
    new_proj = Project(**proj_data)
    session.add(new_proj)
    session.commit()
    session.refresh(new_proj)
    new_pid = new_proj.id

    # 映射旧 id → 新 id
    char_id_map: dict[int, int] = {}
    scene_id_map: dict[int, int] = {}

    for c in bundle.get("characters", []):
        old_id = c.pop("id", None)
        for f in ("created_at", "updated_at"):
            c.pop(f, None)
        c["project_id"] = new_pid
        try:
            new_c = Character(**c)
            session.add(new_c)
            session.commit()
            session.refresh(new_c)
            if old_id is not None:
                char_id_map[old_id] = new_c.id  # type: ignore[index]
        except Exception:
            session.rollback()

    for sc in bundle.get("scenes", []):
        old_id = sc.pop("id", None)
        for f in ("created_at", "updated_at"):
            sc.pop(f, None)
        sc["project_id"] = new_pid
        try:
            new_sc = Scene(**sc)
            session.add(new_sc)
            session.commit()
            session.refresh(new_sc)
            if old_id is not None:
                scene_id_map[old_id] = new_sc.id  # type: ignore[index]
        except Exception:
            session.rollback()

    for sh in bundle.get("shots", []):
        sh.pop("id", None)
        for f in ("created_at", "updated_at"):
            sh.pop(f, None)
        old_scene_id = sh.get("scene_id")
        sh["scene_id"] = scene_id_map.get(old_scene_id, old_scene_id)
        sh["project_id"] = new_pid
        try:
            new_sh = StoryboardShot(**sh)
            session.add(new_sh)
            session.commit()
        except Exception:
            session.rollback()

    for tl in bundle.get("timelines", []):
        tl.pop("id", None)
        for f in ("created_at", "updated_at"):
            tl.pop(f, None)
        tl["project_id"] = new_pid
        try:
            new_tl = Timeline(**tl)
            session.add(new_tl)
            session.commit()
        except Exception:
            session.rollback()

    for ep in bundle.get("episodes", []):
        ep.pop("id", None)
        for f in ("created_at", "updated_at"):
            ep.pop(f, None)
        ep["project_id"] = new_pid
        try:
            new_ep = Episode(**ep)
            session.add(new_ep)
            session.commit()
        except Exception:
            session.rollback()

    return {"project_id": new_pid, "title": new_proj.name}
