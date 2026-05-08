from __future__ import annotations

import json
from typing import Iterator

from ..llm.client import stream_chat
from ..llm.presets import ProviderPreset
from ..prompts import feature, novel_adapt, short_drama

PhaseRow = tuple[str, str, str]


def pick_phases(job_type: str) -> list[PhaseRow]:
    if job_type == "feature":
        return feature.phases()
    if job_type == "short_drama":
        return short_drama.phases()
    if job_type == "novel_adapt":
        return novel_adapt.phases()
    raise ValueError(f"unknown job_type {job_type}")


def run_job_stream(
    preset: ProviderPreset,
    job_type: str,
    logline: str,
    novel: str,
    notes: str,
    *,
    llm_api_key: str = "",
    short_drama_types: list[str] | None = None,
) -> Iterator[str]:
    """Yield NDJSON lines for SSE."""

    phases = pick_phases(job_type)
    acc: list[str] = []

    def emit(obj: dict) -> str:
        return json.dumps(obj, ensure_ascii=False) + "\n"

    def fmt_drama_types() -> str:
        if job_type != "short_drama":
            return ""
        raw = short_drama_types or []
        cleaned = [str(t).strip() for t in raw if str(t).strip()]
        if not cleaned:
            return "（用户未勾选类型标签，请结合梗概自行把握题材与受众）"
        return "、".join(cleaned)

    drama_types_s = fmt_drama_types()

    yield emit({"type": "meta", "job_type": job_type, "phases_total": len(phases)})

    for idx, (phase_id, system, tmpl) in enumerate(phases):
        yield emit({"type": "phase", "phase_id": phase_id, "step": idx + 1})

        prior = "\n\n".join(acc[-2:]) if acc else ""

        if job_type == "novel_adapt":
            first_key = "{novel}"
            if first_key in tmpl and idx == 0:
                user = tmpl.replace("{novel}", novel or "").replace("{notes}", notes or "").replace(
                    "{logline}", logline or ""
                )
                user = user.replace("{prior}", prior)
            else:
                user = (
                    tmpl.replace("{prior}", prior)
                    .replace("{notes}", notes or "")
                    .replace("{logline}", logline or "")
                    .replace("{novel}", novel or "")
                )
        else:
            if idx == 0:
                user = tmpl.replace("{logline}", logline or "").replace("{notes}", notes or "").replace(
                    "{prior}", prior
                )
            else:
                user = tmpl.replace("{prior}", prior).replace("{notes}", notes or "").replace(
                    "{logline}", logline or ""
                )
            user = user.replace("{novel}", novel or "")

        user = user.replace("{drama_types}", drama_types_s)


        buf: list[str] = []
        for chunk in stream_chat(
            preset,
            system=system,
            user=user,
            temperature=0.75,
            max_tokens=8192,
            api_key_override=llm_api_key.strip() or None,
        ):
            buf.append(chunk)
            yield emit({"type": "delta", "phase_id": phase_id, "text": chunk})

        text = "".join(buf).strip()
        acc.append(f"=== {phase_id} ===\n{text}")

    yield emit({"type": "done"})
