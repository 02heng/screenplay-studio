from __future__ import annotations

import json
from typing import Iterator

from ..llm.client import stream_chat
from ..llm.presets import ProviderPreset
from ..prompts import feature, novel_adapt, short_drama
from .episode_range_clip import (
    STORYBOARD_MAX_SHOTS,
    clip_edit_timeline_by_ep_range,
    clip_json_episodes_to_target,
    clip_prose_to_episode_range,
    clip_storyboard_json_by_ep_range,
    parse_storyboard_shot_list,
)

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
    target_episodes: int | None = None,
    episode_range_start: int | None = None,
    episode_range_end: int | None = None,
    project_id: int | None = None,
) -> Iterator[str]:
    """Yield NDJSON lines for SSE."""

    phases = pick_phases(job_type)
    acc: list[str] = []

    base_notes = (notes or "").strip()
    notes_merged = base_notes
    if job_type == "short_drama" and target_episodes is not None:
        ep_hint = (
            f"【目标集数】用户要求全剧共约 {target_episodes} 集。"
            f"episode_skeleton 的 JSON 必须包含 {target_episodes} 条 episodes（ep_number 依次为 1…{target_episodes}）；"
            "后续节拍与剧本规划须与该分集体量一致。"
        )
        notes_merged = f"{base_notes}\n\n{ep_hint}".strip() if base_notes else ep_hint

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

        if phase_id == "storyboard" and project_id:
            from ..project_episode_scripts import storyboard_bundle_for_prior

            sb_bundle = storyboard_bundle_for_prior(project_id)
            if sb_bundle.strip():
                prior = f"{prior}\n\n{sb_bundle}".strip() if prior.strip() else sb_bundle

        if job_type == "novel_adapt":
            first_key = "{novel}"
            if first_key in tmpl and idx == 0:
                user = tmpl.replace("{novel}", novel or "").replace("{notes}", notes_merged).replace(
                    "{logline}", logline or ""
                )
                user = user.replace("{prior}", prior)
            else:
                user = (
                    tmpl.replace("{prior}", prior)
                    .replace("{notes}", notes_merged)
                    .replace("{logline}", logline or "")
                    .replace("{novel}", novel or "")
                )
        else:
            if idx == 0:
                user = tmpl.replace("{logline}", logline or "").replace("{notes}", notes_merged).replace(
                    "{prior}", prior
                )
            else:
                user = tmpl.replace("{prior}", prior).replace("{notes}", notes_merged).replace(
                    "{logline}", logline or ""
                )
            user = user.replace("{novel}", novel or "")

        user = user.replace("{drama_types}", drama_types_s)
        user = user.replace("{memory_context}", "")
        user = user.replace("{storyboard_ep_hint}", "")


        # DeepSeek 支持超长上下文，分镜/剪辑 JSON 给足空间；剧本正文次之；其余默认
        _LARGE = 131072  # storyboard / edit_script：镜头 JSON 字段多
        _MED   = 131072  # script_snippet / beat_sheet：剧本正文较长
        _DEF   = 65536   # 其余阶段
        phase_max_tokens = (
            _LARGE if phase_id in ("storyboard", "edit_script") else
            _MED   if phase_id in ("script_snippet", "beat_sheet", "episode_scripts", "novel_screenplay") else
            _DEF
        )

        buf: list[str] = []
        for chunk in stream_chat(
            preset,
            system=system,
            user=user,
            temperature=0.75,
            max_tokens=phase_max_tokens,
            api_key_override=llm_api_key.strip() or None,
        ):
            buf.append(chunk)

        text = "".join(buf).strip()

        if target_episodes is not None and phase_id in ("episode_skeleton", "adapt_outline"):
            text = clip_json_episodes_to_target(text, target_episodes)

        if episode_range_start is not None or episode_range_end is not None:
            lo = episode_range_start or 1
            hi = episode_range_end if episode_range_end is not None else lo
            if phase_id in ("beat_sheet", "script_snippet", "episode_scripts", "novel_screenplay"):
                text = clip_prose_to_episode_range(text, lo, hi)
            elif phase_id == "storyboard":
                nt = clip_storyboard_json_by_ep_range(text, lo, hi)
                if nt is not None:
                    text = nt
            elif phase_id == "edit_script":
                nt = clip_edit_timeline_by_ep_range(text, lo, hi)
                if nt is not None:
                    text = nt

        if phase_id == "storyboard":
            arr = parse_storyboard_shot_list(text)
            if arr is not None and len(arr) > STORYBOARD_MAX_SHOTS:
                text = json.dumps(arr[:STORYBOARD_MAX_SHOTS], ensure_ascii=False, indent=2)

        yield emit({"type": "delta", "phase_id": phase_id, "text": text})

        acc.append(f"=== {phase_id} ===\n{text}")

    yield emit({"type": "done"})
