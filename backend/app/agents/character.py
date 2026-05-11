"""角色设计师智能体 — 负责人物档案 + 角色板提示词生成。

角色板提示词是给用户复制去文生图模型的完整提示词，
由后端模板框架 + 模型填充角色造型细节 生成。
"""

from __future__ import annotations

import json

from .base import BaseAgent
from .context import AgentContext, AgentRole


class CharacterAgent(BaseAgent):
    role = AgentRole.CHARACTER

    def get_phases(self, ctx: AgentContext) -> list[tuple[str, str, str]]:
        if ctx.job_type == "novel_adapt":
            from ..prompts import novel_adapt
            all_phases = novel_adapt.phases()
        elif ctx.job_type == "short_drama":
            from ..prompts import short_drama
            all_phases = short_drama.phases()
        else:
            return []

        return [(pid, sys, usr) for pid, sys, usr in all_phases if pid == "characters"]

    def max_tokens_for_phase(self, phase_id: str) -> int:
        return 65536

    def post_phase(self, phase_id: str, text: str, ctx: AgentContext) -> None:
        if phase_id != "characters":
            return
        try:
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                data = json.loads(text[start:end])
                ctx.results[phase_id].json_data = data
        except (json.JSONDecodeError, ValueError):
            pass
        ctx.summarize_characters()
