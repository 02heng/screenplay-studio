"""Multi-agent orchestration for screenplay production pipeline.

Architecture inspired by:
- Deep Director (quality gate), ViMax (central orchestration),
- CoDi (director-actor), Story Claw (validation loop / resume),
- XucroYuri (handoff packets)
"""

from .context import (
    AgentContext, AgentRole, PhaseResult, HandoffPacket,
    QUALITY_GATE_THRESHOLD, MAX_RETRY_PER_PHASE,
    CONTEXT_CHAR_BUDGET,
)
from .orchestrator import Orchestrator

__all__ = [
    "AgentContext",
    "AgentRole",
    "PhaseResult",
    "HandoffPacket",
    "Orchestrator",
    "QUALITY_GATE_THRESHOLD",
    "MAX_RETRY_PER_PHASE",
    "CONTEXT_CHAR_BUDGET",
]
