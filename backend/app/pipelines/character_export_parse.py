"""解析 characters 阶段输出（ fenced JSON / 顶层 characters 数组）。"""

from __future__ import annotations

import json
import re
from typing import Any

_JSON_FENCE_FULL = re.compile(r"^\s*```(?:json)?\s*([\s\S]*?)```\s*$", re.IGNORECASE)
_JSON_FENCE_ANY = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.IGNORECASE)


def _strip_fence(text: str) -> str:
    t = text.strip()
    m = _JSON_FENCE_FULL.match(t)
    if m:
        return m.group(1).strip()
    m2 = _JSON_FENCE_ANY.search(text)
    if m2:
        return m2.group(1).strip()
    return t


def _slice_balanced_object(payload: str, start: int) -> str | None:
    if start < 0 or start >= len(payload) or payload[start] != "{":
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
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return payload[start : i + 1]
    return None


def parse_character_export(text: str) -> tuple[list[dict[str, Any]] | None, str]:
    """返回 (characters 数组, 错误说明)。成功时数组元素均为 dict 且含非空 name。"""
    raw = _strip_fence(text)
    # 先试整段解析
    try:
        v = json.loads(raw)
        if isinstance(v, list) and v:
            rows = [x for x in v if isinstance(x, dict)]
            return _validate_rows(rows)
        if isinstance(v, dict):
            inner = v.get("characters")
            if isinstance(inner, list):
                rows = [x for x in inner if isinstance(x, dict)]
                return _validate_rows(rows)
    except (json.JSONDecodeError, TypeError, ValueError):
        pass

    start = raw.find("{")
    if start >= 0:
        balanced = _slice_balanced_object(raw, start)
        if balanced:
            try:
                obj = json.loads(balanced)
                if isinstance(obj, dict):
                    inner = obj.get("characters")
                    if isinstance(inner, list):
                        rows = [x for x in inner if isinstance(x, dict)]
                        return _validate_rows(rows)
            except (json.JSONDecodeError, TypeError, ValueError):
                pass

    key = raw.find('"characters"')
    if key >= 0:
        s = raw.rfind("{", 0, key)
        if s < 0:
            s = raw.find("{")
        if s >= 0:
            balanced = _slice_balanced_object(raw, s)
            if balanced:
                try:
                    obj = json.loads(balanced)
                    if isinstance(obj, dict):
                        inner = obj.get("characters")
                        if isinstance(inner, list):
                            rows = [x for x in inner if isinstance(x, dict)]
                            return _validate_rows(rows)
                except (json.JSONDecodeError, TypeError, ValueError):
                    pass

    return None, "无法解析为 JSON，或缺少顶层 characters 数组"


def _validate_rows(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]] | None, str]:
    if not rows:
        return None, "characters 数组为空"
    good: list[dict[str, Any]] = []
    for r in rows:
        name = str(r.get("name", "")).strip()
        if not name:
            return None, "存在缺少 name 或 name 为空的角色条目"
        good.append(r)
    return good, ""
