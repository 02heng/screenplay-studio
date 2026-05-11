from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

import yaml

from ..paths import (
    providers_example,
    providers_file_bundled,
    providers_file_user,
)


@dataclass(frozen=True)
class ProviderPreset:
    id: str
    label: str
    base_url: str
    model: str
    api_key_env: str
    extra_headers: dict[str, str]

    @property
    def safe_dict(self) -> dict[str, Any]:
        """API listing without secrets."""
        return {
            "id": self.id,
            "label": self.label,
            "base_url": self.base_url,
            "model": self.model,
            "api_key_env": self.api_key_env or "",
        }


def _load_yaml(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    data = yaml.safe_load(raw)
    return data if isinstance(data, dict) else {}


def load_presets() -> list[ProviderPreset]:
    u = providers_file_user()
    b = providers_file_bundled()
    ex = providers_example()
    path: Optional[Path] = None
    if u.is_file():
        path = u
    elif b.is_file():
        path = b
    elif ex.is_file():
        path = ex
    if path is None:
        return []

    data = _load_yaml(path)
    items = data.get("presets")
    if not isinstance(items, Iterable):
        return []

    merged: dict[str, ProviderPreset] = {}
    for it in items:
        if not isinstance(it, dict):
            continue
        pid = str(it.get("id") or "").strip()
        if not pid:
            continue
        label = str(it.get("label") or pid).strip()
        base_url = str(it.get("base_url") or "").strip().rstrip("/")
        model = str(it.get("model") or "").strip()
        api_key_env = str(it.get("api_key_env") or "").strip()
        extra = it.get("extra_headers") or {}
        eh: dict[str, str] = {}
        if isinstance(extra, dict):
            for k, v in extra.items():
                eh[str(k)] = str(v)
        merged[pid] = ProviderPreset(
            id=pid,
            label=label,
            base_url=base_url if base_url else "https://api.openai.com/v1",
            model=model if model else "gpt-4o-mini",
            api_key_env=api_key_env,
            extra_headers=eh,
        )
    return list(merged.values())


def ensure_user_providers_yaml() -> dict[str, Any]:
    """若用户目录无 providers.yaml，则从 bundled 或 example 复制一份。"""
    u = providers_file_user()
    if u.is_file():
        return _load_yaml(u)
    u.parent.mkdir(parents=True, exist_ok=True)
    for src in (providers_file_bundled(), providers_example()):
        if src.is_file():
            u.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
            return _load_yaml(u)
    data: dict[str, Any] = {"presets": []}
    u.write_text(
        yaml.dump(data, allow_unicode=True, default_flow_style=False, sort_keys=False),
        encoding="utf-8",
    )
    return data


def update_user_preset(
    preset_id: str,
    *,
    label: str,
    base_url: str,
    model: str,
    api_key_env: str,
) -> None:
    """将预设字段写入用户数据目录下的 providers.yaml（并保留 extra_headers）。"""
    data = ensure_user_providers_yaml()
    items = data.get("presets")
    if not isinstance(items, list):
        items = []
        data["presets"] = items
    pid = preset_id.strip()
    for it in items:
        if not isinstance(it, dict):
            continue
        if str(it.get("id") or "").strip() != pid:
            continue
        it["label"] = (label or "").strip() or str(it.get("label") or pid)
        bu = (base_url or "").strip().rstrip("/")
        it["base_url"] = bu or str(it.get("base_url") or "https://api.openai.com/v1")
        it["model"] = (model or "").strip() or str(it.get("model") or "gpt-4o-mini")
        it["api_key_env"] = (api_key_env or "").strip()
        if "extra_headers" not in it or not isinstance(it["extra_headers"], dict):
            it["extra_headers"] = {}
        path = providers_file_user()
        path.write_text(
            yaml.dump(data, allow_unicode=True, default_flow_style=False, sort_keys=False),
            encoding="utf-8",
        )
        return
    raise ValueError(f"未找到预设 id「{pid}」。请先确认 providers.yaml 中存在该预设。")


def resolve_api_key(preset: ProviderPreset) -> Optional[str]:
    import os

    env_name = preset.api_key_env.strip()
    if env_name:
        v = os.environ.get(env_name, "").strip()
        return v or None
    return os.environ.get("OPENAI_API_KEY", "").strip() or None
