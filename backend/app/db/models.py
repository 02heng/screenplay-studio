from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel


def _now() -> datetime:
    return datetime.utcnow()


class Project(SQLModel, table=True):
    __tablename__ = "projects"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    type: str = Field(default="feature")  # feature | short_drama | novel_adapt
    description: str = Field(default="")
    cover_image: Optional[str] = Field(default=None)  # relative path inside project dir
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class Script(SQLModel, table=True):
    __tablename__ = "scripts"

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="projects.id", index=True)
    title: str = Field(default="untitled")
    content: str = Field(default="")
    stage: str = Field(default="draft")  # draft | final
    file_path: Optional[str] = Field(default=None)  # .md / .fountain path on disk
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class Character(SQLModel, table=True):
    __tablename__ = "characters"

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="projects.id", index=True)
    name: str
    description: str = Field(default="")
    ai_prompt: str = Field(default="")  # text-to-image prompt for consistent appearance
    # JSON array of relative paths to reference images
    reference_image_paths: str = Field(default="[]")
    three_view_image_path: str = Field(default="")   # 三视图出图结果路径
    three_view_status: str = Field(default="")        # pending | generating | done | error
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)

    def get_reference_images(self) -> list[str]:
        try:
            return json.loads(self.reference_image_paths)
        except Exception:
            return []

    def set_reference_images(self, paths: list[str]) -> None:
        self.reference_image_paths = json.dumps(paths, ensure_ascii=False)


class Scene(SQLModel, table=True):
    __tablename__ = "scenes"

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="projects.id", index=True)
    script_id: Optional[int] = Field(default=None, foreign_key="scripts.id")
    scene_number: int = Field(default=1)
    location: str = Field(default="")
    time_of_day: str = Field(default="")  # DAY | NIGHT | DAWN | DUSK
    description: str = Field(default="")
    created_at: datetime = Field(default_factory=_now)


class StoryboardShot(SQLModel, table=True):
    __tablename__ = "storyboard_shots"

    id: Optional[int] = Field(default=None, primary_key=True)
    scene_id: int = Field(foreign_key="scenes.id", index=True)
    project_id: int = Field(foreign_key="projects.id", index=True)
    shot_number: int = Field(default=1)

    # ── 时间轴 ──────────────────────────────────────────────────────────────
    timecode_in: str = Field(default="")     # 镜头开始时间码，如 00:00:03:00
    timecode_out: str = Field(default="")    # 镜头结束时间码
    duration_sec: float = Field(default=3.0)

    # ── 画面 ────────────────────────────────────────────────────────────────
    shot_content: str = Field(default="")    # 画面内容描述（主体、环境、构图）
    shot_type: str = Field(default="")       # WS / MS / CU / ECU / OTS …
    camera_movement: str = Field(default="") # STATIC / PAN / TILT / DOLLY / CRANE …
    director_intent: str = Field(default="") # 导演意图/动作焦点

    # ── 摄影参数 ─────────────────────────────────────────────────────────────
    camera_params: str = Field(default="")   # 焦段、光圈、快门，如 35mm f/1.8 1/250s
    lighting: str = Field(default="")        # 灯光描述
    color_tone: str = Field(default="")      # 色调风格

    # ── 音效 ────────────────────────────────────────────────────────────────
    sound_design: str = Field(default="")    # 音效设计（环境音、音效）

    # ── 台词与字幕 ───────────────────────────────────────────────────────────
    dialogue: str = Field(default="")        # 台词或 VO
    subtitle_text: str = Field(default="")   # 字幕文本（可与台词不同）

    # ── 动作与 AI ────────────────────────────────────────────────────────────
    action: str = Field(default="")          # what happens in frame
    ai_prompt: str = Field(default="")       # composite prompt for image generation
    animation_prompt: str = Field(default="")  # prompt for frame-animation / video

    # ── 参考帧图片（JSON 数组字符串）────────────────────────────────────────
    frame_images: str = Field(default="[]")  # 关键帧 / 参考图路径列表 JSON（首张为主预览）

    # ── 生成结果 ─────────────────────────────────────────────────────────────
    image_path: Optional[str] = Field(default=None)   # 主预览关键帧 URL 或路径，建议与 frame_images[0] 同步
    video_path: Optional[str] = Field(default=None)   # 主预览视频 URL 或路径，建议与 video_paths[0] 同步
    video_paths: str = Field(default="[]")               # 多段镜头视频路径 JSON（供同一分镜备选 / 预览切换）
    audio_path: str = Field(default="")               # TTS 合成音频路径

    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class Episode(SQLModel, table=True):
    __tablename__ = "episodes"

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="projects.id", index=True)
    ep_number: int = Field(default=1)
    title: str = Field(default="")
    core_event: str = Field(default="")       # 核心事件
    opening_hook: str = Field(default="")     # 开场钩子
    ending_hook: str = Field(default="")      # 结尾钩子
    hook_type: str = Field(default="")        # 钩子类型
    emotion_arc: str = Field(default="")      # 情绪走向
    special_note: str = Field(default="")     # 特殊标注（⚡强反转等）
    script_content: str = Field(default="")   # 本集完整剧本正文
    word_count: int = Field(default=0)
    status: str = Field(default="planned")    # planned | scripted | storyboarded | done
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class EditShot(SQLModel, table=True):
    __tablename__ = "edit_shots"

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="projects.id", index=True)
    storyboard_shot_id: Optional[int] = Field(default=None, foreign_key="storyboard_shots.id")
    # 流水线导入剪辑时写入，用于「按集替换」时只删本集、不擦掉其他集已有剪辑
    ep_number: Optional[int] = Field(default=None, index=True)
    order_index: int = Field(default=0)
    clip_path: Optional[str] = Field(default=None)
    in_point: float = Field(default=0.0)   # seconds
    out_point: float = Field(default=0.0)
    timecode: str = Field(default="00:00:00:00")
    note: str = Field(default="")
    created_at: datetime = Field(default_factory=_now)


class GenerationJob(SQLModel, table=True):
    __tablename__ = "generation_jobs"

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(index=True)
    job_type: str = Field(default="")      # image_batch | video_batch | three_view
    scene_id: Optional[int] = Field(default=None)
    status: str = Field(default="running")  # running | done | error
    total: int = Field(default=0)
    success: int = Field(default=0)
    failed: int = Field(default=0)
    result_json: str = Field(default="[]")  # JSON array of per-shot results
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class Timeline(SQLModel, table=True):
    __tablename__ = "timelines"

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="projects.id", index=True)
    name: str = Field(default="主时间线")
    fps: int = Field(default=25)
    resolution: str = Field(default="1080x1920")   # 竖屏 9:16
    # ClipItem[]: { id, shot_id, video_path, in_point, out_point, order_index, transition, transition_duration }
    clips_json: str = Field(default="[]")
    # SubtitleItem[]: { id, text, start_sec, end_sec, position, font_size, color }
    subtitles_json: str = Field(default="[]")
    # BgmTrack[]: { id, audio_path, start_sec, volume, loop }
    bgm_json: str = Field(default="[]")
    status: str = Field(default="draft")   # draft | exporting | done | error
    export_path: str = Field(default="")
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class ProjectSnapshot(SQLModel, table=True):
    __tablename__ = "project_snapshots"

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="projects.id", index=True)
    label: str = Field(default="")            # 版本标签，如 "第一稿" "导演版"
    snapshot_json: str = Field(default="{}")  # 完整项目数据快照（JSON）
    created_at: datetime = Field(default_factory=_now)
