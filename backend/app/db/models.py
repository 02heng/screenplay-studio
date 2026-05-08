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
    shot_type: str = Field(default="")      # WS / MS / CU / ECU / OTS …
    camera_movement: str = Field(default="")  # STATIC / PAN / TILT / DOLLY / CRANE …
    action: str = Field(default="")          # what happens in frame
    dialogue: str = Field(default="")        # any dialogue or VO
    ai_prompt: str = Field(default="")       # composite prompt for image generation
    animation_prompt: str = Field(default="")  # prompt for frame-animation / video
    image_path: Optional[str] = Field(default=None)   # relative path to generated image
    video_path: Optional[str] = Field(default=None)   # relative path to generated clip
    duration_sec: float = Field(default=3.0)
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class EditShot(SQLModel, table=True):
    __tablename__ = "edit_shots"

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="projects.id", index=True)
    storyboard_shot_id: Optional[int] = Field(default=None, foreign_key="storyboard_shots.id")
    order_index: int = Field(default=0)
    clip_path: Optional[str] = Field(default=None)
    in_point: float = Field(default=0.0)   # seconds
    out_point: float = Field(default=0.0)
    timecode: str = Field(default="00:00:00:00")
    note: str = Field(default="")
    created_at: datetime = Field(default_factory=_now)
