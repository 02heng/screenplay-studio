"""小说下载器模块 - 适配自阅读下载器，集成到剧本创作平台"""
from .database import init_db, add_book, get_all_books, get_book_by_url, delete_book
from .database import add_chapters, get_chapters, get_chapter, update_chapter_content
from .database import get_book_chapter_count, get_book_content_char_count
from .scraper import parse_book_info, parse_chapter_content, close_browser

__all__ = [
    "init_db",
    "add_book",
    "get_all_books",
    "get_book_by_url",
    "delete_book",
    "add_chapters",
    "get_chapters",
    "get_chapter",
    "update_chapter_content",
    "get_book_chapter_count",
    "get_book_content_char_count",
    "parse_book_info",
    "parse_chapter_content",
    "close_browser",
]
