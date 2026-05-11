"""OpenAI TTS Provider（也兼容国内 OpenAI 代理）"""
import time
from pathlib import Path

from .base import TTSProvider


class OpenAITTSProvider(TTSProvider):
    def __init__(self, api_key: str, model: str = "tts-1", base_url: str = ""):
        self.api_key = api_key
        self.model = model
        self.base_url = base_url

    async def synthesize(
        self,
        text: str,
        voice: str = "alloy",
        speed: float = 1.0,
        pitch: float = 0.0,
        output_path: str = "",
    ) -> str:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(
            api_key=self.api_key,
            base_url=self.base_url or None,
        )

        if not output_path:
            out = Path(f"D:/Screenplay-Studio-data/tts/tts_{int(time.time())}.mp3")
            out.parent.mkdir(parents=True, exist_ok=True)
            output_path = str(out)

        response = await client.audio.speech.create(
            model=self.model,
            voice=voice or "alloy",
            input=text[:4096],
            speed=max(0.25, min(4.0, speed)),
        )
        response.stream_to_file(output_path)
        return output_path
