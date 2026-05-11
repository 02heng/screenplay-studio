"""从项目「集数」表拼接剧本正文，供分镜等阶段与流水线草稿对齐。"""

from __future__ import annotations

from sqlmodel import Session, select

from .db.database import engine
from .db.models import Episode


def concat_saved_episode_scripts(project_id: int, *, max_chars: int | None = None) -> str:
    """按 ep_number 拼接集数库中非空 script_content。"""
    with Session(engine()) as session:
        rows = session.exec(
            select(Episode).where(Episode.project_id == project_id).order_by(Episode.ep_number)
        ).all()

    blocks: list[str] = []
    for ep in rows:
        body = (ep.script_content or "").strip()
        if len(body) < 20:
            continue
        title = (ep.title or "").strip()
        head = f"【第{ep.ep_number}集】"
        if title:
            head += f" {title}"
        blocks.append(f"{head}\n{body}")

    out = "\n\n".join(blocks)
    if max_chars is not None and len(out) > max_chars:
        return out[:max_chars] + "\n…（已截断）"
    return out


def storyboard_bundle_for_prior(project_id: int | None, *, budget: int = 120_000) -> str:
    """注入分镜 user/prior 的固定前缀块（无内容则空串）。"""
    if not project_id:
        return ""
    raw = concat_saved_episode_scripts(project_id, max_chars=budget)
    if not raw.strip():
        return ""
    return (
        "=== 集数库已保存剧本（凡此处出现的每一集均须拆出对应 EPxx 分镜，不得只做第一集）===\n"
        + raw
    )
