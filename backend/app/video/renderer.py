"""调用 Hyperframes CLI 渲染 composition → MP4。"""
from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Generator

from ..ffmpeg_check import get_ffmpeg_path


def normalize_hyperframes_fps(fps: int) -> int:
    """Hyperframes 0.5.x 仅允许 24 / 30 / 60（传 25 会直接 exit 1）。"""
    if fps in (24, 30, 60):
        return fps
    if fps <= 21:
        return 24
    if fps <= 45:
        return 30
    return 60


def _resolution_args(width: int, height: int) -> list[str]:
    """CLI 用 --resolution 预设，勿传不存在的 --width/--height。"""
    if width == 1080 and height == 1920:
        return ["--resolution", "portrait"]
    if width == 1920 and height == 1080:
        return ["--resolution", "landscape"]
    if width == 2160 and height == 3840:
        return ["--resolution", "portrait-4k"]
    if width == 3840 and height == 2160:
        return ["--resolution", "landscape-4k"]
    return []


def _find_path_key(env: dict[str, str]) -> str:
    """Windows env keys are case-insensitive; find the actual casing used for PATH."""
    for k in env:
        if k.upper() == "PATH":
            return k
    return "PATH"


def _augment_env_for_ffmpeg(env: dict[str, str]) -> dict[str, str]:
    """把 ffmpeg.exe / ffprobe.exe 所在目录插入 PATH，避免 Electron/后端子进程找不到 FFmpeg。"""
    out = dict(env)
    ff = get_ffmpeg_path()
    if not ff:
        return out
    bin_dir = str(Path(ff).resolve().parent)
    path_key = _find_path_key(out)
    old = out.get(path_key, "")
    parts = old.split(os.pathsep) if old else []
    if bin_dir not in parts:
        out[path_key] = bin_dir + os.pathsep + old
    return out


def find_windows_chrome_for_hyperframes() -> str:
    """Hyperframes ensureBrowser 读 HYPERFRAMES_BROWSER_PATH；引擎里 puppeteer 还读 PRODUCER_HEADLESS_SHELL_PATH。"""
    if os.name != "nt":
        return ""
    pf = os.environ.get("PROGRAMFILES", r"C:\Program Files")
    pf86 = os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
    local = os.environ.get("LOCALAPPDATA", "")
    for exe in (
        Path(pf) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(pf86) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(local) / "Google" / "Chrome" / "Application" / "chrome.exe",
    ):
        try:
            if exe.is_file():
                return str(exe.resolve())
        except OSError:
            continue
    return ""


def _find_npx() -> str:
    npx = shutil.which("npx")
    if npx:
        return npx
    project_root = Path(__file__).resolve().parents[3]
    for candidate in [
        project_root / "node_modules" / ".bin" / "hyperframes.cmd",
        project_root / "node_modules" / ".bin" / "hyperframes",
    ]:
        if candidate.exists():
            return str(candidate)
    return "npx"


def _find_hyperframes_bin() -> tuple[str, list[str]]:
    """Return (executable, args_prefix) for running hyperframes."""
    project_root = Path(__file__).resolve().parents[3]
    for ext in (".cmd", ""):
        candidate = project_root / "node_modules" / ".bin" / f"hyperframes{ext}"
        if candidate.exists():
            return str(candidate), []
    return _find_npx(), ["hyperframes"]


def render_composition(
    composition_dir: Path,
    output_path: Path,
    *,
    width: int = 1080,
    height: int = 1920,
    fps: int = 30,
    format: str = "mp4",
) -> Generator[dict, None, None]:
    """
    Stream-render a composition directory to an MP4 file.
    Yields progress dicts: {"type": "progress", "pct": 42} or {"type": "done", "path": "..."}.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    hf_fps = normalize_hyperframes_fps(fps)
    exe, prefix = _find_hyperframes_bin()
    cmd: list[str] = [
        exe,
        *prefix,
        "render",
        str(composition_dir),
        "--output",
        str(output_path),
        "--fps",
        str(hf_fps),
        "--format",
        format,
    ]
    cmd.extend(_resolution_args(width, height))

    extra = (os.environ.get("SCREENPLAY_HYPERFRAMES_ARGS") or "").strip()
    if extra:
        try:
            cmd.extend(shlex.split(extra, posix=os.name != "nt"))
        except ValueError:
            pass

    base_env = {**os.environ, "PYTHONUTF8": "1"}
    env = _augment_env_for_ffmpeg(base_env)
    browser = (
        (env.get("HYPERFRAMES_BROWSER_PATH") or "").strip()
        or (env.get("PRODUCER_HEADLESS_SHELL_PATH") or "").strip()
    )
    if not browser:
        browser = find_windows_chrome_for_hyperframes()
    if browser:
        env["HYPERFRAMES_BROWSER_PATH"] = browser
        env["PRODUCER_HEADLESS_SHELL_PATH"] = browser

    yield {"type": "start", "cmd": " ".join(cmd), "fps_used": hf_fps}

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            cwd=str(composition_dir),
        )
    except FileNotFoundError:
        yield {
            "type": "error",
            "message": "hyperframes CLI not found. 请在项目根目录执行: npm install hyperframes",
        }
        return

    log_lines: list[str] = []
    last_pct = -1
    assert proc.stdout is not None
    for line in iter(proc.stdout.readline, ""):
        line = line.rstrip()
        if not line:
            continue
        log_lines.append(line)
        if len(log_lines) > 200:
            log_lines.pop(0)

        pct = _parse_progress(line)
        if pct is not None and pct != last_pct:
            last_pct = pct
            yield {"type": "progress", "pct": pct, "line": line}
        else:
            yield {"type": "log", "line": line}

    proc.wait()

    if proc.returncode == 0 and output_path.exists():
        size_mb = output_path.stat().st_size / (1024 * 1024)
        yield {
            "type": "done",
            "path": str(output_path),
            "size_mb": round(size_mb, 2),
        }
    else:
        tail = "\n".join(log_lines[-80:])
        detail = tail.strip() or f"exit code {proc.returncode}"
        log_path = composition_dir / "hyperframes-render.log"
        try:
            log_path.write_text("\n".join(log_lines), encoding="utf-8")
        except OSError:
            log_path = None
        msg = f"hyperframes render 失败（exit {proc.returncode}）:\n{detail}"
        if log_path:
            msg += f"\n\n完整日志: {log_path}"
        yield {
            "type": "error",
            "message": msg,
            "exit_code": proc.returncode,
            "log_file": str(log_path) if log_path else None,
        }


def _parse_progress(line: str) -> int | None:
    """Try to extract a percentage from a line like 'Rendering: 42%' or 'frame 50/120'."""
    low = line.lower()
    if "%" in low:
        for part in low.split():
            part = part.strip("%").strip()
            try:
                return int(float(part))
            except ValueError:
                continue
    if "/" in low and ("frame" in low or "rendering" in low):
        for part in low.split():
            if "/" in part:
                try:
                    cur, total = part.split("/")
                    return int(100 * int(cur) / int(total))
                except (ValueError, ZeroDivisionError):
                    continue
    return None
