from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db.database import get_session
from ..db.models import Episode
from ..llm.client import stream_chat
from ..llm.presets import load_presets

router = APIRouter(prefix="/api/projects/{project_id}/compliance", tags=["compliance"])


class ComplianceRequest(BaseModel):
    content: Optional[str] = None  # 直接传内容；为空则自动聚合项目脚本
    preset_id: Optional[str] = None  # 指定使用的 LLM 预设；为空则使用第一个可用预设


@router.post("/check")
def compliance_check(
    project_id: int,
    payload: ComplianceRequest,
    session: Session = Depends(get_session),
):
    """调用 LLM 对脚本内容做合规审查，返回 JSON 报告"""
    # 获取待审查内容
    content = (payload.content or "").strip()
    if not content:
        episodes = session.exec(
            select(Episode)
            .where(Episode.project_id == project_id)
            .order_by(Episode.ep_number)
        ).all()
        parts = [
            f"第{ep.ep_number}集《{ep.title}》\n{ep.script_content}"
            for ep in episodes
            if ep.script_content
        ]
        if not parts:
            raise HTTPException(400, "项目无脚本内容，请先生成剧本")
        content = "\n\n---\n\n".join(parts[:10])  # 最多前10集

    # 读取提示词模板
    tpl_path = Path(__file__).parent.parent / "prompts" / "compliance_check.md"
    if tpl_path.exists():
        tpl = tpl_path.read_text(encoding="utf-8")
        prompt = tpl.replace("{content}", content[:60000])
    else:
        prompt = f"请对以下剧本内容进行合规审查，按JSON格式输出：\n\n{content[:60000]}"

    # 选择 LLM 预设
    presets = load_presets()
    if not presets:
        raise HTTPException(503, "未配置 LLM 预设，请先配置 providers.yaml")

    preset = None
    if payload.preset_id:
        pmap = {p.id: p for p in presets}
        preset = pmap.get(payload.preset_id.strip())
    if preset is None:
        preset = presets[0]

    # 同步调用 stream_chat 收集完整响应
    result_text = ""
    try:
        for chunk in stream_chat(
            preset,
            system="你是专业合规审查员，只输出JSON，不要输出任何其他内容。",
            user=prompt,
            temperature=0.2,
            max_tokens=4096,
        ):
            result_text += chunk
    except RuntimeError as e:
        raise HTTPException(503, f"LLM 调用失败：{e}") from e
    except Exception as e:
        raise HTTPException(500, f"LLM 调用错误：{e}") from e

    # 解析 JSON
    try:
        start = result_text.find("{")
        end = result_text.rfind("}") + 1
        report = json.loads(result_text[start:end]) if start >= 0 else {}
    except Exception:
        report = {"overall": "error", "raw": result_text[:1000]}

    return {"project_id": project_id, "report": report}
