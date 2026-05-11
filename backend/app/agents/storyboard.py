"""分镜导演智能体 — 负责将剧本转化为逐镜头拍摄方案。

硬性约束：post_phase 会过滤 episode_range 之外的镜头；单响应镜头条数不得超过
STORYBOARD_MAX_SHOTS，超出则从数组头部截断，并打上 storyboard_excess_shots 供编排器重试。
"""

from __future__ import annotations

import json

from .base import BaseAgent
from .context import AgentContext, AgentRole
from ..pipelines.episode_range_clip import (
    STORYBOARD_MAX_SHOTS,
    clip_storyboard_json_by_ep_range,
    parse_storyboard_shot_list,
)


class StoryboardAgent(BaseAgent):
    role = AgentRole.STORYBOARD

    def get_phases(self, ctx: AgentContext) -> list[tuple[str, str, str]]:
        if ctx.job_type == "feature":
            return []

        if ctx.job_type == "novel_adapt":
            from ..prompts import novel_adapt
            all_phases = novel_adapt.phases()
        else:
            from ..prompts import short_drama
            all_phases = short_drama.phases()

        return [(pid, sys, usr) for pid, sys, usr in all_phases if pid == "storyboard"]

    def max_tokens_for_phase(self, phase_id: str) -> int:
        return 131072

    def post_phase(self, phase_id: str, text: str, ctx: AgentContext) -> None:
        if phase_id == "storyboard":
            self._enforce_storyboard_limits(phase_id, text, ctx)

    def _enforce_storyboard_limits(self, phase_id: str, text: str, ctx: AgentContext) -> None:
        """按集范围过滤后再按镜头条数硬截断；无法解析则不修改正文。"""
        r = ctx.results.get(phase_id)
        if not r:
            return

        t = text
        rs = ctx.episode_range_start
        re_ = ctx.episode_range_end
        if rs is not None or re_ is not None:
            lo = rs or 1
            hi = re_ or lo
            new_text = clip_storyboard_json_by_ep_range(t, lo, hi)
            if new_text is not None:
                t = new_text

        arr = parse_storyboard_shot_list(t)
        if arr is None:
            return

        n = len(arr)
        r.storyboard_raw_shot_count = n
        r.storyboard_excess_shots = n > STORYBOARD_MAX_SHOTS
        if r.storyboard_excess_shots:
            arr = arr[:STORYBOARD_MAX_SHOTS]

        r.text = json.dumps(arr, ensure_ascii=False, indent=2)
