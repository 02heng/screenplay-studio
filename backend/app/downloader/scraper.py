"""
小说网站爬虫 - 适配自阅读下载器
支持笔趣阁、天涯书库、新笔趣阁等多种小说站。
自动解析章节列表和正文内容，处理分页合并。
抓取顺序：requests → Scrapling Fetcher(TLS/http) → DrissionPage 直连 → DrissionPage+代理
"""
from __future__ import annotations

import os
import re
import requests
import socket
from bs4 import BeautifulSoup
from typing import Optional, Callable
from urllib.parse import urljoin, urlparse

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

ENCODINGS = ["utf-8", "gbk", "gb2312", "gb18030"]

_browser = None
_browser_proxy = None
PROXY_PORT = None
_browser_domains: set[str] = set()
_direct_domains: set[str] = set()
_proxy_domains: set[str] = set()


def _detect_clash_proxy() -> Optional[str]:
    global PROXY_PORT
    if PROXY_PORT:
        return f"http://127.0.0.1:{PROXY_PORT}"
    for port in [7897, 7890, 7891, 7892, 7893, 7894, 7895, 7896, 1080, 8080]:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(0.3)
            result = sock.connect_ex(("127.0.0.1", port))
            sock.close()
            if result == 0:
                PROXY_PORT = port
                return f"http://127.0.0.1:{port}"
        except Exception:
            continue
    return None


def _create_browser(use_proxy: bool = False):
    from DrissionPage import ChromiumPage, ChromiumOptions
    co = ChromiumOptions()
    co.headless()
    co.set_argument("--disable-gpu")
    co.set_argument("--no-sandbox")
    co.set_argument("--disable-images")
    if use_proxy:
        proxy = _detect_clash_proxy()
        if proxy:
            co.set_argument(f"--proxy-server={proxy}")
    return ChromiumPage(co)


def _get_browser():
    global _browser
    if _browser is not None:
        try:
            _browser.title
            return _browser
        except Exception:
            _browser = None
    try:
        _browser = _create_browser(use_proxy=False)
        return _browser
    except Exception as e:
        print(f"[scraper] 浏览器初始化失败: {e}")
        return None


def _get_browser_proxy():
    global _browser_proxy
    if _browser_proxy is not None:
        try:
            _browser_proxy.title
            return _browser_proxy
        except Exception:
            _browser_proxy = None
    try:
        _browser_proxy = _create_browser(use_proxy=True)
        return _browser_proxy
    except Exception as e:
        print(f"[scraper] 代理浏览器初始化失败: {e}")
        return None


def close_browser() -> None:
    global _browser, _browser_proxy
    for b in (_browser, _browser_proxy):
        if b is not None:
            try:
                b.quit()
            except Exception:
                pass
    _browser = None
    _browser_proxy = None


def _get(url: str, timeout: int = 15) -> requests.Response:
    resp = requests.get(url, headers=HEADERS, timeout=timeout, allow_redirects=True)
    resp.encoding = _detect_encoding(resp)
    return resp


def _decode_bytes_html(body: bytes, preferred_encoding: Optional[str]) -> str:
    pref = None
    if preferred_encoding:
        pe = preferred_encoding.lower().strip()
        pref = (
            next((e for e in ENCODINGS if e.replace("-", "") == pe.replace("-", "")), None)
            or pe.split(";")[0].strip()
        )
    if pref:
        try:
            return body.decode(pref, errors="replace")
        except (LookupError, ValueError):
            pass
    for enc in ENCODINGS:
        try:
            body.decode(enc)
            return body.decode(enc, errors="replace")
        except (UnicodeDecodeError, LookupError):
            continue
    return body.decode("utf-8", errors="replace")


def _scrapling_response_to_html(resp: object) -> str:
    try:
        hc = getattr(resp, "html_content", None)
        if isinstance(hc, str) and len(hc) > 500:
            return hc
        body = getattr(resp, "body", b"") or b""
        if len(body) < 500:
            return ""
        enc = getattr(resp, "encoding", None)
        text = _decode_bytes_html(body, enc if isinstance(enc, str) else None)
        if len(text) > 500 and "403" not in text[:240]:
            return text
        return ""
    except Exception:
        return ""


def _get_html_scrapling_http(url: str, timeout_sec: float) -> str:
    try:
        from scrapling.fetchers import Fetcher
    except ImportError:
        return ""
    try:
        ms = max(1500, int(min(timeout_sec, 120) * 1000))
        r = Fetcher().get(url, timeout=ms)
        if getattr(r, "status", 0) != 200:
            return ""
        txt = _scrapling_response_to_html(r)
        if txt and len(txt) > 500 and "无法访问" not in txt:
            return txt
        return ""
    except Exception as e:
        print(f"[scraper] Scrapling Fetcher 失败 {url}: {e}")
        return ""


def _get_html(url: str, timeout: int = 10) -> str:
    domain = urlparse(url).netloc
    tsec = float(max(1, timeout))

    if domain in _direct_domains:
        try:
            resp = _get(url, min(timeout, 4))
            if resp.status_code == 200 and len(resp.text) > 500:
                if _fanqie_reader_html_incomplete(url, resp.text):
                    _direct_domains.discard(domain)
                else:
                    return resp.text
        except Exception:
            pass
        slack = _get_html_scrapling_http(url, tsec)
        if slack and not _fanqie_reader_html_incomplete(url, slack):
            return slack

    if domain in _browser_domains:
        slack = _get_html_scrapling_http(url, tsec)
        if slack and not _fanqie_reader_html_incomplete(url, slack):
            return slack
        try:
            browser = _get_browser()
            if browser:
                browser.get(url)
                html = browser.html
                if html and len(html) > 500 and not _fanqie_reader_html_incomplete(url, html):
                    return html
        except Exception:
            pass

    if domain in _proxy_domains:
        slack = _get_html_scrapling_http(url, tsec)
        if slack and not _fanqie_reader_html_incomplete(url, slack):
            return slack
        try:
            browser = _get_browser_proxy()
            if browser:
                browser.get(url)
                html = browser.html
                if html and len(html) > 500 and not _fanqie_reader_html_incomplete(url, html):
                    return html
        except Exception:
            pass

    # 未知域名，逐步尝试
    try:
        resp = _get(url, min(timeout, 4))
        if resp.status_code == 200:
            text = resp.text
            if len(text) > 500 and "无法访问" not in text and "403" not in text[:200]:
                if _fanqie_reader_html_incomplete(url, text):
                    pass
                else:
                    _direct_domains.add(domain)
                    return text
    except Exception:
        pass

    slack = _get_html_scrapling_http(url, tsec)
    if slack and not _fanqie_reader_html_incomplete(url, slack):
        return slack

    try:
        browser = _get_browser()
        if browser:
            browser.get(url)
            html = browser.html
            if html and len(html) > 500 and not _fanqie_reader_html_incomplete(url, html):
                _browser_domains.add(domain)
                return html
    except Exception:
        pass

    try:
        browser = _get_browser_proxy()
        if browser:
            browser.get(url)
            html = browser.html
            if html and len(html) > 500 and not _fanqie_reader_html_incomplete(url, html):
                _proxy_domains.add(domain)
                return html
    except Exception as e:
        print(f"[scraper] 所有方式均失败 {url}: {e}")

    return ""


def _detect_encoding(resp: requests.Response) -> str:
    if resp.apparent_encoding:
        enc = resp.apparent_encoding.lower().replace("-", "")
        for e in ENCODINGS:
            if e.replace("-", "") == enc:
                return e
    for e in ENCODINGS:
        try:
            resp.content.decode(e)
            return e
        except (UnicodeDecodeError, LookupError):
            continue
    return "utf-8"


def _strip_inline_ads_long_line(line: str) -> str:
    if len(line) < 120:
        return line
    s = line
    s = re.sub(r"https?://\S+", "", s)
    s = re.sub(
        r"www\.[a-zA-Z0-9.-]+\.(?:com|cn|net|org|cc)\b\S*",
        "",
        s,
        flags=re.IGNORECASE,
    )
    s = re.sub(r"天才一秒记住[^\n。]{0,120}[。]?", "", s)
    s = re.sub(r"[,，]?为防止[/／]百[/／]度[/／]转[/／]码[/／][^。\n]{0,200}", "", s)
    return re.sub(r"\s{2,}", " ", s).strip()


def _clean_text(text: str) -> str:
    ad_patterns = [
        r"天才一秒记住.*?地址",
        r"最新章节！?全文阅读",
        r"手机阅读.*?$",
        r"一秒记住.*?$",
        r"笔趣阁.*?$",
        r"新笔趣阁.*?$",
        r"www\..*?\.(com|org|net)",
        r"https?://\S+",
        r"请记住本书首发域名.*?$",
        r"最新网址[：:].*?$",
        r"手机阅读网址[：:].*?$",
        r"^上一章$",
        r"^下一章$",
        r"^返回目录$",
        r"^加入书签$",
        r"^目录$",
        r"^章节列表$",
        r"^正文$",
        r"^推荐票.*$",
        r"^打赏.*$",
        r"^月票.*$",
        r"^投推荐票.*$",
        r"^加入书签$",
        r"^本章未完.*$",
        r"^本章已完成.*$",
        r"^章节错误.*$",
        r"^点此举报.*$",
        r"^【.*?】.*?$",
        r"^（本章未完.*$",
        r"^温馨提示.*$",
        r"^喜欢.*?请推荐.*$",
        r"^.*?最新章节.*$",
        r"^.*?全文阅读.*$",
        r"^有声小说.*$",
        r"^请退出浏览器阅读模式.*$",
        r"^本章已完成.*$",
        r"^\s*$",
        r"^[　\s]+$",
    ]

    lines = text.split("\n")
    cleaned = []
    prev_empty = False

    for line in lines:
        line = line.strip()
        if len(line) > 120:
            line = _strip_inline_ads_long_line(line).strip()

        if not line:
            if not prev_empty:
                cleaned.append("")
                prev_empty = True
            continue

        skip = False
        for pat in ad_patterns:
            if re.search(pat, line, re.IGNORECASE):
                skip = True
                break
        if skip:
            continue

        if re.match(r'^[^\u4e00-\u9fff\w]{1,5}$', line):
            continue

        cleaned.append("　　" + line)
        prev_empty = False

    while cleaned and cleaned[0] == "":
        cleaned.pop(0)
    while cleaned and cleaned[-1] == "":
        cleaned.pop()

    return "\n".join(cleaned)


# ── 章节列表解析 ───────────────────────────────────────

CHAPTER_SELECTORS = [
    ".chapter-list li a",
    "#list-chapterAll a",
    ".list-chapter a",
    "#list dl dd a",
    "#list a",
    ".listmain a",
    ".book-list a",
    "div.centent ul li a",
    "dl dd a",
]

CONTENT_SELECTORS = [
    ".chapter-detail-article",
    "#content",
    ".entry-text",
    "#BookText",
    ".chapter-content",
    ".content",
    ".read-content",
    "#chaptercontent",
    "div.content",
    "article",
    "#htmlContent",
    ".articlecontent",
    ".text-content",
    ".chapter_txt",
    "#chapterContent",
    ".booktext",
    "#booktext",
    "#bookcontent",
    ".book_content",
    "#txt",
    "div.txt",
]

AD_CHILD_PATTERN = re.compile(
    r"(天才一秒记住|笔趣阁|新笔趣阁|手机阅读|最新章节|全文阅读|"
    r"推荐票|月票|打赏|返回目录|加入书签|上一章|下一章|"
    r"本章未完|本章已完成|章节错误|www\.|https?://|"
    r"有声小说)",
    re.IGNORECASE,
)

# 网文章节绝大多数短于该阈值；超长多为误合并分页/侧栏整块正文，触发「仅用首页」重试
MAX_CHAPTER_BODY_CHARS = 15000

READER_TITLE_SELECTORS = (
    "#title",
    ".chapter-title",
    "#chapter_title",
    "#chapterTitle",
    "h2.title",
    ".bookname h1",
    ".bookname",
    ".reader_title",
    ".content_title",
    ".novel_title",
    "div.title",
)


def _normalize_chapter_heading_for_compare(title: str) -> str:
    """去空白后比对：同章多页的题目应一致，不一致则不应合并正文。"""
    if not title or not title.strip():
        return ""
    return re.sub(r"\s+", "", title.strip())


def _strip_site_noise_from_heading(t: str) -> str:
    """阅读页常见于「章名 - 书名 - 网站名」，取第一段作章标题。"""
    x = (t or "").strip()
    if not x:
        return ""
    parts = re.split(r"\s*[|｜_/\\‐－—:：]\s*", x)
    if parts:
        first = parts[0].strip()
        if len(first) >= 2:
            return first
    return x


def _extract_reader_chapter_title(soup: BeautifulSoup) -> str:
    """
    从阅读页抓取当前章标题（尽量与分页下一页同属一章时一致）。
    若站点无单独标题节点则返回空字符串，分页合并时不做题目拦截。
    """
    for sel in READER_TITLE_SELECTORS:
        el = soup.select_one(sel)
        if el:
            raw = el.get_text(strip=True)
            cand = _strip_site_noise_from_heading(raw)
            if 2 <= len(cand) < 260:
                return cand
    h1 = soup.find("h1")
    if h1:
        cand = _strip_site_noise_from_heading(h1.get_text(strip=True))
        if len(cand) >= 2:
            return cand
    tt = soup.find("title")
    if tt:
        cand = _strip_site_noise_from_heading(tt.get_text(strip=True))
        if len(cand) >= 2:
            return cand
    return ""


def _headings_conflict_for_merge(base_title: str, page_title: str) -> bool:
    a = _normalize_chapter_heading_for_compare(base_title)
    b = _normalize_chapter_heading_for_compare(page_title)
    if not a or not b:
        return False
    return a != b


def _first_page_body_only(url: str) -> str:
    """不跟分页链接，仅用当前章节 URL 单页正文（用于超限重试）。"""
    html = _get_html(url)
    if not html:
        return ""
    soup = BeautifulSoup(html, "lxml")
    return _extract_content_from_soup(soup)


def _is_fanqie_novel_domain(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return "fanqienovel.com" in host


def _is_qimao_domain(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return "qimao.com" in host


def _qimao_book_id_from_url(url: str) -> Optional[str]:
    """书库 / 阅读页：/shuku/{book_id}/ 或 /shuku/{book_id}-{chapter_id}/（允许末尾查询串）。"""
    path = urlparse(url).path or ""
    m = re.search(r"/shuku/(\d+)(?:-\d+)?", path)
    return m.group(1) if m else None


def _is_qimao_chapter_url(url: str) -> bool:
    """阅读页 /shuku/{book}-{chapter}/，勿将「下一章」链当作正文分页。"""
    if not _is_qimao_domain(url):
        return False
    return bool(re.search(r"/shuku/\d+-\d+", urlparse(url).path or ""))


def _fetch_qimao_book_via_api(book_id: str) -> dict:
    """
    七猫 PC 站目录由前端 API 拉取，首屏 HTML 不含章节链接。
    """
    base = "https://www.qimao.com"
    referer = f"{base}/shuku/{book_id}/"
    headers = {**HEADERS, "Referer": referer}
    title, author = "", ""
    chapters: list[dict] = []

    try:
        r = requests.get(
            f"{base}/api/book-detail/main-info",
            params={"book_id": book_id},
            headers=headers,
            timeout=20,
        )
        r.raise_for_status()
        payload = r.json()
        detail = (payload.get("data") or {}).get("book_detail") or {}
        title = str(detail.get("title") or "").strip()
        author = str(detail.get("author") or "").strip()
    except Exception as e:
        print(f"[scraper] 七猫书籍信息 API 失败: {e}")

    try:
        r2 = requests.get(
            f"{base}/api/book/chapter-list",
            params={"book_id": book_id},
            headers=headers,
            timeout=45,
        )
        r2.raise_for_status()
        data = r2.json()
        raw_list = (data.get("data") or {}).get("chapters") or []
        for ch in raw_list:
            if not isinstance(ch, dict):
                continue
            cid = str(ch.get("id") or "").strip()
            ctitle = str(ch.get("title") or "").strip()
            if not cid or not ctitle:
                continue
            chapters.append({
                "title": ctitle,
                "url": f"{base}/shuku/{book_id}-{cid}/",
                "chapter_index": len(chapters),
            })
    except Exception as e:
        print(f"[scraper] 七猫章节目录 API 失败: {e}")

    return {"title": title, "author": author, "chapters": chapters}


def _is_fanqie_reader_url(url: str) -> bool:
    p = urlparse(url)
    if "fanqienovel.com" not in p.netloc.lower():
        return False
    return "/reader/" in (p.path or "")


def _fanqie_reader_html_incomplete(url: str, html: str) -> bool:
    """
    番茄阅读页正文在 __INITIAL_STATE__.chapters；直连常被重定向到验证码壳页面，
    无 state 时无法解密，表现为乱码或空正文。此时应视为抓取失败并走 Scrapling/ 浏览器。
    """
    if not _is_fanqie_reader_url(url):
        return False
    if not html:
        return True
    return ("window.__INITIAL_STATE__" not in html) and ("__INITIAL_STATE__" not in html)


def _parse_fanqie_author(html: str) -> str:
    """番茄作品页 JSON-LD / 页面里的 author Person。"""
    m = re.search(
        r'"author"\s*:\s*\[\s*\{\s*"@type"\s*:\s*"Person"\s*,\s*"name"\s*:\s*"([^"]+)"',
        html,
    )
    if m:
        return m.group(1).strip()
    m2 = re.search(r'"authorName"\s*:\s*"([^"]+)"', html)
    if m2:
        return m2.group(1).strip()
    return ""


def _parse_fanqie_chapters(soup: BeautifulSoup, page_url: str) -> list[dict]:
    """
    番茄小说作品页：章节为 a[href^='/reader/'] 或含 /reader/数字。
    列表在服务端 HTML 中，无需执行 JS。
    """
    chapters: list[dict] = []
    seen: set[str] = set()
    for a in soup.select('a[href*="/reader/"]'):
        href = (a.get("href") or "").strip()
        if not href or href.startswith("javascript"):
            continue
        if not re.search(r"/reader/\d+", href):
            continue
        full = urljoin(page_url, href)
        # 按路径去重（忽略 query）
        path_only = urlparse(full)._replace(query="", fragment="").geturl()
        if path_only in seen:
            continue
        title = a.get_text(strip=True)
        if not title:
            continue
        if "最近更新" in title:
            continue
        seen.add(path_only)
        chapters.append({
            "title": title,
            "url": path_only,
            "chapter_index": len(chapters),
        })
    return chapters


def parse_book_info(url: str) -> dict:
    """
    解析书籍首页，返回:
    {'title': str, 'author': str, 'chapters': [{'title': str, 'url': str, 'chapter_index': int}, ...]}
    """
    if _is_qimao_domain(url):
        book_id = _qimao_book_id_from_url(url)
        if book_id:
            api_info = _fetch_qimao_book_via_api(book_id)
            if api_info.get("chapters"):
                return {
                    "title": api_info.get("title") or "",
                    "author": api_info.get("author") or "",
                    "chapters": api_info["chapters"],
                }

    html = _get_html(url)
    if not html:
        return {"title": "", "author": "", "chapters": []}

    soup = BeautifulSoup(html, "lxml")

    title = ""
    for sel in ["#info h1", "h1", ".bookname h1", ".book-title", "#bookinfo h1"]:
        el = soup.select_one(sel)
        if el and el.get_text(strip=True):
            title = el.get_text(strip=True)
            break
    if not title:
        title_tag = soup.find("title")
        if title_tag:
            title = title_tag.get_text(strip=True).split("-")[0].strip()

    author = ""
    for sel in ["#info p", ".author", "#bookinfo .author"]:
        el = soup.select_one(sel)
        if el:
            text = el.get_text()
            m = re.search(r"作\s*者[：:]\s*(.+)", text)
            if m:
                author = m.group(1).strip()
                break
    if not author:
        m = re.search(r"作\s*者[：:]\s*([^\s,，。]+)", soup.get_text())
        if m:
            author = m.group(1).strip()

    if not author and _is_fanqie_novel_domain(url):
        author = _parse_fanqie_author(html)

    chapters = []
    if _is_fanqie_novel_domain(url):
        chapters = _parse_fanqie_chapters(soup, url)

    if not chapters:
        for sel in CHAPTER_SELECTORS:
            links = soup.select(sel)
            if len(links) > 5:
                best_links = links
                dl = links[0].find_parent("dl")
                if dl:
                    dts = dl.find_all("dt")
                    for dt in dts:
                        dt_text = dt.get_text(strip=True)
                        if "正文" in dt_text or "目录" in dt_text:
                            dd_links = []
                            for sib in dt.find_next_siblings():
                                if sib.name == "dt":
                                    break
                                if sib.name == "dd":
                                    a = sib.find("a")
                                    if a:
                                        dd_links.append(a)
                            if len(dd_links) > 5:
                                best_links = dd_links
                                break

                seen_urls: set[str] = set()
                for a in best_links:
                    href = a.get("href", "")
                    if not href or href.startswith("javascript"):
                        continue
                    full_url = urljoin(url, href)
                    if full_url in seen_urls:
                        continue
                    seen_urls.add(full_url)
                    chapters.append({
                        "title": a.get_text(strip=True),
                        "url": full_url,
                        "chapter_index": len(chapters),
                    })
                break

    return {"title": title, "author": author, "chapters": chapters}


def _extract_content_from_soup(soup: BeautifulSoup) -> str:
    for tag in soup.find_all(["script", "style", "ins", "iframe", "noscript", "svg"]):
        tag.decompose()

    for sel in CONTENT_SELECTORS:
        el = soup.select_one(sel)
        if el and len(el.get_text(strip=True)) > 30:
            for child in el.find_all(["div", "span", "p", "center"]):
                child_text = child.get_text(strip=True)
                if AD_CHILD_PATTERN.search(child_text) and len(child_text) < 200:
                    child.decompose()
            return el.get_text("\n", strip=True)

    divs = soup.find_all("div")
    best = ""
    for d in divs:
        text = d.get_text(strip=True)
        if len(text) > len(best) and len(text) > 200:
            best = text
    return best


def _find_next_page_url(soup: BeautifulSoup, current_url: str) -> Optional[str]:
    """
    只跟随**同章分页**（下一页 / 下页），不得匹配「下一章」等目录翻章链接。

    原先用 `"下一" in text` 会误伤：「下一章」含「下一」，导致把相邻章节全文拼进当前章，
    笔趣阁类模板站点（含 xhytd.com）常因此出现「一章几万字」。
    """
    best: Optional[str] = None
    best_rank = 99
    for a in soup.find_all("a", href=True):
        raw_text = a.get_text(strip=True) or ""
        text = raw_text.replace(" ", "").replace("　", "")
        href = (a.get("href") or "").strip()
        if not href or href.startswith("javascript"):
            continue
        if re.search(r"下一章|上一章|下\s*一章|上\s*一章", text):
            continue
        if "下一节" in text or "上一节" in text:
            continue
        full = urljoin(current_url, href)
        if full == current_url:
            continue
        rank: Optional[int] = None
        if "下一页" in text or "下一頁" in text:
            rank = 0
        elif "下页" in text:
            rank = 1
        if rank is None:
            continue
        if rank < best_rank:
            best_rank = rank
            best = full
            if rank == 0:
                break
    return best


def parse_chapter_content(url: str) -> str:
    """
    解析单章正文：同章多页仅合并「下一页」分页；若后续页章节标题与首页不一致则停止合并（防串章）。
    合并结果超过约 1.5 万字时，会再仅拉当前 URL 单页（关分页）做一次「重拉」以排除误合并；
    若单页仍超长则保留偏长结果（极少数真·长章或侧栏污染）。
    """
    html = _get_html(url)
    if not html:
        return ""

    # 番茄阅读页：正文在 __INITIAL_STATE__ 中且为 PUA + 自定义字体，需 woff2 解密
    if _is_fanqie_reader_url(url):
        try:
            from . import fanqie_decrypt

            plain = fanqie_decrypt.decrypt_reader_page_html(html)
            if plain.strip():
                return _clean_text(plain)
        except Exception as e:
            print(f"[scraper] 番茄正文解密失败: {e}")

    soup = BeautifulSoup(html, "lxml")
    base_title = _extract_reader_chapter_title(soup)
    next_url = _find_next_page_url(soup, url)
    content = _extract_content_from_soup(soup)
    all_contents: list[str] = [content] if content else []

    if _is_qimao_chapter_url(url):
        merged = "\n".join(c for c in all_contents if c)
        return _clean_text(merged)

    visited: set[str] = {url}
    while next_url and next_url not in visited:
        visited.add(next_url)
        try:
            page_html = _get_html(next_url)
            if not page_html:
                break
            page_soup = BeautifulSoup(page_html, "lxml")
            page_title = _extract_reader_chapter_title(page_soup)
            if _headings_conflict_for_merge(base_title, page_title):
                break
            page_content = _extract_content_from_soup(page_soup)
            if page_content:
                all_contents.append(page_content)
            next_url = _find_next_page_url(page_soup, next_url)
        except Exception:
            break

    merged = "\n".join(c for c in all_contents if c)
    out = _clean_text(merged)
    if len(out) <= MAX_CHAPTER_BODY_CHARS:
        return out
    retry = _clean_text(_first_page_body_only(url))
    if not retry:
        return out
    if len(retry) <= MAX_CHAPTER_BODY_CHARS:
        return retry
    if len(retry) < len(out):
        return retry
    return out


def scrape_chapters_batch(
    chapters: list[dict],
    on_progress: Optional[Callable[[int, int, str], None]] = None,
    max_workers: int = 6,
) -> None:
    """
    批量下载章节内容（原地修改 chapters 列表中的 content 字段）
    on_progress(done, total, chapter_title)
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    total = len(chapters)
    if total == 0:
        return

    first_domain = urlparse(chapters[0]["url"]).netloc if chapters else ""
    use_browser = first_domain in _browser_domains
    workers = 1 if use_browser else max_workers

    def _dl(idx_ch: tuple[int, dict]) -> tuple[int, str]:
        idx, ch = idx_ch
        try:
            content = parse_chapter_content(ch["url"])
            ch["content"] = content
        except Exception as e:
            ch["content"] = f"[爬取失败: {e}]"
        return idx, ch.get("title", "")

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(_dl, (i, ch)) for i, ch in enumerate(chapters)]
        done = 0
        for f in as_completed(futures):
            done += 1
            _, title = f.result()
            if on_progress:
                on_progress(done, total, title)
