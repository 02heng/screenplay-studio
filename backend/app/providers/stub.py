from __future__ import annotations

from typing import Optional

from .base import ImageProvider, VideoProvider


class StubImageProvider(ImageProvider):
    async def generate_image(self, prompt: str, **kwargs) -> str:
        raise NotImplementedError("请在 media_providers.yaml 中配置图片生成 Provider")


class StubVideoProvider(VideoProvider):
    async def generate_video(
        self,
        prompt: str,
        start_image: Optional[str] = None,
        end_image: Optional[str] = None,
        frame_images: Optional[list[str]] = None,
        duration_sec: float = 5.0,
        **kwargs,
    ) -> str:
        raise NotImplementedError("请在 media_providers.yaml 中配置视频生成 Provider")
