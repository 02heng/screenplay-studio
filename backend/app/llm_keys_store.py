"""持久化用户在界面填写的 LLM API Key（按 preset_id 存于用户数据目录）。"""
from __future__ import annotations

import json
from pathlib import Path
from threading import Lock

from .paths import user_data_dir

_lock = Lock()
_filename = "llm_keys.json"


def _path() -> Path:
    d = user_data_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d / _filename


def _load_unlocked() -> dict[str, str]:
    path = _path()
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {}
        out: dict[str, str] = {}
        for k, v in raw.items():
            if isinstance(k, str) and isinstance(v, str) and v.strip():
                out[k.strip()] = v.strip()
        return out
    except (OSError, json.JSONDecodeError):
        return {}


def _write_unlocked(cleaned: dict[str, str]) -> None:
    path = _path()
    path.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2), encoding="utf-8")


def load_all() -> dict[str, str]:
    with _lock:
        return dict(_load_unlocked())


def save_all(keys: dict[str, str]) -> None:
    cleaned: dict[str, str] = {}
    for k, v in keys.items():
        ks = (k or "").strip()
        vs = (v or "").strip()
        if ks and vs:
            cleaned[ks] = vs
    with _lock:
        _write_unlocked(cleaned)


def merge_into_stored(partial: dict[str, str]) -> dict[str, str]:
    """合并写入并返回当前完整表（空字符串表示删除该预设的存盘 Key）。"""
    with _lock:
        current = _load_unlocked()
        for k, v in partial.items():
            ks = (k or "").strip()
            if not ks:
                continue
            vs = (v or "").strip()
            if vs:
                current[ks] = vs
            else:
                current.pop(ks, None)
        _write_unlocked(current)
        return dict(current)


def get_for_preset(preset_id: str) -> str:
    pid = (preset_id or "").strip()
    if not pid:
        return ""
    with _lock:
        return _load_unlocked().get(pid, "")
