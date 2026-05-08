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


def resolve_api_key(preset: ProviderPreset) -> Optional[str]:
    import os

    env_name = preset.api_key_env.strip()
    if env_name:
        v = os.environ.get(env_name, "").strip()
        return v or None
    return os.environ.get("OPENAI_API_KEY", "").strip() or None
