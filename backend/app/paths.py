from __future__ import annotations

import os
from pathlib import Path


def user_data_dir() -> Path:
    raw = os.environ.get("SCREENPLAY_USER_DATA", "").strip()
    if raw:
        return Path(raw).resolve()
    # prefer D:\Screenplay-Studio-data\UserData on Windows
    if os.name == "nt":
        candidate = Path("D:/Screenplay-Studio-data/UserData")
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            return candidate
        except OSError:
            pass
    return Path.home() / ".screenplay-studio"


def projects_dir() -> Path:
    """Root for all per-project asset directories."""
    d = user_data_dir().parent / "Projects"
    d.mkdir(parents=True, exist_ok=True)
    return d


def project_asset_dir(project_id: int) -> Path:
    d = projects_dir() / str(project_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def project_root() -> Path:
    raw = os.environ.get("SCREENPLAY_PROJECT_ROOT", "").strip()
    if raw:
        return Path(raw).resolve()
    return Path(__file__).resolve().parents[2]


def backend_dir() -> Path:
    return project_root() / "backend"


def config_dir() -> Path:
    return backend_dir() / "config"


def providers_file_user() -> Path:
    return user_data_dir() / "providers.yaml"


def providers_file_bundled() -> Path:
    return config_dir() / "providers.yaml"


def providers_example() -> Path:
    return config_dir() / "providers.example.yaml"
