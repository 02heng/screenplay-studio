"""ComfyUI 本地图片生成 Provider（HTTP API）"""
import asyncio
import copy
import time
import uuid
from pathlib import Path

from .base import ImageProvider

# 最简 txt2img workflow 骨架（用户可在 ComfyUI 界面导出自定义 workflow 替换）
_WORKFLOW: dict = {
    "3": {
        "inputs": {
            "seed": 42, "steps": 20, "cfg": 7,
            "sampler_name": "euler", "scheduler": "normal", "denoise": 1,
            "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0],
            "latent_image": ["5", 0],
        },
        "class_type": "KSampler",
    },
    "4": {
        "inputs": {"ckpt_name": "v1-5-pruned-emaonly.ckpt"},
        "class_type": "CheckpointLoaderSimple",
    },
    "5": {
        "inputs": {"width": 512, "height": 912, "batch_size": 1},
        "class_type": "EmptyLatentImage",
    },
    "6": {
        "inputs": {"text": "", "clip": ["4", 1]},
        "class_type": "CLIPTextEncode",
    },
    "7": {
        "inputs": {"text": "lowres, bad anatomy, watermark", "clip": ["4", 1]},
        "class_type": "CLIPTextEncode",
    },
    "8": {
        "inputs": {"samples": ["3", 0], "vae": ["4", 2]},
        "class_type": "VAEDecode",
    },
    "9": {
        "inputs": {"filename_prefix": "screenplay", "images": ["8", 0]},
        "class_type": "SaveImage",
    },
}


class ComfyUIProvider(ImageProvider):
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8188",
        checkpoint: str = "",
        output_dir: str = "D:/Screenplay-Studio-data/images",
    ):
        self.base_url = base_url.rstrip("/")
        self.checkpoint = checkpoint
        self.output_dir = output_dir

    async def generate_image(self, prompt: str, **kwargs) -> str:
        try:
            import httpx
        except ImportError:
            raise ImportError("请安装 httpx：pip install httpx")

        negative_prompt: str = kwargs.get("negative_prompt", "")
        size: str = kwargs.get("size", "512x912")

        wf = copy.deepcopy(_WORKFLOW)
        wf["6"]["inputs"]["text"] = prompt
        if negative_prompt:
            wf["7"]["inputs"]["text"] = negative_prompt
        if self.checkpoint:
            wf["4"]["inputs"]["ckpt_name"] = self.checkpoint
        if size and "x" in size:
            w, h = size.split("x", 1)
            wf["5"]["inputs"]["width"] = int(w)
            wf["5"]["inputs"]["height"] = int(h)

        client_id = str(uuid.uuid4())
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(
                f"{self.base_url}/prompt",
                json={"prompt": wf, "client_id": client_id},
            )
            r.raise_for_status()
            prompt_id = r.json()["prompt_id"]

            for _ in range(120):
                await asyncio.sleep(1)
                history = (
                    await client.get(f"{self.base_url}/history/{prompt_id}")
                ).json()
                if prompt_id in history:
                    for node_out in history[prompt_id]["outputs"].values():
                        if "images" in node_out:
                            img = node_out["images"][0]
                            img_r = await client.get(
                                f"{self.base_url}/view",
                                params={
                                    "filename": img["filename"],
                                    "subfolder": img["subfolder"],
                                    "type": img["type"],
                                },
                            )
                            out_dir = Path(self.output_dir)
                            out_dir.mkdir(parents=True, exist_ok=True)
                            out_path = out_dir / f"comfy_{int(time.time())}_{img['filename']}"
                            out_path.write_bytes(img_r.content)
                            return str(out_path)

        raise TimeoutError("ComfyUI generation timed out after 120s")
