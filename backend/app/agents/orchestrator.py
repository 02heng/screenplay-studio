"""Orchestrator — coordinates multiple agents with interleaved execution.

Inspired by:
- Deep Director: Showrunner orchestrator + score-based quality gate + retry loop
- ViMax: Central orchestration with Agent Scheduling / Retry / Fallback
- Story Claw: Progress tracking, validation loops (up to N retries), resume
- CoDi: Director-Actor paradigm with turn limits
- XucroYuri: Bounded handoff packets between specialists

Execution flow (short_drama):
  1. Screenwriter: bible
  2. Director reviews bible (score ≥ 7 → PASS, else retry)
  3. Character: characters
  4. Director reviews characters
  5. Screenwriter: episode_skeleton → beat_sheet → script_snippet
  6. Director reviews script_snippet
  7. Storyboard: storyboard
  8. Director reviews storyboard
  9. Editor: edit_script
  10. Director reviews edit_script
  11. After each PASS（剧本/分镜/剪辑）：服务端入库校验 persist_verify；失败则「仅格式」自愈重试

Execution flow (novel_adapt):
  1. Screenwriter: digest → Director reviews digest
  2. Character: characters → Director reviews
  3. Screenwriter: adapt_outline → Director reviews
  4. **Per episode** (剧本→分镜→剪辑，控制单次上下文规模)：
     Editor: novel_screenplay → Director
     Storyboard: storyboard → Director
     Editor: edit_script → Director
  5. Editor: production_checklist（全剧汇总）
  6. 上述「剧本→分镜→剪辑」每阶段在导演 PASS 后执行 persist_verify 入库与格式自愈（若绑定 project_id）

**续写（episode_range_start > 1）** 在完成一轮 characters 之后，对上述第 4 步 **逐集循环沿用同一 `_run_agent_phases` 路径**：
导演审查 screenplay / storyboard / edit_script 的 JSON／正文，
PASS 后与冷启动相同的 `persist_verify` + 角色 JSON 门控入库；并未跳过数据库校验。

Each agent gets an independent context window — only handoff packets / summaries
of prior phases, not the full raw text — preventing context overflow.
"""

from __future__ import annotations

import json
import time
from typing import Iterator

from sqlmodel import Session

from ..db import engine
from ..llm.presets import ProviderPreset
from ..pipelines.character_export_parse import parse_character_export
from ..pipelines.episode_range_clip import STORYBOARD_MAX_SHOTS
from ..services.phase_project_persist import PERSIST_GATE_PHASES, persist_phase_after_director_pass
from .base import BaseAgent
from .context import (
    AgentContext, AgentRole, AGENT_LABELS,
    PhaseResult, HandoffPacket,
    MAX_RETRY_PER_PHASE,
)
from .director import DirectorAgent
from .screenwriter import ScreenwriterAgent
from .character import CharacterAgent
from .storyboard import StoryboardAgent
from .editor import EditorAgent


_REVIEW_GATES = {
    "bible", "digest",
    "characters",
    "adapt_outline",
    "script_snippet", "episode_scripts",
    "novel_screenplay",
    "storyboard",
    "edit_script",
}


# 分镜单响应超 STORYBOARD_MAX_SHOTS 条时，额外再生成（不占用导演 REVISE 重试配额）
STORYBOARD_OVERCAP_REGEN_ATTEMPTS = 1

# 导演 PASS 后入库失败时，「仅修正格式」的最大额外重试次数（不经过导演再审）
FORMAT_PERSIST_MAX_RETRIES = 2

# characters：导演通过后 JSON 仍无法入库时的自愈重试（不占用导演 REVISE 配额）
CHARACTER_JSON_MAX_RETRIES = 2


def _parse_adapt_outline_episode_count(text: str) -> int | None:
    """Read total episode count from adapt_outline JSON if present."""
    if not text or not text.strip():
        return None
    raw = text.strip()
    fence = raw.find("```")
    if fence >= 0:
        inner = raw[fence:]
        nl = inner.find("\n")
        if nl > 0:
            inner = inner[nl + 1 :]
        end_fence = inner.rfind("```")
        if end_fence > 0:
            raw = inner[:end_fence].strip()
    try:
        start = raw.find("{")
        end = raw.rfind("}") + 1
        if start < 0 or end <= start:
            return None
        data = json.loads(raw[start:end])
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    meta = data.get("adaptation_meta") or {}
    te = meta.get("total_episodes")
    if isinstance(te, int) and te >= 1:
        return min(te, 120)
    eps = data.get("episodes")
    if isinstance(eps, list) and len(eps) >= 1:
        return min(len(eps), 120)
    return None


class _Step:
    """One step in the orchestration plan."""

    __slots__ = ("agent", "phase_ids")

    def __init__(self, agent: BaseAgent, phase_ids: list[str]):
        self.agent = agent
        self.phase_ids = phase_ids


class Orchestrator:
    """Run the multi-agent pipeline, yielding SSE events.

    Key improvements over the v1 orchestrator:
    - Quality gate with automatic retry (Deep Director pattern)
    - Handoff packet generation between agent steps
    - Progress percentage tracking with phase completion events
    - Context budget enforcement (sliding-window)
    - Snapshot support for future resume capability
    """

    def __init__(
        self,
        preset: ProviderPreset,
        ctx: AgentContext,
        *,
        llm_api_key: str = "",
        enable_director_review: bool = True,
    ):
        self.preset = preset
        self.ctx = ctx
        self.llm_api_key = llm_api_key
        self.enable_review = enable_director_review

        self.director = DirectorAgent()
        self.screenwriter = ScreenwriterAgent()
        self.character = CharacterAgent()
        self.storyboard_agent = StoryboardAgent()
        self.editor_agent = EditorAgent()

        self._total_phases = 0
        self._done_phases = 0

    def _sse_meta_quality_contract(self) -> dict[str, object]:
        """SSE「meta」中声明：导演门控 / 通过后入库校验 / 是否与项目绑定写库。"""
        ctx = self.ctx
        return {
            "director_quality_gate_enabled": bool(self.enable_review),
            "post_pass_persist_verify": True,
            "server_db_write_enabled": ctx.project_id is not None,
        }

    def _emit(self, obj: dict) -> str:
        return json.dumps(obj, ensure_ascii=False) + "\n"

    def _progress_pct(self) -> int:
        if self._total_phases <= 0:
            return 0
        return min(100, int(self._done_phases / self._total_phases * 100))

    def _storyboard_phase_hard_hints(self) -> str:
        """Inject per-phase storyboard constraints (shot count, duration, single-ep scope)."""
        ctx = self.ctx
        rs, re_ = ctx.episode_range_start, ctx.episode_range_end
        lines = [
            (
                "【输出条数 · 硬性】分镜必须为**单层 JSON 数组**；数组元素（镜头对象）个数**不得超过 45 条**。"
                "超出将被截断并由系统驳回重跑一次，请以合并景别与场次的方式控制在 45 条内。"
            ),
            "【本集成片总时长 · 硬性】本分镜中**该集**所有镜头的 duration_sec **之和须为 90～120 秒（含边界）**；timecode 顺接，末尾落在集末钩子处。",
            "【镜头体量】在单镜 **2.0～4.0** 秒前提下，镜头数通常约 **26～42**；不得用「极少镜+超时」或大量亚 2 秒快切凑数。",
            "【单镜时长 · 硬性】每个镜头的 duration_sec 必须在 **2.0～4.0** 秒（含边界）；timecode_in / timecode_out 须与该时长一致。",
            "【节奏】靠景别变化、正反打与场次切换把控张力。",
        ]
        if rs is not None and re_ is not None and rs == re_:
            ep = rs
            head = (
                f"【范围 · 硬性】本次**仅**输出第 {ep} 集的分镜 JSON（shot_id / scene 均以 **EP{ep:02d}-** 开头），"
                "禁止写入其它集。"
            )
            return "\n".join([head, *lines])
        return "\n".join(lines)

    def _estimate_novel_adapt_episode_count(self) -> int:
        """Upper-bound estimate for progress metadata before adapt_outline exists."""
        ctx = self.ctx
        rs, re_ = ctx.episode_range_start, ctx.episode_range_end
        if rs is not None:
            if re_ is not None:
                hi = re_
            elif ctx.target_episodes is not None:
                hi = max(rs, min(ctx.target_episodes, 120))
            else:
                hi = rs
            return max(1, min(hi - rs + 1, 120))
        te = ctx.target_episodes
        if te is not None:
            return max(1, min(te, 120))
        return 12

    def _novel_adapt_episode_bounds_after_preflight(self) -> tuple[int, int]:
        """Resolve first..last episode index after digest/characters/adapt_outline."""
        ctx = self.ctx
        rs, re_ = ctx.episode_range_start, ctx.episode_range_end
        if rs is not None:
            lo = rs
            if re_ is not None:
                hi = re_
            elif ctx.target_episodes is not None:
                hi = max(lo, min(ctx.target_episodes, 120))
            else:
                hi = lo
            return lo, hi
        te = ctx.target_episodes
        if te is not None:
            return 1, max(1, min(te, 120))
        parsed = _parse_adapt_outline_episode_count(ctx.get_text("adapt_outline"))
        if parsed is not None:
            return 1, parsed
        return 1, 1

    def _novel_adapt_continue_bounds(self) -> tuple[int, int]:
        ctx = self.ctx
        lo = ctx.episode_range_start or 1
        hi = ctx.episode_range_end or lo
        return lo, hi

    def _run_novel_adapt_episodic(self) -> Iterator[str]:
        """novel_adapt：大纲前置后按集循环「剧本→分镜→剪辑」，最后制作清单。

        续写模式（episode_range_start>1）：在每批逐集循环**之前**先跑一轮 characters（增量人物表），再进入各集 screenplay→storyboard→edit。
        「续写」与冷启动在完成 digest/adapt_outline 之后的**逐集三相**完全一致：`_run_agent_phases`、导演审稿、PASS 后的 persist_verify /
        characters JSON 校验（均由 `AgentContext.project_id` 决定是否写库）。
        """
        ctx = self.ctx
        is_continue = self._is_continue_mode()
        agents_seen = ["screenwriter", "character", "editor", "storyboard"]

        if is_continue:
            lo, hi = self._novel_adapt_continue_bounds()
            if hi < lo:
                raise RuntimeError("续写需要提供合法的集数范围（起始≤结束）")
            n_ep = hi - lo + 1
            self._total_phases = n_ep * 3 + 2
            self._done_phases = 0

            yield self._emit({
                "type": "meta",
                "job_type": ctx.job_type,
                "phases_total": self._total_phases,
                "pipeline": "multi_agent",
                "agents": agents_seen,
                "quality_gate_threshold": 7,
                "max_retry_per_phase": MAX_RETRY_PER_PHASE,
                "continue_mode": True,
                "episode_range": [lo, hi],
                "novel_episodic": True,
                "has_memory": bool(ctx.memory_context),
                **self._sse_meta_quality_contract(),
                "novel_continue_same_gates_zh": (
                    "续写：characters + 逐集 screenplay/storyboard/edit_script "
                    "均经导演审稿，通过后 persist_verify 入库（绑定项目时）；侧栏由各阶段事件刷新。"
                ),
            })

            orig_rs, orig_re = ctx.episode_range_start, ctx.episode_range_end

            yield from self._run_agent_phases(self.character, {"characters"})

            for ep in range(lo, hi + 1):
                yield self._emit({
                    "type": "episode_block",
                    "episode": ep,
                    "episode_end": hi,
                    "job_type": "novel_adapt",
                })
                ctx.episode_range_start = ctx.episode_range_end = ep
                yield from self._run_agent_phases(self.editor_agent, {"novel_screenplay"})
                yield from self._run_agent_phases(self.storyboard_agent, {"storyboard"})
                yield from self._run_agent_phases(self.editor_agent, {"edit_script"})

            ctx.episode_range_start, ctx.episode_range_end = orig_rs, orig_re

            yield from self._run_agent_phases(self.editor_agent, {"production_checklist"})

            memory_saved = self._save_to_memory()
            yield self._emit({"type": "snapshot", "data": ctx.snapshot()})
            yield self._emit({
                "type": "done",
                "progress_pct": 100,
                "elapsed_sec": round(time.time() - ctx.started_at, 1),
                "memory_saved": memory_saved,
            })
            return

        est_n = self._estimate_novel_adapt_episode_count()
        self._total_phases = 3 + est_n * 3 + 1
        self._done_phases = 0

        yield self._emit({
            "type": "meta",
            "job_type": ctx.job_type,
            "phases_total": self._total_phases,
            "pipeline": "multi_agent",
            "agents": agents_seen,
            "quality_gate_threshold": 7,
            "max_retry_per_phase": MAX_RETRY_PER_PHASE,
            "continue_mode": False,
            "episode_range": (
                [ctx.episode_range_start, ctx.episode_range_end]
                if ctx.episode_range_start else None
            ),
            "novel_episodic": True,
            "has_memory": bool(ctx.memory_context),
            **self._sse_meta_quality_contract(),
        })

        yield from self._run_agent_phases(self.screenwriter, {"digest"})
        yield from self._run_agent_phases(self.character, {"characters"})
        yield from self._run_agent_phases(self.screenwriter, {"adapt_outline"})

        lo, hi = self._novel_adapt_episode_bounds_after_preflight()
        if hi < lo:
            raise RuntimeError("分集体量无效：请在补充中填写目标集数，或检查 adapt_outline JSON 中的 episodes")

        real_n = hi - lo + 1
        self._total_phases = 3 + real_n * 3 + 1

        yield self._emit({
            "type": "meta",
            "job_type": ctx.job_type,
            "phases_total": self._total_phases,
            "pipeline": "multi_agent",
            "agents": agents_seen,
            "episode_plan": [lo, hi],
            "novel_episodic": True,
            **self._sse_meta_quality_contract(),
        })

        orig_rs, orig_re = ctx.episode_range_start, ctx.episode_range_end

        for ep in range(lo, hi + 1):
            yield self._emit({
                "type": "episode_block",
                "episode": ep,
                "episode_end": hi,
                "job_type": "novel_adapt",
            })
            ctx.episode_range_start = ctx.episode_range_end = ep
            yield from self._run_agent_phases(self.editor_agent, {"novel_screenplay"})
            yield from self._run_agent_phases(self.storyboard_agent, {"storyboard"})
            yield from self._run_agent_phases(self.editor_agent, {"edit_script"})

        ctx.episode_range_start, ctx.episode_range_end = orig_rs, orig_re

        yield from self._run_agent_phases(self.editor_agent, {"production_checklist"})

        memory_saved = self._save_to_memory()
        yield self._emit({"type": "snapshot", "data": ctx.snapshot()})
        yield self._emit({
            "type": "done",
            "progress_pct": 100,
            "elapsed_sec": round(time.time() - ctx.started_at, 1),
            "memory_saved": memory_saved,
        })

    def run(self) -> Iterator[str]:
        ctx = self.ctx
        if ctx.job_type == "novel_adapt":
            yield from self._run_novel_adapt_episodic()
            return

        steps = self._build_steps()

        self._total_phases = sum(len(s.phase_ids) for s in steps)
        self._done_phases = 0

        agents_seen: list[str] = []
        for s in steps:
            v = s.agent.role.value
            if v not in agents_seen:
                agents_seen.append(v)

        is_continue = self._is_continue_mode()
        yield self._emit({
            "type": "meta",
            "job_type": ctx.job_type,
            "phases_total": self._total_phases,
            "pipeline": "multi_agent",
            "agents": agents_seen,
            "quality_gate_threshold": 7,
            "max_retry_per_phase": MAX_RETRY_PER_PHASE,
            "continue_mode": is_continue,
            "episode_range": (
                [ctx.episode_range_start, ctx.episode_range_end]
                if ctx.episode_range_start else None
            ),
            "has_memory": bool(ctx.memory_context),
            **self._sse_meta_quality_contract(),
        })

        for step in steps:
            phase_set = set(step.phase_ids)
            for event in self._run_agent_phases(step.agent, phase_set):
                yield event

        # Auto-save results to project memory system
        memory_saved = self._save_to_memory()

        # Emit final snapshot for potential resume
        yield self._emit({
            "type": "snapshot",
            "data": ctx.snapshot(),
        })

        yield self._emit({
            "type": "done",
            "progress_pct": 100,
            "elapsed_sec": round(time.time() - ctx.started_at, 1),
            "memory_saved": memory_saved,
        })

    def _run_character_export_gate(
        self,
        agent: BaseAgent,
        phase_id: str,
        system: str,
        tmpl: str,
    ) -> Iterator[str]:
        """导演通过后：校验 characters JSON 可入库；失败则仅「格式自愈」重生成。"""
        if phase_id != "characters":
            return
        result = self.ctx.results.get(phase_id)
        if not result or not result.text.strip():
            yield self._emit({
                "type": "character_export_verify",
                "phase_id": phase_id,
                "ok": False,
                "detail": "无阶段文本",
            })
            return

        hint_intro = (
            "\n\n【系统强制 · JSON 校验失败】导演已通过，但工作台仍无法解析你的角色输出。"
            "请输出**单一合法 JSON**（可包在 ```json 围栏内），顶层须有键 \"characters\" 为非空数组；"
            "每项须有非空 \"name\"。**仅修正格式与字段类型，勿删改已有角色的设定语义**。\n\n【解析错误】\n"
        )

        while True:
            txt = self.ctx.results[phase_id].text
            rows, err = parse_character_export(txt)
            yield self._emit({
                "type": "character_export_verify",
                "phase_id": phase_id,
                "ok": rows is not None and len(rows) > 0,
                "detail": "JSON 结构校验通过" if rows else err,
                "character_retry": result.character_json_retries,
            })
            if rows:
                return

            result.character_json_retries += 1
            if result.character_json_retries > CHARACTER_JSON_MAX_RETRIES:
                yield self._emit({
                    "type": "character_export_verify",
                    "phase_id": phase_id,
                    "ok": False,
                    "detail": err + f"（已达 JSON 自愈上限 {CHARACTER_JSON_MAX_RETRIES}）",
                    "fallback_raw_import": True,
                })
                return

            yield self._emit({
                "type": "retry",
                "agent": agent.role.value,
                "phase_id": phase_id,
                "retry_round": result.character_json_retries,
                "max_retry": CHARACTER_JSON_MAX_RETRIES,
                "reason": f"角色 JSON：{err[:160]}",
                "character_json": True,
            })
            suffix = hint_intro + err
            yield from self._run_single_phase(agent, phase_id, system, tmpl, extra_user_suffix=suffix)

    def _run_format_persist_gate(
        self,
        agent: BaseAgent,
        phase_id: str,
        system: str,
        tmpl: str,
    ) -> Iterator[str]:
        """导演通过后：写入项目库并校验；失败则触发仅「格式自愈」的重生成。"""
        result = self.ctx.results.get(phase_id)
        if not result or not result.text.strip():
            yield self._emit({
                "type": "persist_verify",
                "phase_id": phase_id,
                "ok": False,
                "applied": False,
                "detail": "无阶段文本，跳过入库",
                "counts": {},
            })
            return

        fmt_hint_intro = (
            "\n\n【系统强制 · 入库校验未通过】工作台无法将你的上一版输出安全写入数据库。"
            "请**只修正 JSON 结构 / Markdown 代码围栏 / 引号转义 / 尾随逗号 / 字段类型（如数字写成了带引号的字符串）**；"
            "**不得改变剧情、对白、镜头含义与时长设定**。\n\n【校验详情】\n"
        )

        while True:
            txt = self.ctx.results[phase_id].text
            with Session(engine()) as session:
                rep = persist_phase_after_director_pass(
                    session,
                    project_id=self.ctx.project_id,
                    phase_id=phase_id,
                    text=txt,
                    episode_range_start=self.ctx.episode_range_start,
                    episode_range_end=self.ctx.episode_range_end,
                )
            yield self._emit({
                "type": "persist_verify",
                "phase_id": phase_id,
                "ok": rep.ok,
                "applied": rep.ok,
                "detail": rep.detail,
                "counts": rep.counts,
                "format_retry": result.format_persist_retries,
            })
            if rep.ok:
                return

            result.format_persist_retries += 1
            if result.format_persist_retries > FORMAT_PERSIST_MAX_RETRIES:
                yield self._emit({
                    "type": "persist_verify",
                    "phase_id": phase_id,
                    "ok": False,
                    "applied": False,
                    "detail": rep.detail + f"（已达格式自愈上限 {FORMAT_PERSIST_MAX_RETRIES}，改由前端尝试导入）",
                    "counts": rep.counts,
                    "format_retry": result.format_persist_retries,
                    "fallback_client_import": True,
                })
                return

            yield self._emit({
                "type": "retry",
                "agent": agent.role.value,
                "phase_id": phase_id,
                "retry_round": result.format_persist_retries,
                "max_retry": FORMAT_PERSIST_MAX_RETRIES,
                "reason": f"入库/格式校验：{rep.detail[:180]}",
                "persist_format": True,
            })
            suffix = fmt_hint_intro + rep.detail[:2500]
            yield from self._run_single_phase(agent, phase_id, system, tmpl, extra_user_suffix=suffix)

    def _run_single_phase(
        self,
        agent: BaseAgent,
        phase_id: str,
        system: str,
        tmpl: str,
        extra_user_suffix: str = "",
    ) -> Iterator[str]:
        """Run one phase of an agent, yielding SSE delta events."""
        from ..llm.client import stream_chat

        prior = self.ctx.build_prior_for(agent.role, phase_id=phase_id)

        # Inject director feedback for revision rounds
        prev = self.ctx.results.get(phase_id)
        revision_hint = ""
        if prev and prev.revision_needed and prev.director_feedback:
            revision_hint = (
                f"\n\n【导演修改要求（第{prev.retry_count}轮）】\n"
                f"{prev.director_feedback[:6000]}\n"
                f"请根据以上反馈修改你的输出。\n"
            )

        # Build an explicit episode-range directive for beat_sheet / script phases
        ep_range = self._build_ep_range_hint()

        sb_hint = self._storyboard_phase_hard_hints() if phase_id == "storyboard" else ""

        user = (
            tmpl
            .replace("{prior}", prior)
            .replace("{logline}", self.ctx.logline)
            .replace("{notes}", self.ctx.notes)
            .replace("{novel}", self.ctx.novel_excerpt)
            .replace("{drama_types}", self.ctx.drama_types)
            .replace("{memory_context}", self.ctx.memory_context)
            .replace("{ep_range}", ep_range)
            .replace("{storyboard_ep_hint}", sb_hint)
        )
        if revision_hint:
            user += revision_hint
        if extra_user_suffix:
            user += extra_user_suffix

        chunks: list[str] = []

        def yield_llm_stream(user_msg: str) -> Iterator[str]:
            chunks.clear()
            pulse_every = 8192
            since_pulse = 0
            total_chars = 0
            for chunk in stream_chat(
                self.preset,
                system=system,
                user=user_msg,
                temperature=agent.temperature(),
                max_tokens=agent.max_tokens_for_phase(phase_id),
                api_key_override=self.llm_api_key.strip() or None,
            ):
                chunks.append(chunk)
                n = len(chunk)
                total_chars += n
                since_pulse += n
                if since_pulse >= pulse_every:
                    since_pulse = 0
                    r0 = self.ctx.results.get(phase_id)
                    rc = r0.retry_count if r0 else 0
                    yield self._emit({
                        "type": "pulse",
                        "phase_id": phase_id,
                        "agent": agent.role.value,
                        "chars": total_chars,
                        "retry_round": rc,
                        "max_retry": MAX_RETRY_PER_PHASE,
                    })

        yield from yield_llm_stream(user)
        text = "".join(chunks).strip()
        retry_count = prev.retry_count if prev else 0
        fp_retries = getattr(prev, "format_persist_retries", 0) if prev else 0
        cj_retries = getattr(prev, "character_json_retries", 0) if prev else 0
        new_result = PhaseResult(
            phase_id=phase_id,
            agent=agent.role,
            text=text,
            retry_count=retry_count,
        )
        new_result.format_persist_retries = fp_retries
        new_result.character_json_retries = cj_retries
        self.ctx.add_result(new_result)
        agent.post_phase(phase_id, text, self.ctx)
        pr = self.ctx.results[phase_id]

        if phase_id == "storyboard":
            while (
                pr.storyboard_excess_shots
                and pr.storyboard_regen_count < STORYBOARD_OVERCAP_REGEN_ATTEMPTS
            ):
                pr.storyboard_regen_count += 1
                raw_n = pr.storyboard_raw_shot_count
                yield self._emit({
                    "type": "storyboard_overcap_regen",
                    "phase_id": phase_id,
                    "agent": agent.role.value,
                    "shots_before_cap": raw_n,
                    "max_shots": STORYBOARD_MAX_SHOTS,
                    "attempt": pr.storyboard_regen_count,
                })
                cap_hint = (
                    f"\n\n【系统硬性 · 必须遵守】你上一版共 {raw_n} 条镜头对象，超过上限 "
                    f"{STORYBOARD_MAX_SHOTS} 条（已作废）。请**合并冗余景别与过碎切镜**，"
                    f"全文重写为**一条 JSON 数组**，元素个数**严格 ≤ {STORYBOARD_MAX_SHOTS}**，"
                    "且仍满足：单镜 2.0～4.0 秒、该集成片 90～120 秒、`shot_id`/scene 的 EP 标记与上一轮任务一致。\n"
                )
                yield from yield_llm_stream(user + revision_hint + cap_hint)
                text2 = "".join(chunks).strip()
                agent.post_phase(phase_id, text2, self.ctx)

        final_text = self.ctx.results[phase_id].text
        yield self._emit({
            "type": "delta",
            "agent": agent.role.value,
            "phase_id": phase_id,
            "text": final_text,
        })

    def _run_agent_phases(
        self, agent: BaseAgent, phase_ids: set[str]
    ) -> Iterator[str]:
        """Run specified phases of an agent with director review + retry loop."""

        all_phases = agent.get_phases(self.ctx)
        phases = [(pid, sys, usr) for pid, sys, usr in all_phases if pid in phase_ids]
        if not phases:
            return

        label = AGENT_LABELS.get(agent.role, agent.role.value)
        yield self._emit({
            "type": "agent_start",
            "agent": agent.role.value,
            "label": label,
            "phases": [p[0] for p in phases],
        })

        for idx, (phase_id, system, tmpl) in enumerate(phases):
            yield self._emit({
                "type": "phase",
                "agent": agent.role.value,
                "phase_id": phase_id,
                "step": idx + 1,
                "progress_pct": self._progress_pct(),
            })

            # --- Generate phase output ---
            yield from self._run_single_phase(agent, phase_id, system, tmpl)

            # --- Director review + retry loop ---
            if self.enable_review and phase_id in _REVIEW_GATES:
                for retry in range(MAX_RETRY_PER_PHASE + 1):
                    # Director reviews
                    yield from self.director.review_phase(
                        self.preset,
                        phase_id,
                        agent.role,
                        self.ctx,
                        llm_api_key=self.llm_api_key,
                    )

                    result = self.ctx.results.get(phase_id)
                    if not result or not result.revision_needed:
                        break

                    # REVISE verdict — retry the phase
                    result.retry_count += 1
                    yield self._emit({
                        "type": "retry",
                        "agent": agent.role.value,
                        "phase_id": phase_id,
                        "retry_round": result.retry_count,
                        "max_retry": MAX_RETRY_PER_PHASE,
                        "reason": result.director_feedback[:200],
                    })

                    yield from self._run_single_phase(agent, phase_id, system, tmpl)

            if phase_id == "characters":
                yield from self._run_character_export_gate(agent, phase_id, system, tmpl)

            if self.ctx.project_id and phase_id in PERSIST_GATE_PHASES:
                yield from self._run_format_persist_gate(agent, phase_id, system, tmpl)

            # --- Generate handoff packet for next agent ---
            self._generate_handoff(agent.role, phase_id)

            self._done_phases += 1
            yield self._emit({
                "type": "phase_complete",
                "phase_id": phase_id,
                "progress_pct": self._progress_pct(),
                "score": getattr(self.ctx.results.get(phase_id), "director_score", 0),
            })

        yield self._emit({
            "type": "agent_done",
            "agent": agent.role.value,
            "label": label,
        })

    def _generate_handoff(self, role: AgentRole, phase_id: str) -> None:
        """Create a bounded handoff packet for inter-agent context passing."""
        result = self.ctx.results.get(phase_id)
        if not result:
            return

        summary = result.summary or result.text[:8000]
        handoff = HandoffPacket(
            source_agent=role,
            phase_id=phase_id,
            working_hypothesis=summary,
            confidence=min(1.0, (result.director_score or 7) / 10),
            key_decisions=[],
            open_questions=[],
        )

        if result.director_feedback and not result.revision_needed:
            parts = result.director_feedback.split("\n")
            for p in parts:
                p = p.strip()
                if p.startswith("建议："):
                    handoff.open_questions.append(p[3:])

        self.ctx.add_handoff(handoff)

    def _save_to_memory(self) -> bool:
        """Auto-save generation results to the project's memory system.

        Writes bible/characters/episodes summaries so the next generation
        session can pick up where this one left off.
        """
        ctx = self.ctx
        if not ctx.project_id:
            return False

        try:
            from ..memory.memory_manager import MemoryManager, MemoryRoom
            mgr = MemoryManager(ctx.project_id)

            # Save bible / digest as project summary
            bible = ctx.get_text("bible") or ctx.get_text("digest")
            if bible:
                mgr.write_summary(bible[:30000])

            # Save character summaries
            chars_text = ctx.get_text("characters")
            if chars_text:
                mgr.add_entry(
                    room=MemoryRoom.CHARACTERS.value,
                    title="角色档案（AI 生成）",
                    body=chars_text[:50000],
                    tags="auto",
                )

            # Save episode outlines
            skeleton = ctx.get_text("episode_skeleton") or ctx.get_text("adapt_outline")
            if skeleton:
                mgr.add_entry(
                    room=MemoryRoom.EPISODES.value,
                    title="分集大纲",
                    body=skeleton[:50000],
                    tags="auto",
                )

            # Save script snippets as per-episode memory
            script = ctx.get_text("script_snippet") or ctx.get_text("episode_scripts") or ctx.get_text("novel_screenplay")
            if script:
                segments = script.split("【本集完")
                for i, seg in enumerate(segments):
                    seg = seg.strip()
                    if len(seg) < 30:
                        continue
                    ep_num = ctx.episode_range_start or 1
                    ep_label = str(ep_num + i)
                    summary = seg[:5000]
                    mgr.add_entry(
                        room=MemoryRoom.EPISODES.value,
                        title=f"第{ep_label}集剧本摘要",
                        body=summary,
                        episode_label=ep_label,
                        tags="auto,script",
                    )

            # Save storyboard summary
            sb = ctx.get_text("storyboard")
            if sb:
                mgr.add_entry(
                    room=MemoryRoom.EPISODES.value,
                    title="分镜脚本摘要",
                    body=sb[:50000],
                    tags="auto,storyboard",
                )

            # Save hooks / cliffhangers
            for pid in ("script_snippet", "episode_scripts", "novel_screenplay"):
                text = ctx.get_text(pid)
                if not text:
                    continue
                hooks = []
                for line in text.split("\n"):
                    if "钩子" in line and ("【本集完" in line or "钩子：" in line):
                        hooks.append(line.strip())
                if hooks:
                    mgr.add_entry(
                        room=MemoryRoom.HOOKS.value,
                        title="剧本钩子/悬念",
                        body="\n".join(hooks[:20]),
                        tags="auto",
                    )
                break

            return True
        except Exception:
            return False

    def _build_ep_range_hint(self) -> str:
        """Return a hard directive string for the current episode range.

        This is injected as {ep_range} into beat_sheet / script templates so
        the model cannot mistake it for a soft suggestion.
        """
        ctx = self.ctx
        start = ctx.episode_range_start
        end = ctx.episode_range_end

        if start is None and end is None:
            return ""

        s = start or 1
        e = end or s

        count = max(1, e - s + 1)
        return (
            f"\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
            f"【强制要求】本次只写第 {s} 集 到 第 {e} 集（共 {count} 集）的剧本正文。\n"
            f"• 不得输出此范围以外的任何集的正文内容。\n"
            f"• 每集结尾必须有：【本集完，钩子：xxx】\n"
            f"• 若本次是续写，请衔接已有情节线索，不得重写已有集数。\n"
            f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        )

    def _is_continue_mode(self) -> bool:
        """Detect if this is a continuation run (not first generation).

        Continue mode is active when:
        - episode_range_start > 1 (user explicitly wants to continue from ep N)
        - OR memory_context is non-empty AND episode_range_start is set
        """
        ctx = self.ctx
        if ctx.episode_range_start is not None and ctx.episode_range_start > 1:
            return True
        return False

    def _build_steps(self) -> list[_Step]:
        ctx = self.ctx

        if ctx.job_type == "feature":
            return [_Step(self.screenwriter, ["synopsis", "act_outline", "scene_list", "scene_expand"])]

        is_continue = self._is_continue_mode()

        if ctx.job_type == "novel_adapt":
            if is_continue:
                return [
                    _Step(self.editor_agent, ["novel_screenplay"]),
                    _Step(self.character, ["characters"]),
                    _Step(self.storyboard_agent, ["storyboard"]),
                    _Step(self.editor_agent, ["edit_script"]),
                ]
            return [
                _Step(self.screenwriter, ["digest"]),
                _Step(self.character, ["characters"]),
                _Step(self.screenwriter, ["adapt_outline"]),
                _Step(self.editor_agent, ["novel_screenplay"]),
                _Step(self.storyboard_agent, ["storyboard"]),
                _Step(self.editor_agent, ["edit_script", "production_checklist"]),
            ]

        # short_drama (default)
        if is_continue:
            return [
                _Step(self.screenwriter, ["beat_sheet", "script_snippet"]),
                _Step(self.character, ["characters"]),
                _Step(self.storyboard_agent, ["storyboard"]),
                _Step(self.editor_agent, ["edit_script"]),
            ]
        return [
            _Step(self.screenwriter, ["bible"]),
            _Step(self.character, ["characters"]),
            _Step(self.screenwriter, ["episode_skeleton", "beat_sheet", "script_snippet"]),
            _Step(self.storyboard_agent, ["storyboard"]),
            _Step(self.editor_agent, ["edit_script"]),
        ]
