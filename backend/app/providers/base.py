from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional


class ImageProvider(ABC):
    @abstractmethod
    async def generate_image(self, prompt: str, **kwargs) -> str:
        """返回图片 URL 或本地路径"""


class VideoProvider(ABC):
    @abstractmethod
    async def generate_video(
        self,
        prompt: str,
        start_image: Optional[str] = None,
        end_image: Optional[str] = None,
        frame_images: Optional[list[str]] = None,
        duration_sec: float = 5.0,
        **kwargs,
    ) -> str:
        """返回视频 URL 或本地路径"""


class TTSProvider(ABC):
    """文字转语音 Provider 抽象基类"""

    @abstractmethod
    async def synthesize(
        self,
        text: str,
        voice: str = "default",
        speed: float = 1.0,
        pitch: float = 0.0,
        output_path: str = "",
    ) -> str:
        """
        合成语音，返回音频文件路径。
        output_path 为空时自动生成临时路径。
        """
        raise NotImplementedError


class StubTTSProvider(TTSProvider):
    async def synthesize(
        self,
        text: str,
        voice: str = "default",
        speed: float = 1.0,
        pitch: float = 0.0,
        output_path: str = "",
    ) -> str:
        raise NotImplementedError(
            "TTS provider not configured. Set tts_provider in media_providers.yaml"
        )
