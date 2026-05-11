"""导演智能体 — 操控全局，审查各阶段产出并给出修改意见。

参考项目：
- Deep Director: 100 分制质量门控（阈值 85/100），不合格定向打回
- CoDi (AIIDE 2025): Director-Actor 协作模式
- ViMax: 中央编排 + 重试/回退逻辑

我们采用 10 分制，阈值 ≥7 分为 PASS，< 7 分为 REVISE。
每个阶段最多重试 MAX_RETRY_PER_PHASE 次，超限强制通过。
"""

from __future__ import annotations

import json
from typing import Iterator

from ..llm.client import stream_chat
from ..llm.presets import ProviderPreset
from .context import (
    AgentContext, AgentRole, AGENT_LABELS,
    QUALITY_GATE_THRESHOLD, MAX_RETRY_PER_PHASE,
)

_REVIEW_SYS = """你是一位资深竖屏短剧导演，正在做项目质控评审。

你的职责：
1. 审查下属智能体（编剧/角色/分镜/剪辑）提交的阶段成果
2. 按 1-10 分打分，≥7 分判 PASS，<7 分判 REVISE
3. 若判 REVISE，必须给出 2-3 条具体、可执行的修改意见（指出原文哪里有问题、怎么改）
4. 确保所有产出符合竖屏短剧平台规范

输出固定 JSON（只输出 JSON，不要前言后语）：
{
  "verdict": "PASS" 或 "REVISE",
  "score": 1-10,
  "notes": "整体评价（一句话）",
  "issues": ["问题1", "问题2"],
  "suggestions": ["修改建议1", "修改建议2"]
}

评审时注意：节奏紧凑、台词口语化、钩子强烈、格式规范。
第一轮宽容一些：只在发现严重方向错误（如主角设定偏离梗概、钩子缺失、
逻辑硬伤）时才判 REVISE，小瑕疵打低分但仍 PASS。
重试轮时更严格：检查上轮反馈的问题是否已修正。"""

_REVISION_SYS_SUFFIX = """

本次是第 {retry_round} 轮重审。上轮已明确要求修正以下问题：
{prev_feedback}

请重点检查这些问题是否已解决。若已解决即可 PASS，若仍未解决则继续 REVISE。"""


def _review_prompt(
    phase_id: str,
    agent_label: str,
    content: str,
    ctx: AgentContext,
    *,
    retry_round: int = 0,
    prev_feedback: str = "",
) -> str:
    base = f"""请审查「{agent_label}」提交的「{phase_id}」阶段成果。

项目梗概：{ctx.logline or ctx.novel_excerpt[:2000] or '（无）'}
类型标签：{ctx.drama_types or '（无）'}

以下是需要审查的内容：
{content[:60000]}"""

    if retry_round > 0 and prev_feedback:
        base += f"\n\n【上轮导演反馈（第{retry_round}轮）】\n{prev_feedback[:6000]}"
    return base


class DirectorAgent:
    role = AgentRole.DIRECTOR

    def review_phase(
        self,
        preset: ProviderPreset,
        phase_id: str,
        source_agent: AgentRole,
        ctx: AgentContext,
        *,
        llm_api_key: str = "",
    ) -> Iterator[str]:
        """Review a completed phase, yield SSE events.

        Returns parsed review data as a dict for the orchestrator to decide
        whether a retry is needed.
        """

        def emit(obj: dict) -> str:
            return json.dumps(obj, ensure_ascii=False) + "\n"

        label = AGENT_LABELS.get(source_agent, source_agent.value)
        content = ctx.get_text(phase_id)
        if not content:
            # 避免无 SSE、revision_needed 仍为 True 导致编排层误判死循环
            result = ctx.results.get(phase_id)
            if result:
                result.revision_needed = False
                result.director_feedback = result.director_feedback or "（本阶段暂无输出可审）"
                result.director_score = result.director_score or 0
            yield emit({
                "type": "director_review",
                "phase_id": phase_id,
                "agent": source_agent.value,
                "verdict": "PASS",
                "score": 0,
                "retry_round": getattr(result, "retry_count", 0) if result else 0,
                "max_retry": MAX_RETRY_PER_PHASE,
                "feedback": "（跳过：无正文）",
            })
            return

        result = ctx.results.get(phase_id)
        retry_round = result.retry_count if result else 0
        prev_feedback = result.director_feedback if result and retry_round > 0 else ""

        system = _REVIEW_SYS
        if retry_round > 0:
            system += _REVISION_SYS_SUFFIX.format(
                retry_round=retry_round,
                prev_feedback=prev_feedback[:6000],
            )

        yield emit({
            "type": "director_review_start",
            "phase_id": phase_id,
            "agent": source_agent.value,
            "retry_round": retry_round,
        })

        user_msg = _review_prompt(
            phase_id, label, content, ctx,
            retry_round=retry_round,
            prev_feedback=prev_feedback,
        )

        buf: list[str] = []
        for chunk in stream_chat(
            preset,
            system=system,
            user=user_msg,
            temperature=0.3,
            max_tokens=8192,
            api_key_override=llm_api_key.strip() or None,
        ):
            buf.append(chunk)

        review_text = "".join(buf).strip()
        verdict = "PASS"
        score = 8
        feedback = review_text

        try:
            start = review_text.find("{")
            end = review_text.rfind("}") + 1
            if start >= 0 and end > start:
                obj = json.loads(review_text[start:end])
                score = int(obj.get("score", 8))
                notes = obj.get("notes", "")
                issues = obj.get("issues", [])
                suggestions = obj.get("suggestions", [])
                feedback = notes
                if issues:
                    feedback += "\n问题：" + "；".join(issues)
                if suggestions:
                    feedback += "\n建议：" + "；".join(suggestions)

                # Score-based verdict (Deep Director pattern)
                raw_verdict = obj.get("verdict", "").upper()
                if raw_verdict == "REVISE" or score < QUALITY_GATE_THRESHOLD:
                    verdict = "REVISE"
                else:
                    verdict = "PASS"
        except (json.JSONDecodeError, ValueError):
            pass

        # Enforce max retry limit — force PASS if exceeded
        if verdict == "REVISE" and result and result.retry_count >= MAX_RETRY_PER_PHASE:
            verdict = "PASS"
            feedback += f"\n（已达最大重试次数 {MAX_RETRY_PER_PHASE}，强制通过）"

        if result:
            result.director_feedback = feedback
            result.director_score = score
            result.revision_needed = verdict == "REVISE"

        yield emit({
            "type": "director_review",
            "phase_id": phase_id,
            "agent": source_agent.value,
            "verdict": verdict,
            "score": score,
            "retry_round": retry_round,
            "max_retry": MAX_RETRY_PER_PHASE,
            "feedback": feedback,
        })
