"""OpenAI-compatible chat completions streaming client."""

from __future__ import annotations

import json
from typing import Any, Iterator

import httpx

from .presets import ProviderPreset, resolve_api_key


def _normalize_base(base_url: str) -> str:
    b = base_url.strip().rstrip("/")
    if b.endswith("/v1"):
        return b
    return f"{b}/v1"


def stream_chat(
    preset: ProviderPreset,
    *,
    system: str,
    user: str,
    temperature: float = 0.7,
    max_tokens: int | None = 4096,
    api_key_override: str | None = None,
) -> Iterator[str]:
    override = (api_key_override or "").strip()
    api_key = override or resolve_api_key(preset)
    env_name = preset.api_key_env.strip()
    if env_name and not api_key:
        raise RuntimeError(
            f'Missing API key: set `{env_name}` or provide `llm_api_key` in the request for preset `{preset.id}`.'
        )

    url = f"{_normalize_base(preset.base_url)}/chat/completions"
    headers: dict[str, str] = {"Content-Type": "application/json", **preset.extra_headers}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    body: dict[str, Any] = {
        "model": preset.model,
        "temperature": temperature,
        "stream": True,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    if max_tokens is not None:
        body["max_tokens"] = max_tokens

    with httpx.Client(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
        with client.stream("POST", url, headers=headers, json=body) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                if line.startswith("data: "):
                    payload = line[6:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        obj = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    choices = obj.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    piece = delta.get("content")
                    if piece:
                        yield str(piece)
