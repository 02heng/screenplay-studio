"""
小说下载路由
提供小说下载、状态查询、书架管理等 API
"""
from __future__ import annotations

import asyncio
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from app.downloader import database as db
from app.downloader import scraper

router = APIRouter(prefix="/api/download", tags=["download"])

# ── 任务管理（内存级，进程重启后清空）──────────────────────────────

_tasks: dict[str, dict] = {}
_executor = ThreadPoolExecutor(max_workers=3)


def _get_task(task_id: str) -> dict:
    task = _tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return task


def _inflight_task_for_url(url: str) -> Optional[dict]:
    for t in _tasks.values():
        if t.get("url") == url and t.get("status") in ("pending", "parsing", "downloading"):
            return t
    return None


def _enqueue_download(url: str) -> TaskStatus:
    """创建并启动下载任务（调用方需已确认无同 URL 进行中任务）。"""
    task_id = str(uuid.uuid4())
    _tasks[task_id] = {
        "task_id": task_id,
        "url": url,
        "status": "pending",
        "message": "任务已提交，等待处理...",
        "progress": 0,
        "total_chapters": 0,
        "downloaded_chapters": 0,
        "book_id": None,
        "book_title": "",
    }
    _executor.submit(_run_download_task, task_id, url)
    t = _tasks[task_id]
    return TaskStatus(
        task_id=task_id,
        status=t["status"],
        message=t["message"],
        progress=t["progress"],
        total_chapters=t["total_chapters"],
        downloaded_chapters=t["downloaded_chapters"],
        book_id=t.get("book_id"),
        book_title=t["book_title"],
    )


# ── Pydantic 模型 ──────────────────────────────────────────────────

class DownloadRequest(BaseModel):
    url: str


class TaskStatus(BaseModel):
    task_id: str
    status: str           # pending | parsing | downloading | done | error
    message: str = ""
    progress: int = 0     # 0-100
    total_chapters: int = 0
    downloaded_chapters: int = 0
    book_id: Optional[int] = None
    book_title: str = ""


# ── 工具函数 ───────────────────────────────────────────────────────

def _run_download_task(task_id: str, url: str) -> None:
    """后台线程：解析书籍信息 → 入库 → 逐章下载"""
    task = _tasks[task_id]

    try:
        # Step 1: 解析书籍基本信息
        task["status"] = "parsing"
        task["message"] = "正在解析书籍信息..."

        existing = db.get_book_by_url(url)
        if existing:
            book_id = existing["id"]
            task["book_id"] = book_id
            task["book_title"] = existing["title"]
        else:
            info = scraper.parse_book_info(url)
            if not info["title"]:
                task["status"] = "error"
                task["message"] = "无法解析书名，请检查链接是否正确"
                return

            book_id = db.add_book(info["title"], info["author"], url)
            task["book_id"] = book_id
            task["book_title"] = info["title"]

            if info["chapters"]:
                db.add_chapters(book_id, info["chapters"])

        # Step 2: 获取章节列表
        chapters = db.get_chapters(book_id, include_content=False)
        pending = [c for c in chapters if not c.get("downloaded")]
        total = len(chapters)
        already_done = total - len(pending)

        task["total_chapters"] = total
        task["downloaded_chapters"] = already_done
        task["progress"] = int(already_done / total * 100) if total else 0

        if not pending:
            task["status"] = "done"
            task["message"] = f"《{task['book_title']}》已全部下载完成（共 {total} 章）"
            return

        # Step 3: 下载章节内容
        task["status"] = "downloading"
        task["message"] = f"正在下载，共 {len(pending)} 章待下载..."

        # 判断是否需要浏览器（串行）
        from urllib.parse import urlparse
        first_domain = urlparse(pending[0]["url"]).netloc if pending else ""
        use_browser = first_domain in scraper._browser_domains
        max_workers_dl = 1 if use_browser else 6

        from concurrent.futures import ThreadPoolExecutor as DLPool, as_completed

        done_count = [already_done]

        def _dl_one(ch: dict) -> tuple[int, str]:
            try:
                content = scraper.parse_chapter_content(ch["url"])
                db.update_chapter_content(ch["id"], content)
            except Exception as e:
                db.update_chapter_content(ch["id"], f"[下载失败: {e}]")
            return ch["id"], ch.get("title", "")

        with DLPool(max_workers=max_workers_dl) as pool:
            futures = [pool.submit(_dl_one, ch) for ch in pending]
            for f in as_completed(futures):
                _, title = f.result()
                done_count[0] += 1
                task["downloaded_chapters"] = done_count[0]
                task["progress"] = int(done_count[0] / total * 100) if total else 100
                task["message"] = f"已下载 {done_count[0]}/{total}：{title}"

        task["status"] = "done"
        task["message"] = f"《{task['book_title']}》下载完成（共 {total} 章）"
        task["progress"] = 100

    except Exception as e:
        task["status"] = "error"
        task["message"] = f"下载失败：{e}"


# ── API 端点 ───────────────────────────────────────────────────────

@router.post("/novel", response_model=TaskStatus, status_code=202)
def start_download(payload: DownloadRequest) -> TaskStatus:
    """提交小说下载任务"""
    url = payload.url.strip()
    if not url.startswith("http"):
        raise HTTPException(status_code=400, detail="请提供有效的 HTTP/HTTPS 链接")

    inflight = _inflight_task_for_url(url)
    if inflight:
        tid = inflight["task_id"]
        return TaskStatus(
            task_id=tid,
            status=inflight["status"],
            message=inflight.get("message", ""),
            progress=inflight.get("progress", 0),
            total_chapters=inflight.get("total_chapters", 0),
            downloaded_chapters=inflight.get("downloaded_chapters", 0),
            book_id=inflight.get("book_id"),
            book_title=inflight.get("book_title", ""),
        )

    return _enqueue_download(url)


@router.post("/novel/{novel_id}/refetch-bodies", response_model=TaskStatus, status_code=202)
def refetch_all_chapter_bodies(novel_id: int) -> TaskStatus:
    """
    清空已存章节正文并重新按章节 URL 下载（用于修复番茄解密失败导致的 PUA 方块乱码）。
    若同书链接已有进行中的下载任务，返回 409。
    """
    book = db.get_book_by_id(novel_id)
    if not book:
        raise HTTPException(status_code=404, detail="小说不存在")
    url = (book.get("url") or "").strip()
    if not url.startswith("http"):
        raise HTTPException(status_code=400, detail="该书缺少有效来源链接")

    if _inflight_task_for_url(url):
        raise HTTPException(
            status_code=409,
            detail="该书已有进行中的下载任务，请等待结束后再重新抓取正文",
        )

    db.reset_all_chapter_contents(novel_id)
    return _enqueue_download(url)


@router.get("/status/{task_id}", response_model=TaskStatus)
def get_task_status(task_id: str) -> TaskStatus:
    """查询下载任务状态"""
    t = _get_task(task_id)
    return TaskStatus(
        task_id=task_id,
        status=t["status"],
        message=t.get("message", ""),
        progress=t.get("progress", 0),
        total_chapters=t.get("total_chapters", 0),
        downloaded_chapters=t.get("downloaded_chapters", 0),
        book_id=t.get("book_id"),
        book_title=t.get("book_title", ""),
    )


@router.get("/novels")
def list_novels():
    """获取已下载小说列表（含章节统计）"""
    books = db.get_all_books()
    result = []
    for b in books:
        total, downloaded = db.get_book_chapter_count(b["id"])
        char_count = db.get_book_content_char_count(b["id"])
        result.append({
            **b,
            "total_chapters": total,
            "downloaded_chapters": downloaded,
            "char_count": char_count,
            "download_pct": round(downloaded / total * 100, 1) if total else 0,
        })
    return {"novels": result}


@router.get("/novel/{novel_id}/chapters")
def list_chapters(novel_id: int):
    """获取小说章节列表（不含正文内容，仅返回元数据）"""
    book = db.get_book_by_id(novel_id)
    if not book:
        raise HTTPException(status_code=404, detail="小说不存在")
    chapters = db.get_chapters(novel_id, include_content=False)
    return {"novel": book, "chapters": chapters}


@router.get("/novel/{novel_id}/chapter/{chapter_id}/content")
def get_chapter_content(novel_id: int, chapter_id: int):
    """获取单章正文内容"""
    chapter = db.get_chapter(chapter_id)
    if not chapter or chapter["book_id"] != novel_id:
        raise HTTPException(status_code=404, detail="章节不存在")
    return {
        "id": chapter["id"],
        "title": chapter["title"],
        "content": chapter.get("content", ""),
        "downloaded": bool(chapter.get("downloaded")),
    }


@router.delete("/novel/{novel_id}", status_code=204)
def delete_novel(novel_id: int):
    """删除小说及其所有章节"""
    book = db.get_book_by_id(novel_id)
    if not book:
        raise HTTPException(status_code=404, detail="小说不存在")
    db.delete_book(novel_id)
