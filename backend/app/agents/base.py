"""Base class for all agents.

Agents are stateless executors — they read from AgentContext and write results
back. The Orchestrator handles retry loops and director reviews externally.
"""

from __future__ import annotations

import json
from typing import Iterator

from ..llm.client import stream_chat
from ..llm.presets import ProviderPreset
from .context import AgentContext, AgentRole, PhaseResult, AGENT_LABELS


class BaseAgent:
    role: AgentRole

    def get_phases(self, ctx: AgentContext) -> list[tuple[str, str, str]]:
        raise NotImplementedError

    def max_tokens_for_phase(self, phase_id: str) -> int:
        return 65536

    def temperature(self) -> float:
        return 0.75

    def post_phase(self, phase_id: str, text: str, ctx: AgentContext) -> None:
        """Hook called after a phase completes — parse JSON, build summaries, etc."""

    def build_summary(self, phase_id: str, text: str) -> str:
        """Override to produce a concise summary for handoff packets."""
        return text[:8000]

    def run_stream(
        self,
        preset: ProviderPreset,
        ctx: AgentContext,
        *,
        llm_api_key: str = "",
    ) -> Iterator[str]:
        """Yield NDJSON lines (SSE) for all phases this agent owns.

        NOTE: When using the Orchestrator, this method is NOT called — the
        Orchestrator calls _run_single_phase directly to support retry loops.
        This method remains for standalone / legacy usage.
        """

        def emit(obj: dict) -> str:
            return json.dumps(obj, ensure_ascii=False) + "\n"

        phases = self.get_phases(ctx)
        label = AGENT_LABELS.get(self.role, self.role.value)

        yield emit({
            "type": "agent_start",
            "agent": self.role.value,
            "label": label,
            "phases": [p[0] for p in phases],
        })

        for idx, (phase_id, system, tmpl) in enumerate(phases):
            yield emit({
                "type": "phase",
                "agent": self.role.value,
                "phase_id": phase_id,
                "step": idx + 1,
            })

            prior = ctx.build_prior_for(self.role)

            user = (
                tmpl
                .replace("{prior}", prior)
                .replace("{logline}", ctx.logline)
                .replace("{notes}", ctx.notes)
                .replace("{novel}", ctx.novel_excerpt)
                .replace("{drama_types}", ctx.drama_types)
                .replace("{memory_context}", ctx.memory_context)
            )

            buf: list[str] = []
            for chunk in stream_chat(
                preset,
                system=system,
                user=user,
                temperature=self.temperature(),
                max_tokens=self.max_tokens_for_phase(phase_id),
                api_key_override=llm_api_key.strip() or None,
            ):
                buf.append(chunk)
                yield emit({
                    "type": "delta",
                    "agent": self.role.value,
                    "phase_id": phase_id,
                    "text": chunk,
                })

            text = "".join(buf).strip()
            result = PhaseResult(
                phase_id=phase_id,
                agent=self.role,
                text=text,
            )
            ctx.add_result(result)
            self.post_phase(phase_id, text, ctx)

        yield emit({
            "type": "agent_done",
            "agent": self.role.value,
            "label": label,
        })
