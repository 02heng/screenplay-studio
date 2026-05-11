"""编剧智能体 — 负责剧本圣经、分集粗纲、节拍表、剧本正文。

硬性截断策略（模型不遵守时代码强制执行）：
- episode_skeleton / adapt_outline: episodes 数组截断到 target_episodes
- beat_sheet / script_snippet / episode_scripts: 只保留 episode_range 内的集（小说改编的正文 prose 由 EditorAgent.novel_screenplay 负责裁剪）
"""

from __future__ import annotations

from .base import BaseAgent
from .context import AgentContext, AgentRole
from ..pipelines.episode_range_clip import (
    clip_json_episodes_to_target,
    clip_prose_to_episode_range,
)


class ScreenwriterAgent(BaseAgent):
    role = AgentRole.SCREENWRITER

    def get_phases(self, ctx: AgentContext) -> list[tuple[str, str, str]]:
        if ctx.job_type == "feature":
            from ..prompts import feature
            return feature.phases()

        if ctx.job_type == "novel_adapt":
            from ..prompts import novel_adapt
            all_phases = novel_adapt.phases()
            allowed = {"digest", "adapt_outline"}
            return [(pid, sys, usr) for pid, sys, usr in all_phases if pid in allowed]

        from ..prompts import short_drama
        all_phases = short_drama.phases()

        SCREENWRITER_PHASES = {
            "bible", "episode_skeleton", "adapt_outline",
            "beat_sheet", "script_snippet", "episode_scripts",
            "digest",
        }
        return [(pid, sys, usr) for pid, sys, usr in all_phases if pid in SCREENWRITER_PHASES]

    def max_tokens_for_phase(self, phase_id: str) -> int:
        if phase_id in ("script_snippet", "beat_sheet", "episode_scripts"):
            return 131072
        return 65536

    def post_phase(self, phase_id: str, text: str, ctx: AgentContext) -> None:
        if phase_id == "bible":
            ctx.results[phase_id].summary = text[:8000]

        elif phase_id in ("episode_skeleton", "adapt_outline"):
            self._enforce_episode_count(phase_id, text, ctx)

        elif phase_id in ("beat_sheet", "script_snippet", "episode_scripts"):
            self._enforce_script_range(phase_id, text, ctx)

    def _enforce_episode_count(self, phase_id: str, text: str, ctx: AgentContext) -> None:
        target = ctx.target_episodes
        if target is None:
            return
        new_text = clip_json_episodes_to_target(text, target)
        if new_text != text:
            ctx.results[phase_id].text = new_text

    def _enforce_script_range(self, phase_id: str, text: str, ctx: AgentContext) -> None:
        rs = ctx.episode_range_start
        re_ = ctx.episode_range_end
        if rs is None and re_ is None:
            return

        lo = rs or 1
        hi = re_ if re_ is not None else lo

        new_text = clip_prose_to_episode_range(text, lo, hi)
        if new_text != text:
            ctx.results[phase_id].text = new_text
