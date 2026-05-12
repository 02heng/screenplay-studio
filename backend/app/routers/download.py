"""
小说下载路由
提供小说下载、状态查询、书架管理等 API
"""
from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from fastapi import APIRouter, HTTPException
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


def _enqueue_download(
    url: str,
    chapter_ids: Optional[list[int]] = None,
    *,
    catalog_only: bool = False,
) -> TaskStatus:
    """创建并启动后台任务。catalog_only 时仅解析目录入库；否则抓取正文。"""
    task_id = str(uuid.uuid4())
    td: dict = {
        "task_id": task_id,
        "url": url,
        "status": "pending",
        "message": "任务已提交，等待处理...",
        "progress": 0,
        "total_chapters": 0,
        "downloaded_chapters": 0,
        "batch_total": 0,
        "batch_done": 0,
        "book_id": None,
        "book_title": "",
    }
    if chapter_ids is not None:
        td["chapter_ids"] = chapter_ids
    if catalog_only:
        td["catalog_only"] = True
    _tasks[task_id] = td
    _executor.submit(_run_download_task, task_id, url)
    t = _tasks[task_id]
    return TaskStatus(
        task_id=task_id,
        status=t["status"],
        message=t["message"],
        progress=t["progress"],
        total_chapters=t["total_chapters"],
        downloaded_chapters=t["downloaded_chapters"],
        batch_total=t.get("batch_total") or 0,
        batch_done=t.get("batch_done") or 0,
        book_id=t.get("book_id"),
        book_title=t["book_title"],
    )


# ── Pydantic 模型 ──────────────────────────────────────────────────

class DownloadRequest(BaseModel):
    url: str
    # True：只解析书名与章节列表并入库，不写章节正文。
    catalog_only: bool = False


class ChapterIdsDownload(BaseModel):
    chapter_ids: list[int]


class TaskStatus(BaseModel):
    task_id: str
    status: str           # pending | parsing | downloading | done | error
    message: str = ""
    progress: int = 0     # 0-100
    total_chapters: int = 0
    downloaded_chapters: int = 0
    # 「下载所选」时为本批章节数及已完成数；为 0 表示按全书进度展示（下载全部未抓取等）
    batch_total: int = 0
    batch_done: int = 0
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

        # Step 2: 载入章节列表与进度
        chapters = db.get_chapters(book_id, include_content=False)
        total = len(chapters)
        already_done = sum(
            1
            for c in chapters
            if c.get("downloaded") and not db.is_volume_toc_row(c.get("title", ""))
        )
        body_eligible_total = sum(
            1 for c in chapters if not db.is_volume_toc_row(c.get("title", ""))
        )

        task["total_chapters"] = total
        task["downloaded_chapters"] = already_done
        task["progress"] = (
            int(already_done / body_eligible_total * 100)
            if body_eligible_total
            else (100 if task.get("catalog_only") else 0)
        )

        if task.get("catalog_only"):
            task["status"] = "done"
            if total > 0:
                task["message"] = (
                    f"《{task['book_title']}》目录就绪（共 {total} 章），请勾选正文后下载"
                )
            else:
                task["message"] = (
                    f"《{task['book_title']}》已解析但未发现章节条目，请确认是否为书籍目录页链接"
                )
            return

        pending_all = [
            c
            for c in chapters
            if not c.get("downloaded")
            and not db.is_volume_toc_row(c.get("title", ""))
        ]
        raw_ids = task.get("chapter_ids")
        if raw_ids:
            cid_set = {int(x) for x in raw_ids}
            pending = [c for c in pending_all if c["id"] in cid_set]
        else:
            pending = pending_all

        if not pending:
            task["status"] = "done"
            task["progress"] = 100
            task["downloaded_chapters"] = already_done
            if raw_ids:
                task["message"] = (
                    f"《{task['book_title']}》所选条目无需抓取（均已含正文或未选中未下载）；全书 {total} 章"
                )
            else:
                task["message"] = f"《{task['book_title']}》已全部下载完成（共 {total} 章）"
            return

        batch_n = len(pending)

        from urllib.parse import urlparse

        first_domain = urlparse(pending[0]["url"]).netloc if pending else ""
        use_browser = first_domain in scraper._browser_domains

        task["status"] = "downloading"
        if raw_ids:
            task["batch_total"] = batch_n
            task["batch_done"] = 0
            task["progress"] = 0 if batch_n else 100
        else:
            task["batch_total"] = 0
            task["batch_done"] = 0

        slow_hint = (
            "（当前站点需浏览器渲染，单章可能需数十秒，请耐心等待）"
            if use_browser
            else ""
        )
        task["message"] = (
            f"正在抓取 {batch_n} 章（{'所选章节' if raw_ids else '全部未下载'}）{slow_hint}…"
        )

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
                in_batch = done_count[0] - already_done
                if raw_ids and batch_n > 0:
                    task["batch_done"] = in_batch
                    task["progress"] = int(in_batch / batch_n * 100)
                else:
                    task["progress"] = (
                        int(done_count[0] / body_eligible_total * 100)
                        if body_eligible_total
                        else 100
                    )
                task["message"] = f"本批进度 {in_batch}/{batch_n}：{title}"

        task["status"] = "done"
        task["progress"] = 100
        if raw_ids and batch_n > 0:
            task["batch_done"] = batch_n
        if raw_ids:
            task["message"] = f"《{task['book_title']}》本批所选已抓取完毕（全书 {total} 章）"
        else:
            task["message"] = f"《{task['book_title']}》下载完成（共 {total} 章）"

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
            batch_total=inflight.get("batch_total") or 0,
            batch_done=inflight.get("batch_done") or 0,
            book_id=inflight.get("book_id"),
            book_title=inflight.get("book_title", ""),
        )

    return _enqueue_download(url, catalog_only=payload.catalog_only)


@router.post("/novel/{novel_id}/download-chapters", response_model=TaskStatus, status_code=202)
def download_chapters_selection(novel_id: int, payload: ChapterIdsDownload) -> TaskStatus:
    """仅下载勾选范围内的、且当前仍为「未抓取正文」的章节。"""
    raw = payload.chapter_ids or []
    if not raw:
        raise HTTPException(status_code=400, detail="请至少选择一章后再下载")

    seen: set[int] = set()
    chapter_ids: list[int] = []
    for x in raw:
        try:
            cid = int(x)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="chapter_ids 须为整数 id")
        if cid not in seen:
            seen.add(cid)
            chapter_ids.append(cid)

    book = db.get_book_by_id(novel_id)
    if not book:
        raise HTTPException(status_code=404, detail="小说不存在")
    url = (book.get("url") or "").strip()
    if not url.startswith("http"):
        raise HTTPException(status_code=400, detail="该书缺少有效目录链接")

    rows = db.get_chapters(novel_id, include_content=False)
    valid_ids = {int(r["id"]) for r in rows}
    bad = [cid for cid in chapter_ids if cid not in valid_ids]
    if bad:
        raise HTTPException(
            status_code=400,
            detail=f"chapter_ids 含无效 id（非本书章节）：{bad[:8]}…" if len(bad) > 8 else "chapter_ids 含无效 id（非本书章节）",
        )

    inflight_existing = _inflight_task_for_url(url)
    if inflight_existing:
        tid = inflight_existing["task_id"]
        return TaskStatus(
            task_id=tid,
            status=inflight_existing["status"],
            message=inflight_existing.get("message", ""),
            progress=inflight_existing.get("progress", 0),
            total_chapters=inflight_existing.get("total_chapters", 0),
            downloaded_chapters=inflight_existing.get("downloaded_chapters", 0),
            batch_total=inflight_existing.get("batch_total") or 0,
            batch_done=inflight_existing.get("batch_done") or 0,
            book_id=inflight_existing.get("book_id"),
            book_title=inflight_existing.get("book_title", ""),
        )

    return _enqueue_download(url, chapter_ids=chapter_ids)


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
        batch_total=t.get("batch_total") or 0,
        batch_done=t.get("batch_done") or 0,
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
    for row in chapters:
        row["is_volume_header"] = db.is_volume_toc_row(row.get("title"))
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
