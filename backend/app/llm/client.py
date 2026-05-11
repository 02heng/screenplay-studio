"""OpenAI-compatible chat completions streaming client."""

from __future__ import annotations

import json
import ssl
from typing import Any, Iterator

import httpx

from .presets import ProviderPreset, resolve_api_key

# TLS 在读/握手阶段被对端打断时常见（UNEXPECTED_EOF_WHILE_READING 等）。
_SSL_TLS_HINT = (
    "TLS/SSL 异常（例如 UNEXPECTED_EOF_WHILE_READING）："
    "多见于网络抖动、VPN/代理干扰 HTTPS、防火墙重置连接，或 API 网关提前断开。"
    "建议：切换网络或暂时关闭 VPN、检查环境变量 HTTP_PROXY/HTTPS_PROXY、稍后重试；"
    "单次请求过长时可缩小正文或适当降低 max_tokens。"
)


def _ssl_in_exception_chain(exc: BaseException) -> bool:
    cur: BaseException | None = exc
    seen: set[int] = set()
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, ssl.SSLError):
            return True
        cur = cur.__cause__
    return False


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
    max_tokens: int | None = 65536,
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

    # read：流式两包之间可能长时间无数据，但完全无限期易表现为「卡住」；设较长上限便于失败可见。
    timeout = httpx.Timeout(connect=60.0, read=900.0, write=300.0, pool=60.0)
    with httpx.Client(timeout=timeout) as client:
        try:
            with client.stream("POST", url, headers=headers, json=body) as resp:
                resp.raise_for_status()
                try:
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
                except httpx.ReadError as e:
                    if _ssl_in_exception_chain(e):
                        raise RuntimeError(_SSL_TLS_HINT) from e
                    msg = (
                        "上游在流式输出未完成时关闭了连接（incomplete chunked read 通常由此引起）。"
                        "可稍后重试，或检查网络/代理/VPN、降低 max_tokens、更换模型或 API 线路。"
                    )
                    raise RuntimeError(msg) from e
                except httpx.RemoteProtocolError as e:
                    if _ssl_in_exception_chain(e):
                        raise RuntimeError(_SSL_TLS_HINT) from e
                    msg = (
                        "上游返回的 HTTP 流协议异常（可能被网关或服务商提前终止）。"
                        "请重试或更换接入点/模型。"
                    )
                    raise RuntimeError(msg) from e
                except ssl.SSLError as e:
                    raise RuntimeError(_SSL_TLS_HINT) from e
        except httpx.ConnectError as e:
            if _ssl_in_exception_chain(e):
                raise RuntimeError(_SSL_TLS_HINT) from e
            raise
