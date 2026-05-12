"""续写 / 增量生成：向角色智能体注入「库中已有角色」摘要。"""

from __future__ import annotations

from sqlmodel import Session, select

from .db import engine
from .db.models import Character


def existing_characters_prior_block(project_id: int, *, budget: int = 14_000) -> str:
    """供 AgentContext.build_prior_for(CHARACTER) 拼接。"""
    with Session(engine()) as session:
        chars = session.exec(
            select(Character).where(Character.project_id == project_id).order_by(Character.created_at)
        ).all()
    if not chars:
        return ""

    lines: list[str] = [
        "=== 本项目角色库已有条目（续写/增量时请：**同名视为同一人**，若有设定变更须在输出 JSON 中给出该角色的**完整修订字段**；亦可追加 wholly new 角色）===",
    ]
    for c in chars:
        desc = (c.description or "").strip().replace("\n", " ")
        if len(desc) > 600:
            desc = desc[:600] + "…"
        lines.append(f"- **{c.name}**：{desc if desc else '（暂无描述）'}")
    block = "\n".join(lines)
    if len(block) > budget:
        block = block[:budget] + "\n…（角色库摘要已截断）"
    return block
