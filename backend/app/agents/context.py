"""Agent context, roles, phase result, and handoff data structures.

Inspired by:
- Deep Director: score-based quality gate (≥7/10 PASS threshold)
- Story Claw: sliding-window context budget, validation loops with retry
- XucroYuri/how-to-make-script: bounded handoff packets between agents
- ViMax: central orchestration with retry/fallback logic
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


# ---------------------------------------------------------------------------
# Roles
# ---------------------------------------------------------------------------

class AgentRole(str, Enum):
    DIRECTOR = "director"
    SCREENWRITER = "screenwriter"
    CHARACTER = "character"
    STORYBOARD = "storyboard"
    EDITOR = "editor"


AGENT_LABELS: dict[AgentRole, str] = {
    AgentRole.DIRECTOR: "导演",
    AgentRole.SCREENWRITER: "编剧",
    AgentRole.CHARACTER: "角色设计师",
    AgentRole.STORYBOARD: "分镜导演",
    AgentRole.EDITOR: "剪辑·剧本编辑",
}


# ---------------------------------------------------------------------------
# Handoff Packet — bounded inter-agent state transfer (XucroYuri pattern)
# ---------------------------------------------------------------------------

@dataclass
class HandoffPacket:
    """Bounded context packet passed between agents.

    Instead of dumping all raw text, each agent produces a concise handoff
    that the next agent can consume without context overflow.
    """
    source_agent: AgentRole
    phase_id: str
    working_hypothesis: str = ""
    confidence: float = 1.0          # 0.0 – 1.0
    open_questions: list[str] = field(default_factory=list)
    key_decisions: list[str] = field(default_factory=list)
    recommended_next: str = ""
    needs_human_review: bool = False

    def to_context_str(self, budget: int = 8000) -> str:
        parts = []
        if self.working_hypothesis:
            hypo = self.working_hypothesis[:budget]
            parts.append(f"[结论] {hypo}")
        if self.key_decisions:
            parts.append(f"[决策] " + "；".join(self.key_decisions[:5]))
        if self.open_questions:
            parts.append(f"[待解决] " + "；".join(self.open_questions[:3]))
        if self.confidence < 0.8:
            parts.append(f"[置信度] {self.confidence:.0%}（可能需要复核）")
        return "\n".join(parts)


# ---------------------------------------------------------------------------
# Phase Result
# ---------------------------------------------------------------------------

@dataclass
class PhaseResult:
    phase_id: str
    agent: AgentRole
    text: str
    summary: str = ""
    json_data: dict[str, Any] | None = None
    director_feedback: str = ""
    director_score: int = 0
    revision_needed: bool = False
    retry_count: int = 0
    #: 分镜：解析到的镜头条数（截断前）
    storyboard_raw_shot_count: int = 0
    #: 分镜：截断前是否超过 STORYBOARD_MAX_SHOTS（用于触发自动再生成）
    storyboard_excess_shots: bool = False
    #: 分镜：已由系统触发的「超镜再生成」次数
    storyboard_regen_count: int = 0
    handoff: HandoffPacket | None = None
    completed_at: float = 0.0

    def mark_completed(self) -> None:
        self.completed_at = time.time()


# ---------------------------------------------------------------------------
# Quality Gate Config (Deep Director inspired)
# ---------------------------------------------------------------------------

QUALITY_GATE_THRESHOLD = 7       # score ≥ 7 → PASS; < 7 → REVISE
MAX_RETRY_PER_PHASE = 1          # max retries before forced PASS
CONTEXT_CHAR_BUDGET = 800_000    # sliding-window budget (model supports 100M tokens)
PRIOR_SECTION_BUDGET = 60_000    # max chars per section in build_prior_for
SCRIPT_SECTION_BUDGET = 200_000  # larger budget for full-episode script content


# ---------------------------------------------------------------------------
# Agent Context
# ---------------------------------------------------------------------------

@dataclass
class AgentContext:
    """Shared context across agents — each agent only reads what it needs.

    Context management uses a sliding-window approach with explicit character
    budgets to prevent token overflow (inspired by Story Claw's 80K budget).
    """

    job_type: str = ""
    logline: str = ""
    novel_excerpt: str = ""
    notes: str = ""
    drama_types: str = ""
    target_episodes: int | None = None

    # Incremental generation range
    episode_range_start: int | None = None
    episode_range_end: int | None = None

    # Project memory context (injected from MemoryManager)
    project_id: int | None = None
    memory_context: str = ""

    results: dict[str, PhaseResult] = field(default_factory=dict)
    handoffs: dict[str, HandoffPacket] = field(default_factory=dict)

    # Progress tracking for resume support
    completed_phases: list[str] = field(default_factory=list)
    started_at: float = field(default_factory=time.time)

    def add_result(self, r: PhaseResult) -> None:
        r.mark_completed()
        self.results[r.phase_id] = r
        if r.phase_id not in self.completed_phases:
            self.completed_phases.append(r.phase_id)

    def add_handoff(self, h: HandoffPacket) -> None:
        self.handoffs[h.phase_id] = h

    def get_text(self, phase_id: str) -> str:
        r = self.results.get(phase_id)
        return r.text if r else ""

    def get_summary(self, phase_id: str) -> str:
        r = self.results.get(phase_id)
        return r.summary if r else ""

    def is_phase_done(self, phase_id: str) -> bool:
        return phase_id in self.completed_phases

    def progress_pct(self, total_phases: int) -> int:
        if total_phases <= 0:
            return 0
        return min(100, int(len(self.completed_phases) / total_phases * 100))

    # -----------------------------------------------------------------------
    # Context building with budget (sliding-window pattern)
    # -----------------------------------------------------------------------

    def _truncate(self, text: str, budget: int = PRIOR_SECTION_BUDGET) -> str:
        if len(text) <= budget:
            return text
        return text[:budget] + "\n…（已截断）"

    def build_prior_for(self, agent: AgentRole, *, phase_id: str | None = None) -> str:
        """Build a condensed prior context string tailored to the agent.

        Uses handoff packets when available (preferred), falling back to
        summaries or truncated text. Each section is capped to prevent
        context overflow.

        ``phase_id`` disambiguates EditorAgent: ``novel_screenplay`` needs
        outline/人物 prior; ``edit_script`` needs storyboard JSON.
        """
        parts: list[str] = []
        budget = PRIOR_SECTION_BUDGET

        def _add(pid: str, *, prefer_handoff: bool = True) -> None:
            if prefer_handoff and pid in self.handoffs:
                txt = self.handoffs[pid].to_context_str(budget)
            else:
                txt = self.get_summary(pid) or self._truncate(self.get_text(pid), budget)
            if txt:
                parts.append(f"=== {pid} ===\n{txt}")

        # Include director feedback for revision context
        def _add_feedback(pid: str) -> None:
            r = self.results.get(pid)
            if r and r.director_feedback and r.revision_needed:
                parts.append(f"=== 导演反馈({pid}) ===\n{self._truncate(r.director_feedback, 800)}")

        if agent == AgentRole.SCREENWRITER:
            for pid in ("bible", "characters_summary", "episode_skeleton", "beat_sheet"):
                _add(pid)
                _add_feedback(pid)

        elif agent == AgentRole.CHARACTER:
            if self.job_type == "novel_adapt":
                for pid in ("digest",):
                    _add(pid, prefer_handoff=False)
                    _add_feedback(pid)
            else:
                for pid in ("bible",):
                    _add(pid, prefer_handoff=False)
                    _add_feedback(pid)

        elif agent == AgentRole.STORYBOARD:
            # Character summary — use handoff/summary (compact)
            _add("characters_summary")

            from ..project_episode_scripts import storyboard_bundle_for_prior

            rs = self.episode_range_start
            re_ = self.episode_range_end
            single_ep_focus = rs is not None and re_ is not None and rs == re_

            script_chunks: list[str] = []
            # 单集分镜任务：不拼接「集数库」全书剧本，仅靠本轮 novel_screenplay / script 输出，缩小上下文
            if not single_ep_focus and self.project_id:
                bundle = storyboard_bundle_for_prior(
                    self.project_id, budget=min(120_000, SCRIPT_SECTION_BUDGET)
                )
                if bundle.strip():
                    script_chunks.append(bundle)

            # Script content — MUST use full phase text, not the truncated handoff.
            for pid in ("script_snippet", "episode_scripts", "novel_screenplay"):
                raw = self.get_text(pid)
                if raw:
                    txt = self._truncate(raw, SCRIPT_SECTION_BUDGET)
                    script_chunks.append(f"=== {pid}（本轮流水线输出）===\n{txt}")
                    break

            if script_chunks:
                merged = "\n\n".join(script_chunks)
                if len(merged) > SCRIPT_SECTION_BUDGET:
                    merged = merged[:SCRIPT_SECTION_BUDGET] + "\n…（剧本上下文已截断）"
                parts.append(merged)

        elif agent == AgentRole.EDITOR:
            if phase_id == "novel_screenplay":
                _add("characters_summary")
                for pid in ("digest", "adapt_outline"):
                    _add(pid, prefer_handoff=False)
                    _add_feedback(pid)
            elif phase_id == "production_checklist":
                for pid in ("adapt_outline", "novel_screenplay", "storyboard", "edit_script"):
                    raw = self.get_text(pid)
                    if raw:
                        parts.append(f"=== {pid} ===\n{self._truncate(raw, 25000)}")
            else:
                raw = self.get_text("storyboard")
                if raw:
                    txt = self._truncate(raw, SCRIPT_SECTION_BUDGET)
                    parts.append(f"=== storyboard ===\n{txt}")

        elif agent == AgentRole.DIRECTOR:
            for pid, r in self.results.items():
                s = r.summary or self._truncate(r.text, 600)
                parts.append(f"=== {pid} ===\n{s}")

        total = "\n\n".join(parts[-4:])
        if len(total) > CONTEXT_CHAR_BUDGET:
            total = total[:CONTEXT_CHAR_BUDGET] + "\n…（上下文已达预算上限，已截断）"
        return total

    # -----------------------------------------------------------------------
    # Character summary helper
    # -----------------------------------------------------------------------

    def summarize_characters(self) -> str:
        r = self.results.get("characters")
        if not r or not r.json_data:
            return self._truncate(self.get_text("characters"), 800)
        chars = r.json_data.get("characters", [])
        lines = []
        for c in chars:
            if not isinstance(c, dict):
                continue
            name = c.get("name", "?")
            role = c.get("role", "")
            identity = c.get("identity", "")
            lines.append(f"- {name}（{role}）：{identity}")
        summary = "\n".join(lines)
        self.results.setdefault(
            "characters_summary",
            PhaseResult(
                phase_id="characters_summary",
                agent=AgentRole.CHARACTER,
                text=summary,
                summary=summary,
            ),
        )
        return summary

    # -----------------------------------------------------------------------
    # Serialization for resume support
    # -----------------------------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        """Serialize minimal state for resume/checkpoint."""
        return {
            "job_type": self.job_type,
            "completed_phases": self.completed_phases,
            "started_at": self.started_at,
            "results_summary": {
                pid: {
                    "agent": r.agent.value,
                    "summary": r.summary or r.text[:3000],
                    "score": r.director_score,
                    "retry_count": r.retry_count,
                }
                for pid, r in self.results.items()
            },
        }
