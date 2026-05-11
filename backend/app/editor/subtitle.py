"""
从分镜 shots 自动生成 SRT 字幕文件
逻辑：按 shot_number 顺序，累计时间码，从 subtitle_text / dialogue 取字幕文本
"""
from pathlib import Path
from typing import List, Optional

from ..db.models import StoryboardShot


def _srt_time(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int(round((sec - int(sec)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _parse_tc(tc: str) -> Optional[float]:
    """
    将时间码字符串转为秒数。
    支持 HH:MM:SS:FF（SMPTE，假定 25fps）或 HH:MM:SS.mmm。
    解析失败返回 None。
    """
    if not tc or not tc.strip():
        return None
    tc = tc.strip().replace(";", ":")
    try:
        parts = tc.split(":")
        if len(parts) == 4:  # HH:MM:SS:FF
            h, m, s, ff = parts
            return int(h) * 3600 + int(m) * 60 + int(s) + int(ff) / 25.0
        elif len(parts) == 3:  # HH:MM:SS or HH:MM:SS.mmm
            h, m, s = parts
            return int(h) * 3600 + int(m) * 60 + float(s)
        else:
            return float(tc)
    except (ValueError, TypeError):
        return None


def shots_to_srt(shots: List[StoryboardShot], default_duration: float = 3.0) -> str:
    """
    将 shot 列表转为 SRT 字幕字符串。
    时间码来源：shot.timecode_in / timecode_out 若已填写则直接用；
    否则按顺序累计（每 shot 用 duration_sec 或 default_duration）。
    字幕文本优先级：subtitle_text > dialogue
    """
    lines = []
    idx = 1
    cursor = 0.0
    for shot in sorted(shots, key=lambda s: s.shot_number):
        text = (shot.subtitle_text or "").strip()
        if not text:
            text = (shot.dialogue or "").strip()

        dur = float(shot.duration_sec or default_duration) or default_duration

        # 解析时间码
        tc_in = _parse_tc(shot.timecode_in or "")
        tc_out = _parse_tc(shot.timecode_out or "")

        if tc_in is not None and tc_out is not None and tc_out > tc_in:
            t_start = tc_in
            t_end = tc_out
        else:
            t_start = cursor
            t_end = cursor + dur

        # 无文本的 shot 仍推进时间轴
        if not text:
            cursor = t_end
            continue

        lines.append(
            f"{idx}\n{_srt_time(t_start)} --> {_srt_time(t_end)}\n{text}\n"
        )
        idx += 1
        cursor = t_end

    return "\n".join(lines)


def export_srt_for_scene(shots: List[StoryboardShot], out_path: str) -> str:
    """生成 SRT 并写文件，返回文件路径"""
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    content = shots_to_srt(shots)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(content)
    return out_path
