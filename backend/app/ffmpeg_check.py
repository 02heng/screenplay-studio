"""FFmpeg 可用性检查 + 路径自动发现"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path


def _ffmpeg_path_from_hop(p: Path) -> Path | None:
    """FFMPEG_PATH 可为可执行文件或为其所在目录（Windows: …/bin）。"""
    if not p.exists():
        return None
    if p.is_file():
        return p
    if p.is_dir():
        exe = p / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        if exe.is_file():
            return exe
    return None


def _extra_ffmpeg_candidates() -> list[Path]:
    """Electron/后端子进程里 PATH 常比用户终端短；补充常见安装位置。"""
    out: list[Path] = []
    if os.name != "nt":
        home = Path.home()
        out.extend(
            [
                home / "bin" / "ffmpeg",
                Path("/opt/homebrew/bin/ffmpeg"),
                Path("/usr/local/bin/ffmpeg"),
            ]
        )
        return out

    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pfx86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local = os.environ.get("LOCALAPPDATA", "")
    home = Path.home()
    choco = os.environ.get("ChocolateyInstall", r"C:\ProgramData\chocolatey")

    out.extend(
        [
            Path(pf) / "ffmpeg" / "bin" / "ffmpeg.exe",
            Path(pfx86) / "ffmpeg" / "bin" / "ffmpeg.exe",
            Path(r"C:\ffmpeg\bin\ffmpeg.exe"),
            home / "scoop" / "shims" / "ffmpeg.exe",
            home / "scoop" / "apps" / "ffmpeg" / "current" / "bin" / "ffmpeg.exe",
            Path(choco) / "bin" / "ffmpeg.exe",
            Path(choco) / "lib" / "ffmpeg" / "tools" / "ffmpeg" / "bin" / "ffmpeg.exe",
        ]
    )

    for drive in ("C", "D", "E"):
        root = Path(f"{drive}:\\ffmpeg")
        if root.is_dir():
            try:
                for p in sorted(root.rglob("ffmpeg.exe")):
                    if p.is_file():
                        out.append(p)
                        break
            except OSError:
                pass
        root2 = Path(f"{drive}:\\FFmpeg")
        if root2 != root and root2.is_dir():
            try:
                for p in sorted(root2.rglob("ffmpeg.exe")):
                    if p.is_file():
                        out.append(p)
                        break
            except OSError:
                pass

    if local:
        winget_pkg = Path(local) / "Microsoft" / "WinGet" / "Packages"
        if winget_pkg.is_dir():
            try:
                for p in sorted(winget_pkg.rglob("ffmpeg.exe")):
                    if p.is_file():
                        out.append(p)
            except OSError:
                pass

    return out


def get_ffmpeg_path() -> str:
    env_path = (os.environ.get("FFMPEG_PATH") or "").strip()
    if env_path:
        resolved = _ffmpeg_path_from_hop(Path(env_path))
        if resolved:
            return str(resolved.resolve())

    base_dir = Path(__file__).parent.parent.parent
    for candidate in [
        base_dir / "bin" / "ffmpeg.exe",
        base_dir / "bin" / "ffmpeg",
        Path(os.environ.get("RESOURCESPATH", "dummy")) / "bin" / "ffmpeg.exe",
    ]:
        if candidate.exists():
            return str(candidate.resolve())

    which = shutil.which("ffmpeg")
    if which:
        return which

    for candidate in _extra_ffmpeg_candidates():
        try:
            if candidate.is_file():
                return str(candidate.resolve())
        except OSError:
            continue

    return ""


def ffmpeg_available() -> bool:
    p = get_ffmpeg_path()
    if not p:
        return False
    try:
        r = subprocess.run([p, "-version"], capture_output=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False
