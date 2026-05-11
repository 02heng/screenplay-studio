"""
EdgeTTS Provider —— 使用微软 Edge TTS（免费，无需 API Key）
依赖：pip install edge-tts（可选，运行时动态导入）
推荐声音：zh-CN-XiaoxiaoNeural（女）、zh-CN-YunxiNeural（男）
"""
import asyncio
from pathlib import Path

from .base import TTSProvider


class EdgeTTSProvider(TTSProvider):
    def __init__(self, voice: str = "zh-CN-XiaoxiaoNeural"):
        self.default_voice = voice

    async def synthesize(
        self,
        text: str,
        voice: str = "",
        speed: float = 1.0,
        pitch: float = 0.0,
        output_path: str = "",
    ) -> str:
        try:
            import edge_tts
        except ImportError:
            raise ImportError("请安装 edge-tts：pip install edge-tts")

        use_voice = voice or self.default_voice
        rate = f"+{int((speed - 1) * 100)}%" if speed != 1.0 else "+0%"
        pitch_str = f"+{int(pitch)}Hz" if pitch != 0 else "+0Hz"

        if not output_path:
            import time
            out = Path(f"D:/Screenplay-Studio-data/tts/tts_{int(time.time())}.mp3")
            out.parent.mkdir(parents=True, exist_ok=True)
            output_path = str(out)

        communicate = edge_tts.Communicate(text, use_voice, rate=rate, pitch=pitch_str)
        await communicate.save(output_path)
        return output_path
