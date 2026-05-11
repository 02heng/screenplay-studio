"""剪辑师 / 剧本编辑智能体。

- **novel_adapt**：先做「小说→剧本正文」(`novel_screenplay`)，再做剪辑 (`edit_script`)。
- **short_drama**：仅剪辑与时间线。

硬性截断：post_phase 按 episode_range 裁剪剧本 prose / 剪辑 JSON。
"""

from __future__ import annotations

from .base import BaseAgent
from .context import AgentContext, AgentRole
from ..pipelines.episode_range_clip import (
    clip_edit_timeline_by_ep_range,
    clip_prose_to_episode_range,
)


class EditorAgent(BaseAgent):
    role = AgentRole.EDITOR

    def get_phases(self, ctx: AgentContext) -> list[tuple[str, str, str]]:
        if ctx.job_type == "feature":
            return []

        if ctx.job_type == "novel_adapt":
            from ..prompts import novel_adapt
            all_phases = novel_adapt.phases()
            allow = {"novel_screenplay", "edit_script", "production_checklist"}
        else:
            from ..prompts import short_drama
            all_phases = short_drama.phases()
            allow = {"edit_script", "production_checklist"}

        return [(pid, sys, usr) for pid, sys, usr in all_phases if pid in allow]

    def max_tokens_for_phase(self, phase_id: str) -> int:
        return 131072

    def post_phase(self, phase_id: str, text: str, ctx: AgentContext) -> None:
        if phase_id == "novel_screenplay":
            self._enforce_script_range(phase_id, text, ctx)
        elif phase_id == "edit_script":
            self._enforce_ep_range(phase_id, text, ctx)

    def _enforce_script_range(
        self, phase_id: str, text: str, ctx: AgentContext
    ) -> None:
        rs = ctx.episode_range_start
        re_ = ctx.episode_range_end
        if rs is None and re_ is None:
            return
        lo = rs or 1
        hi = re_ if re_ is not None else lo
        new_text = clip_prose_to_episode_range(text, lo, hi)
        if new_text != text:
            ctx.results[phase_id].text = new_text

    def _enforce_ep_range(
        self, phase_id: str, text: str, ctx: AgentContext
    ) -> None:
        """Hard-filter edit_script: remove timeline cuts outside episode range."""
        rs = ctx.episode_range_start
        re_ = ctx.episode_range_end
        if rs is None and re_ is None:
            return

        lo = rs or 1
        hi = re_ or lo

        new_text = clip_edit_timeline_by_ep_range(text, lo, hi)
        if new_text is not None:
            ctx.results[phase_id].text = new_text
