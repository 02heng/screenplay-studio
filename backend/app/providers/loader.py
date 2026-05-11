"""
Provider 加载器。

优先读取 D:\\Screenplay-Studio-data\\UserData\\media_providers.yaml，
回退到 backend/config/media_providers.example.yaml。
当前为骨架实现，各 Provider 返回 stub 实例。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

try:
    import yaml  # type: ignore[import]
    _YAML_AVAILABLE = True
except ImportError:
    _YAML_AVAILABLE = False

from .base import ImageProvider, VideoProvider, TTSProvider, StubTTSProvider

# ── Stub 实现（占位，待真正对接 API 时替换）────────────────────────────────

class _StubImageProvider(ImageProvider):
    async def generate_image(self, prompt: str, **kwargs) -> str:
        raise NotImplementedError("图片 Provider 尚未配置，请检查 media_providers.yaml")


class _StubVideoProvider(VideoProvider):
    async def generate_video(
        self,
        prompt: str,
        start_image: Optional[str] = None,
        end_image: Optional[str] = None,
        frame_images: Optional[list[str]] = None,
        duration_sec: float = 5.0,
        **kwargs,
    ) -> str:
        raise NotImplementedError("视频 Provider 尚未配置，请检查 media_providers.yaml")


# ── 配置文件查找 ──────────────────────────────────────────────────────────────

def _find_config() -> Optional[Path]:
    candidates = [
        Path(r"D:\Screenplay-Studio-data\UserData\media_providers.yaml"),
        Path(__file__).resolve().parents[3] / "config" / "media_providers.example.yaml",
    ]
    env_path = os.environ.get("MEDIA_PROVIDERS_YAML", "").strip()
    if env_path:
        candidates.insert(0, Path(env_path))

    for p in candidates:
        if p.is_file():
            return p
    return None


def _load_config() -> dict[str, Any]:
    path = _find_config()
    if not path or not _YAML_AVAILABLE:
        return {}
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


# ── 公开接口 ──────────────────────────────────────────────────────────────────

def get_image_provider() -> ImageProvider:
    """返回配置的图片 Provider 实例。"""
    cfg = _load_config()
    img_cfg = cfg.get("image_provider", {})
    name = img_cfg.get("name", "stub")
    if name == "comfyui":
        from .image_comfyui import ComfyUIProvider
        return ComfyUIProvider(
            base_url=img_cfg.get("base_url", "http://127.0.0.1:8188"),
            checkpoint=img_cfg.get("checkpoint", ""),
            output_dir=img_cfg.get("output_dir", "D:/Screenplay-Studio-data/images"),
        )
    return _StubImageProvider()


def get_video_provider() -> VideoProvider:
    """返回配置的视频 Provider 实例（目前为 stub）。"""
    cfg = _load_config()
    _vid_cfg = cfg.get("video_provider", {})
    # TODO: 根据 _vid_cfg["name"] 实例化对应的真实 Provider
    return _StubVideoProvider()


def get_tts_provider() -> TTSProvider:
    """返回配置的 TTS Provider 实例。"""
    cfg = _load_config().get("tts_provider", {})
    name = cfg.get("name", "stub")
    if name == "edge_tts":
        from .tts_edge import EdgeTTSProvider
        return EdgeTTSProvider(voice=cfg.get("voice", "zh-CN-XiaoxiaoNeural"))
    elif name == "openai_tts":
        from .tts_openai import OpenAITTSProvider
        return OpenAITTSProvider(
            api_key=cfg.get("api_key", ""),
            model=cfg.get("model", "tts-1"),
            base_url=cfg.get("base_url", ""),
        )
    return StubTTSProvider()
