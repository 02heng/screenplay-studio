"""模型多生成集数时的硬性截断（不依赖模型自律）。"""

from __future__ import annotations

import json
import re

# 与剧本/节拍里「新的一集」开头一致：第N集、N-场次、EPNN
_EP_HEADER = re.compile(
    r"(?m)^[\s]*(?:"
    r"第\s*0*(\d+)\s*集|"
    r"(\d+)\s*-\s*\d+|"
    r"EP\s*0*(\d+)"
    r")",
    re.IGNORECASE,
)

_EP_NUM_IN_SHOT = re.compile(r"EP\s*0*(\d+)", re.IGNORECASE)

# 单响应分镜 JSON 数组硬性上限（与 90–120s / 2–4s/镜 体量一致；超出截断并由编排器再生成一轮）
STORYBOARD_MAX_SHOTS = 45

_JSON_FENCE_FULL = re.compile(r"^\s*```(?:json)?\s*([\s\S]*?)```\s*$", re.IGNORECASE)
_JSON_FENCE_ANY = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.IGNORECASE)


def _strip_json_fence(text: str) -> str:
    t = text.strip()
    m = _JSON_FENCE_FULL.match(t)
    if m:
        return m.group(1).strip()
    m2 = _JSON_FENCE_ANY.search(text)
    if m2:
        return m2.group(1).strip()
    return t


def _slice_balanced_json_array(payload: str, start: int) -> str | None:
    """与前端 sliceBalancedJsonArray 一致：从 start 截取匹配的顶层 [...]（字符串内括号不计）。"""
    if start < 0 or start >= len(payload) or payload[start] != "[":
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(payload)):
        c = payload[i]
        if in_str:
            if esc:
                esc = False
                continue
            if c == "\\":
                esc = True
                continue
            if c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
            continue
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return payload[start : i + 1]
    return None


def _shot_list_from_storyboard_obj(d: object) -> list | None:
    """常见误格式：{\"storyboard\": {\"shots\": [...]}} — 单层 storyboard/shots/data 已为列表时直接返回。"""
    if not isinstance(d, dict):
        return None
    for key in ("shots", "storyboard", "data"):
        inner = d.get(key)
        if isinstance(inner, list):
            return inner
        if isinstance(inner, dict):
            nested = _shot_list_from_storyboard_obj(inner)
            if nested is not None:
                return nested
    return None


def parse_storyboard_shot_list(text: str) -> list | None:
    """从模型输出中提取分镜镜头数组（顶层数组或 { shots / storyboard / data }）。
    避免 find('[')…rfind(']') 截断多块数组或内含 ] 的字符串时解析失败。
    """
    raw = _strip_json_fence(text)
    try:
        v = json.loads(raw)
        if isinstance(v, list):
            return v
        if isinstance(v, dict):
            got = _shot_list_from_storyboard_obj(v)
            if got is not None:
                return got
    except (json.JSONDecodeError, TypeError, ValueError):
        pass

    start = raw.find("[")
    if start < 0:
        return None
    balanced = _slice_balanced_json_array(raw, start)
    if not balanced:
        return None
    try:
        arr = json.loads(balanced)
        return arr if isinstance(arr, list) else None
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


def clip_json_episodes_to_target(text: str, target: int) -> str:
    """将 JSON 内 episodes 数组截断为恰好 target 条，并重排 ep / ep_number。"""
    if target < 1:
        return text
    try:
        start = text.find("{")
        end = text.rfind("}") + 1
        if start < 0 or end <= start:
            return text
        obj = json.loads(text[start:end])
        eps = obj.get("episodes")
        if not isinstance(eps, list):
            return text
        if len(eps) <= target:
            return text

        obj["episodes"] = eps[:target]
        for i, ep in enumerate(obj["episodes"]):
            if isinstance(ep, dict):
                ep["ep_number"] = i + 1
                if "ep" in ep:
                    ep["ep"] = i + 1
        meta = obj.get("adaptation_meta")
        if isinstance(meta, dict):
            meta["total_episodes"] = target

        new_inner = json.dumps(obj, ensure_ascii=False, indent=2)
        return text[:start] + new_inner + text[end:]
    except (json.JSONDecodeError, ValueError, KeyError, TypeError):
        return text


def clip_prose_to_episode_range(text: str, lo: int, hi: int) -> str:
    """按集标题切块，只保留 [lo, hi] 内的块（用于 beat_sheet / 剧本正文）。"""
    if lo < 1:
        lo = 1
    if hi < lo:
        hi = lo

    matches = list(_EP_HEADER.finditer(text))
    if not matches:
        return text

    parts: list[str] = []
    for i, m in enumerate(matches):
        seg_start = m.start()
        seg_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        g1, g2, g3 = m.group(1), m.group(2), m.group(3)
        ep_num = int(g1 or g2 or g3 or "0")
        if ep_num > 0 and lo <= ep_num <= hi:
            parts.append(text[seg_start:seg_end].rstrip())

    out = "\n\n".join(parts).strip()
    return out if out else text


def clip_storyboard_json_by_ep_range(text: str, lo: int, hi: int) -> str | None:
    """过滤分镜 JSON 数组中 EP 不在 [lo,hi] 的镜头。无法解析或未裁剪则返回 None。"""
    arr = parse_storyboard_shot_list(text)
    if arr is None:
        return None

    filtered: list[object] = []
    for item in arr:
        if not isinstance(item, dict):
            filtered.append(item)
            continue
        ep_num = None
        for field in ("shot_id", "scene", "scene_id"):
            val = str(item.get(field, ""))
            m = _EP_NUM_IN_SHOT.search(val)
            if m:
                ep_num = int(m.group(1))
                break
        if ep_num is None or (lo <= ep_num <= hi):
            filtered.append(item)

    if len(filtered) == len(arr):
        return None
    # 裁剪后统一为格式化数组；与 agents/storyboard 写入 ctx、导入解析（数组根）对齐
    return json.dumps(filtered, ensure_ascii=False, indent=2)


def clip_edit_timeline_by_ep_range(text: str, lo: int, hi: int) -> str | None:
    """过滤剪辑 JSON 里 shot_ref/cut_id 体现的 EP 不在范围内的条目。"""
    try:
        obj_start = text.find("{")
        obj_end = text.rfind("}") + 1
        if obj_start < 0 or obj_end <= obj_start:
            return None

        obj = json.loads(text[obj_start:obj_end])
        es = obj.get("edit_script")
        if isinstance(es, dict):
            timeline = es.get("timeline")
        else:
            timeline = obj.get("timeline")

        if not isinstance(timeline, list):
            return None

        filtered: list[object] = []
        for item in timeline:
            if not isinstance(item, dict):
                filtered.append(item)
                continue
            ep_num = None
            for field in ("shot_ref", "cut_id"):
                val = str(item.get(field, ""))
                m = _EP_NUM_IN_SHOT.search(val)
                if m:
                    ep_num = int(m.group(1))
                    break
            if ep_num is None or (lo <= ep_num <= hi):
                filtered.append(item)

        if len(filtered) == len(timeline):
            return None
        if isinstance(es, dict):
            es["timeline"] = filtered
        else:
            obj["timeline"] = filtered

        new_text = text[:obj_start] + json.dumps(obj, ensure_ascii=False, indent=2) + text[obj_end:]
        return new_text
    except (json.JSONDecodeError, ValueError):
        return None
