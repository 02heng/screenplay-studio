"""
番茄小说阅读页正文解密：页面用 PUA 字符 + 自定义 woff2，需按 glyph id 映射回真实汉字。
字体映射表来自开源项目 zhoulianglen/fanqiexiaoshuo-Download（credit: tianhuoDD/fanqienovel-decryptor）。
"""
from __future__ import annotations

import io
import json
import re
import threading
from typing import Any, Optional

import requests
from bs4 import BeautifulSoup

from .fanqie_font_map import FONT_MAP

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
}

_FONT_CACHE: dict[str, dict[str, str]] = {}
_font_cache_lock = threading.Lock()


def extract_initial_state_dict(html: str) -> dict[str, Any]:
    """
    阅读页内嵌的 __INITIAL_STATE__ 为 JSON。不能用括号深度截取：chapterData.content 里
    的正文若含「}」等字符会破坏深度计数，导致 json 截断、解密失败并出现 PUA 方块乱码。
    """
    for marker in ("window.__INITIAL_STATE__=", "__INITIAL_STATE__="):
        idx = html.find(marker)
        if idx == -1:
            continue
        j0 = idx + len(marker)
        decoder = json.JSONDecoder()
        try:
            data, _ = decoder.raw_decode(html, j0)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
    raise ValueError("页面中未找到可用的 __INITIAL_STATE__ JSON")


def _font_url_from_state(state: dict[str, Any]) -> Optional[str]:
    css = (state.get("common") or {}).get("css") or ""

    m = re.search(r"url\((https://[^)]+\.woff2)\)", css)
    if m:
        return m.group(1)
    m2 = re.search(r"url\((https://[^)]+\.woff)\)", css)
    return m2.group(1) if m2 else None


def build_char_mapping(font_url: str) -> dict[str, str]:
    """PUA 字符 → 真实字符（依赖当前章节页 CSS 指向的 woff2）。"""
    with _font_cache_lock:
        if font_url in _FONT_CACHE:
            return _FONT_CACHE[font_url]
    try:
        from fontTools.ttLib import TTFont
    except ImportError:
        return {}

    r = requests.get(font_url, headers=_HEADERS, timeout=35)
    r.raise_for_status()
    font = TTFont(io.BytesIO(r.content))
    cmap = font.getBestCmap()
    mapping: dict[str, str] = {}
    for pua_codepoint, gname in cmap.items():
        gid = str(gname).replace("gid", "")
        if gid.isdigit() and gid in FONT_MAP:
            mapping[chr(pua_codepoint)] = FONT_MAP[gid]
    with _font_cache_lock:
        _FONT_CACHE[font_url] = mapping
    return mapping


def decrypt_text(text: str, mapping: dict[str, str]) -> str:
    if not mapping:
        return text
    return "".join(mapping.get(ch, ch) for ch in text)


# 番茄章节末尾常见「作者有话说」及变体；从首次出现处截断（含该标记及其后段落）
_FANQIE_AUTHOR_NOTE_MARKERS: tuple[str, ...] = (
    "【作者有话说】",
    "作者有话说",
    "「作者有话说」",
    "作者的话",
)


def _truncate_before_fanqie_author_note(paragraph: str) -> tuple[str, bool]:
    """
    若本段中出现「作者有话说」类标记，返回 (标记前的正文, True)；否则 (原段, False)。
    True 表示本段处理后应停止收集后续 <p>。
    """
    if not paragraph:
        return "", False
    earliest: tuple[int, str] | None = None
    for m in _FANQIE_AUTHOR_NOTE_MARKERS:
        idx = paragraph.find(m)
        if idx != -1 and (earliest is None or idx < earliest[0]):
            earliest = (idx, m)
    if earliest is None:
        return paragraph, False
    prefix = paragraph[: earliest[0]].rstrip()
    return prefix, True


def fanqie_chapter_html_to_plain(chapter_html: str, mapping: dict[str, str]) -> str:
    """章节 content 字段为带 <p> 的片段 HTML。"""
    soup = BeautifulSoup(chapter_html, "lxml")
    parts: list[str] = []
    for p in soup.find_all("p"):
        raw = p.get_text()
        if not raw or not raw.strip():
            continue
        decrypted = decrypt_text(raw.strip(), mapping)
        chunk, stop = _truncate_before_fanqie_author_note(decrypted)
        if stop:
            if chunk:
                parts.append(chunk)
            break
        if p.get("class"):
            continue
        if chunk:
            parts.append(chunk)
    return "\n\n".join(parts)


def decrypt_reader_page_html(html: str) -> str:
    """整页 HTML → 解密后的正文纯文本（失败返回空串）。"""
    try:
        state = extract_initial_state_dict(html)
    except (ValueError, json.JSONDecodeError):
        return ""
    font_url = _font_url_from_state(state)
    if not font_url:
        return ""
    mapping = build_char_mapping(font_url)
    if not mapping:
        return ""
    ch_data = (state.get("reader") or {}).get("chapterData") or {}
    content_html = ch_data.get("content") or ""
    return fanqie_chapter_html_to_plain(content_html, mapping)
