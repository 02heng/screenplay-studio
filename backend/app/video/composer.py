"""将分镜数据转化为 Hyperframes HTML composition 文件。"""
from __future__ import annotations

import html
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class ShotData:
    shot_number: int
    duration_sec: float
    shot_content: str
    shot_type: str
    camera_movement: str
    dialogue: str
    subtitle_text: str
    action: str
    color_tone: str
    lighting: str
    image_path: Optional[str] = None
    video_path: Optional[str] = None
    audio_path: Optional[str] = None
    scene_location: str = ""


CAMERA_CSS = {
    "STATIC": "",
    "PAN_LEFT": "translateX(5%)",
    "PAN_RIGHT": "translateX(-5%)",
    "PAN": "translateX(-5%)",
    "TILT_UP": "translateY(5%)",
    "TILT_DOWN": "translateY(-5%)",
    "TILT": "translateY(-5%)",
    "DOLLY_IN": "scale(1.15)",
    "DOLLY_OUT": "scale(0.92)",
    "DOLLY": "scale(1.15)",
    "ZOOM_IN": "scale(1.2)",
    "ZOOM_OUT": "scale(0.85)",
    "CRANE_UP": "translateY(8%) scale(0.95)",
    "CRANE_DOWN": "translateY(-8%) scale(1.05)",
    "CRANE": "translateY(8%) scale(0.95)",
    "TRACKING": "translateX(-4%)",
    "PUSH_IN": "scale(1.12)",
    "PULL_OUT": "scale(0.9)",
    "HANDHELD": "translate(1%, -1%) rotate(0.3deg)",
}


def _esc(text: str) -> str:
    return html.escape(text.strip(), quote=True)


def _resolve_media(asset_base: Path, rel_path: str | None) -> str | None:
    """Return the absolute file:// URI if the asset exists on disk."""
    if not rel_path:
        return None
    p = asset_base / rel_path
    if p.exists():
        return p.as_uri()
    if Path(rel_path).is_absolute() and Path(rel_path).exists():
        return Path(rel_path).as_uri()
    return None


def build_composition(
    shots: list[ShotData],
    *,
    output_dir: Path,
    asset_base: Path,
    width: int = 1080,
    height: int = 1920,
    fps: int = 30,
    title: str = "storyboard-preview",
) -> Path:
    total_dur = sum(s.duration_sec for s in shots)
    if total_dur <= 0:
        total_dur = len(shots) * 3.0

    clips_html: list[str] = []
    audio_html: list[str] = []
    subtitle_html: list[str] = []
    gsap_steps: list[str] = []

    t = 0.0
    for i, shot in enumerate(shots):
        dur = shot.duration_sec if shot.duration_sec > 0 else 3.0
        cid = f"shot-{i}"

        video_src = _resolve_media(asset_base, shot.video_path)
        image_src = _resolve_media(asset_base, shot.image_path)

        if video_src:
            clips_html.append(
                f'  <video id="{cid}" class="clip" '
                f'data-start="{t:.2f}" data-duration="{dur:.2f}" data-track-index="0" '
                f'src="{video_src}" muted playsinline></video>'
            )
        elif image_src:
            cam = shot.camera_movement.upper().replace(" ", "_")
            cam_transform = CAMERA_CSS.get(cam, "")
            style_extra = ""
            if cam_transform:
                style_extra = f' style="--cam-end: {cam_transform};"'

            clips_html.append(
                f'  <img id="{cid}" class="clip shot-img{" cam-move" if cam_transform else ""}" '
                f'data-start="{t:.2f}" data-duration="{dur:.2f}" data-track-index="0" '
                f'src="{image_src}"{style_extra} />'
            )

            if cam_transform:
                gsap_steps.append(
                    f'  tl.fromTo("#{cid}", '
                    f'{{ scale: 1, x: 0, y: 0, rotation: 0 }}, '
                    f'{{ {_gsap_props(cam)}, duration: {dur:.2f}, ease: "power1.inOut" }}, '
                    f'{t:.2f});'
                )
        else:
            bg_color = _tone_to_color(shot.color_tone)
            content_text = _esc(shot.shot_content or shot.action or f"镜头 {shot.shot_number}")
            shot_label = _esc(shot.shot_type) if shot.shot_type else ""
            scene_label = _esc(shot.scene_location)

            clips_html.append(
                f'  <div id="{cid}" class="clip placeholder-card" '
                f'data-start="{t:.2f}" data-duration="{dur:.2f}" data-track-index="0" '
                f'style="background: {bg_color};">'
                f'<div class="ph-scene">{scene_label}</div>'
                f'<div class="ph-type">{shot_label}</div>'
                f'<div class="ph-content">{content_text}</div>'
                f'</div>'
            )

        tts_src = _resolve_media(asset_base, shot.audio_path)
        if tts_src:
            audio_html.append(
                f'  <audio id="audio-{i}" data-start="{t:.2f}" data-duration="{dur:.2f}" '
                f'data-track-index="2" data-volume="1.0" src="{tts_src}"></audio>'
            )

        sub = (shot.subtitle_text or shot.dialogue or "").strip()
        if sub:
            subtitle_html.append(
                f'  <div id="sub-{i}" class="clip subtitle" '
                f'data-start="{t:.2f}" data-duration="{dur:.2f}" data-track-index="1">'
                f'{_esc(sub)}</div>'
            )

        t += dur

    gsap_block = ""
    if gsap_steps:
        gsap_block = (
            '<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>\n'
            "<script>\n"
            "document.addEventListener('DOMContentLoaded', () => {\n"
            '  const tl = gsap.timeline({ paused: true });\n'
            + "\n".join(gsap_steps) + "\n"
            "  window.__hfTimeline = tl;\n"
            "});\n"
            "</script>"
        )

    composition_html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width={width}, height={height}" />
<title>{_esc(title)}</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ width: {width}px; height: {height}px; overflow: hidden; background: #0a0a0a; font-family: "PingFang SC", "Microsoft YaHei", sans-serif; }}
  .clip {{ position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; }}
  .clip[data-active] {{ opacity: 1; }}
  .shot-img {{ object-fit: cover; transform-origin: center center; }}
  .cam-move {{ will-change: transform; }}
  .placeholder-card {{
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 20px; padding: 40px; color: #fff; text-align: center;
  }}
  .ph-scene {{ font-size: 28px; opacity: 0.5; letter-spacing: 0.1em; text-transform: uppercase; }}
  .ph-type {{ font-size: 48px; font-weight: 700; opacity: 0.8; }}
  .ph-content {{ font-size: 32px; line-height: 1.5; max-width: 80%; opacity: 0.9; }}
  .subtitle {{
    inset: auto 0 120px 0; height: auto; width: auto;
    display: flex; align-items: flex-end; justify-content: center;
    padding: 0 60px; text-align: center;
  }}
  .subtitle[data-active] {{
    opacity: 1;
    background: none;
  }}
  .subtitle::after {{
    content: attr(data-text);
    font-size: 36px; font-weight: 600; color: #fff;
    text-shadow: 0 2px 8px rgba(0,0,0,0.8), 0 0 2px rgba(0,0,0,0.9);
    line-height: 1.4; padding: 8px 16px;
  }}
</style>
</head>
<body>
<div id="stage"
  data-composition-id="{_esc(title)}"
  data-start="0"
  data-duration="{total_dur:.2f}"
  data-width="{width}"
  data-height="{height}"
  data-fps="{fps}"
>
{chr(10).join(clips_html)}
{chr(10).join(subtitle_html)}
{chr(10).join(audio_html)}
</div>
{gsap_block}
</body>
</html>"""

    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / "index.html"
    out_path.write_text(composition_html, encoding="utf-8")
    return out_path


def _gsap_props(cam_key: str) -> str:
    m = {
        "PAN_LEFT": "x: '5%'",
        "PAN_RIGHT": "x: '-5%'",
        "PAN": "x: '-5%'",
        "TILT_UP": "y: '5%'",
        "TILT_DOWN": "y: '-5%'",
        "TILT": "y: '-5%'",
        "DOLLY_IN": "scale: 1.15",
        "DOLLY_OUT": "scale: 0.92",
        "DOLLY": "scale: 1.15",
        "ZOOM_IN": "scale: 1.2",
        "ZOOM_OUT": "scale: 0.85",
        "CRANE_UP": "y: '8%', scale: 0.95",
        "CRANE_DOWN": "y: '-8%', scale: 1.05",
        "CRANE": "y: '8%', scale: 0.95",
        "TRACKING": "x: '-4%'",
        "PUSH_IN": "scale: 1.12",
        "PULL_OUT": "scale: 0.9",
        "HANDHELD": "x: '1%', y: '-1%', rotation: 0.3",
    }
    return m.get(cam_key, "scale: 1")


def _tone_to_color(tone: str) -> str:
    t = (tone or "").strip().lower()
    if not t:
        return "linear-gradient(135deg, #1a1a2e, #16213e)"
    mapping = {
        "冷色": "linear-gradient(135deg, #0f3460, #1a1a2e)",
        "暖色": "linear-gradient(135deg, #e94560, #533483)",
        "warm": "linear-gradient(135deg, #e94560, #533483)",
        "cold": "linear-gradient(135deg, #0f3460, #1a1a2e)",
        "cool": "linear-gradient(135deg, #0f3460, #1a1a2e)",
        "dark": "linear-gradient(135deg, #0a0a0a, #1a1a1a)",
        "暗": "linear-gradient(135deg, #0a0a0a, #1a1a1a)",
        "bright": "linear-gradient(135deg, #f5f5dc, #e0c097)",
        "明亮": "linear-gradient(135deg, #f5f5dc, #e0c097)",
    }
    for key, grad in mapping.items():
        if key in t:
            return grad
    return "linear-gradient(135deg, #1a1a2e, #16213e)"
