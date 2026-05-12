/**
 * 小说下载标签页
 * 支持：URL下载（笔趣阁、天涯、番茄、七猫等）、进度追踪、书架管理、章节预览、选择用于改编
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, getBackendBase } from '../hooks/useBackend';

interface Novel {
  id: number;
  title: string;
  author: string;
  url: string;
  added_at: string;
  total_chapters: number;
  downloaded_chapters: number;
  char_count: number;
  download_pct: number;
}

interface Chapter {
  id: number;
  book_id: number;
  title: string;
  url: string;
  chapter_index: number;
  downloaded: number;
  /** 目录页「第N卷」占位行：不是正文小节，不参与字数与勾选下载 */
  is_volume_header?: boolean;
}

interface TaskStatus {
  task_id: string;
  status: 'pending' | 'parsing' | 'downloading' | 'done' | 'error';
  message: string;
  progress: number;
  total_chapters: number;
  downloaded_chapters: number;
  /** >0 时表示「下载所选」：进度条按本批计算 */
  batch_total?: number;
  batch_done?: number;
  book_id: number | null;
  book_title: string;
}

type DownloadToastState =
  | {
      variant: 'progress';
      message: string;
      progress: number;
      batchTotal: number;
      batchDone: number;
      downloadedChapters: number;
      totalChapters: number;
      bookTitle: string;
    }
  | { variant: 'success'; message: string }
  | { variant: 'error'; message: string };

export default function DownloadTab() {
  const [url, setUrl] = useState('');
  const [novels, setNovels] = useState<Novel[]>([]);
  const [activeNovel, setActiveNovel] = useState<Novel | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loadingNovels, setLoadingNovels] = useState(false);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [downloadToast, setDownloadToast] = useState<DownloadToastState | null>(null);
  const [error, setError] = useState('');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [selectedChapterIds, setSelectedChapterIds] = useState<Set<number>>(new Set());
  const [chapterRangeLo, setChapterRangeLo] = useState('');
  const [chapterRangeHi, setChapterRangeHi] = useState('');
  const pollingRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const dismissToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeNovelIdRef = useRef<number | null>(null);

  const [chapterPreview, setChapterPreview] = useState<{
    title: string;
    content: string;
  } | null>(null);
  const [chapterPreviewBusy, setChapterPreviewBusy] = useState(false);

  const closeChapterPreview = useCallback(() => {
    setChapterPreview(null);
    setChapterPreviewBusy(false);
  }, []);

  const loadChapterPreview = async (novelId: number, ch: Chapter) => {
    setChapterPreviewBusy(true);
    setChapterPreview(null);
    setError('');
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ title: string; content: string }>(
        base,
        `/api/download/novel/${novelId}/chapter/${ch.id}/content`
      );
      if (activeNovelIdRef.current !== novelId) return;
      setChapterPreview({
        title: data.title || ch.title,
        content: data.content ?? '',
      });
    } catch (e) {
      if (activeNovelIdRef.current === novelId) {
        setError('加载正文失败：' + String((e as Error).message));
      }
    } finally {
      if (activeNovelIdRef.current === novelId) {
        setChapterPreviewBusy(false);
      }
    }
  };

  // ── 加载书架 ────────────────────────────────────────────────────

  const loadNovels = useCallback(async (): Promise<Novel[]> => {
    setLoadingNovels(true);
    setError('');
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ novels: Novel[] }>(base, '/api/download/novels');
      setNovels(data.novels);
      return data.novels ?? [];
    } catch (e) {
      setError('加载书架失败：' + String((e as Error).message));
      return [];
    } finally {
      setLoadingNovels(false);
    }
  }, []);

  useEffect(() => {
    void loadNovels();
  }, [loadNovels]);

  // ── 加载章节 ────────────────────────────────────────────────────

  const loadChapters = useCallback(async (novelId: number) => {
    setLoadingChapters(true);
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ novel: Novel; chapters: Chapter[] }>(
        base,
        `/api/download/novel/${novelId}/chapters`
      );
      setChapters(data.chapters);
    } catch (e) {
      setError('加载章节失败：' + String((e as Error).message));
    } finally {
      setLoadingChapters(false);
    }
  }, []);

  useEffect(() => {
    activeNovelIdRef.current = activeNovel?.id ?? null;
  }, [activeNovel?.id]);

  /** 切换书籍时清空勾选与章节范围输入 */
  useEffect(() => {
    setSelectedChapterIds(new Set());
    setChapterRangeLo('');
    setChapterRangeHi('');
    closeChapterPreview();
  }, [activeNovel?.id, closeChapterPreview]);

  const handleSelectNovel = (novel: Novel) => {
    setActiveNovel(novel);
    void loadChapters(novel.id);
  };

  const syncToastFromTaskStatus = useCallback((status: TaskStatus) => {
    if (dismissToastTimerRef.current) {
      clearTimeout(dismissToastTimerRef.current);
      dismissToastTimerRef.current = null;
    }
    const terminal = status.status === 'done' || status.status === 'error';
    if (terminal) {
      setDownloadToast({
        variant: status.status === 'done' ? 'success' : 'error',
        message:
          status.message ||
          (status.status === 'done' ? '已完成' : '下载失败'),
      });
      dismissToastTimerRef.current = setTimeout(() => {
        setDownloadToast(null);
        dismissToastTimerRef.current = null;
      }, 2000);
      return;
    }
    setDownloadToast({
      variant: 'progress',
      message: status.message,
      progress: status.progress,
      batchTotal: status.batch_total ?? 0,
      batchDone: status.batch_done ?? 0,
      downloadedChapters: status.downloaded_chapters,
      totalChapters: status.total_chapters,
      bookTitle: status.book_title ?? '',
    });
  }, []);

  // ── 轮询任务状态 ───────────────────────────────────────────────

  type PollFocus = 'none' | 'openBookTab';

  const startPolling = useCallback(
    (taskId: string, focus?: PollFocus) => {
      if (pollingRef.current[taskId]) return;

      pollingRef.current[taskId] = setInterval(async () => {
        try {
          const base = await getBackendBase();
          const status = await apiFetch<TaskStatus>(base, `/api/download/status/${taskId}`);
          syncToastFromTaskStatus(status);

          if (status.status === 'done' || status.status === 'error') {
            clearInterval(pollingRef.current[taskId]);
            delete pollingRef.current[taskId];
            if (status.status === 'done' && status.book_id !== null) {
              const refreshed = await loadNovels();
              if (focus === 'openBookTab') {
                const found = refreshed.find((n) => n.id === status.book_id);
                if (found) {
                  setActiveNovel(found);
                  void loadChapters(status.book_id);
                }
              } else if (status.book_id === activeNovelIdRef.current) {
                void loadChapters(status.book_id);
              }
            }
          }
        } catch {
          clearInterval(pollingRef.current[taskId]);
          delete pollingRef.current[taskId];
        }
      }, 1500);
    },
    [loadChapters, loadNovels, syncToastFromTaskStatus]
  );

  useEffect(() => {
    return () => {
      if (dismissToastTimerRef.current) {
        clearTimeout(dismissToastTimerRef.current);
        dismissToastTimerRef.current = null;
      }
      Object.values(pollingRef.current).forEach(clearInterval);
    };
  }, []);

  // ── 提交下载 ───────────────────────────────────────────────────

  const handleSubmit = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    setError('');

    try {
      const base = await getBackendBase();
      const task = await apiFetch<TaskStatus>(base, '/api/download/novel', {
        method: 'POST',
        body: JSON.stringify({ url: trimmedUrl, catalog_only: true }),
      });
      syncToastFromTaskStatus(task);
      setUrl('');
      startPolling(task.task_id, 'openBookTab');
    } catch (e) {
      setError('提交失败：' + String((e as Error).message));
    }
  };

  const handleRefetchBodies = async () => {
    if (!activeNovel) return;
    setError('');
    try {
      const base = await getBackendBase();
      const task = await apiFetch<TaskStatus>(
        base,
        `/api/download/novel/${activeNovel.id}/refetch-bodies`,
        { method: 'POST' }
      );
      syncToastFromTaskStatus(task);
      startPolling(task.task_id);
    } catch (e) {
      setError('重新抓取失败：' + String((e as Error).message));
    }
  };

  const toggleChapterSelected = useCallback((ch: Chapter) => {
    if (ch.downloaded || ch.is_volume_header) return;
    setSelectedChapterIds((prev) => {
      const next = new Set(prev);
      if (next.has(ch.id)) next.delete(ch.id);
      else next.add(ch.id);
      return next;
    });
  }, []);

  const selectAllUndownloaded = () => {
    setSelectedChapterIds(
      new Set(
        chapters
          .filter((c) => !c.downloaded && !c.is_volume_header)
          .map((c) => c.id)
      )
    );
  };

  const clearChapterSelection = () => {
    setSelectedChapterIds(new Set());
  };

  const applyChapterIndexRange = () => {
    const lo = Number.parseInt(chapterRangeLo, 10);
    const hi = Number.parseInt(chapterRangeHi, 10);
    if (Number.isNaN(lo) || Number.isNaN(hi)) return;
    const a = Math.min(lo, hi);
    const b = Math.max(lo, hi);
    setSelectedChapterIds((prev) => {
      const next = new Set(prev);
      for (const c of chapters) {
        const n = c.chapter_index + 1;
        if (n >= a && n <= b && !c.downloaded && !c.is_volume_header) next.add(c.id);
      }
      return next;
    });
  };

  /** 勾选且仍未抓取正文的章节数（实际会发起下载的数量） */
  const selectedPendingCount = chapters.filter(
    (c) => selectedChapterIds.has(c.id) && !c.downloaded && !c.is_volume_header
  ).length;

  const handleDownloadSelectedChapters = async () => {
    if (!activeNovel) return;
    const ids = chapters.filter((c) => selectedChapterIds.has(c.id)).map((c) => c.id);
    const pendingIds = chapters
      .filter(
        (c) => selectedChapterIds.has(c.id) && !c.downloaded && !c.is_volume_header
      )
      .map((c) => c.id);
    if (!pendingIds.length) {
      setError('请至少勾选一章尚未抓取正文的条目（已全部下载的可不选）');
      return;
    }
    setError('');
    try {
      const base = await getBackendBase();
      const task = await apiFetch<TaskStatus>(
        base,
        `/api/download/novel/${activeNovel.id}/download-chapters`,
        { method: 'POST', body: JSON.stringify({ chapter_ids: ids }) }
      );
      syncToastFromTaskStatus(task);
      startPolling(task.task_id);
    } catch (e) {
      setError('下载提交失败：' + String((e as Error).message));
    }
  };

  /** 与首次「粘贴链接」相同：下载全书当前所有未抓取章节 */
  const handleDownloadAllPending = async () => {
    if (!activeNovel?.url?.trim()) return;
    const u = activeNovel.url.trim();
    setError('');
    try {
      const base = await getBackendBase();
      const task = await apiFetch<TaskStatus>(base, '/api/download/novel', {
        method: 'POST',
        body: JSON.stringify({ url: u, catalog_only: false }),
      });
      syncToastFromTaskStatus(task);
      startPolling(task.task_id);
    } catch (e) {
      setError('批量下载提交失败：' + String((e as Error).message));
    }
  };

  const [confirmDeleteNovel, setConfirmDeleteNovel] = useState<Novel | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // ── 删除小说 ───────────────────────────────────────────────────

  const performDeleteNovel = async (novel: Novel) => {
    setDeleteBusy(true);
    setError('');
    try {
      const base = await getBackendBase();
      await apiFetch(base, `/api/download/novel/${novel.id}`, { method: 'DELETE' });
      setNovels((prev) => prev.filter((n) => n.id !== novel.id));
      if (activeNovel?.id === novel.id) {
        setActiveNovel(null);
        setChapters([]);
      }
      setConfirmDeleteNovel(null);
    } catch (e) {
      setError('删除失败：' + String((e as Error).message));
    } finally {
      setDeleteBusy(false);
    }
  };

  // ── 过滤书架 ───────────────────────────────────────────────────

  const filteredNovels = searchKeyword
    ? novels.filter(
        (n) =>
          n.title.includes(searchKeyword) || n.author.includes(searchKeyword)
      )
    : novels;

  // ── 格式化字数 ─────────────────────────────────────────────────

  const fmtChars = (n: number) => {
    if (n >= 10000) return `${(n / 10000).toFixed(1)} 万字`;
    return `${n.toLocaleString()} 字`;
  };

  return (
    <div className="download-tab">
      {/* ── 顶部：URL 输入 ── */}
      <div className="download-header">
        <h2 className="download-title">小说下载</h2>
        <p className="download-subtitle">
          请先粘贴<strong>书籍目录页</strong>链接，点击「解析目录」仅把章节目录写入书架<strong>不写正文</strong>；随后在右侧勾选范围，用「下载所选」或「下载全部未抓取」拉取正文。
        </p>

        <div className="download-input-row">
          <input
            className="download-url-input"
            type="url"
            placeholder="粘贴书籍目录页链接（非单章正文页）"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleSubmit()}
          />
          <button
            className="btn-primary"
            onClick={() => void handleSubmit()}
            disabled={!url.trim()}
          >
            解析目录
          </button>
        </div>

        {error && <p className="download-error">{error}</p>}
      </div>

      {/* ── 主内容：左列书架 + 右列章节 ── */}
      <div className="download-body">
        {/* 左：书架 */}
        <aside className="download-sidebar">
          <div className="sidebar-toolbar">
            <h3 className="section-title">书架（{novels.length}）</h3>
            <button
              className="btn-ghost btn--sm"
              onClick={() => void loadNovels()}
              disabled={loadingNovels}
            >
              {loadingNovels ? '…' : '刷新'}
            </button>
          </div>

          <input
            className="search-input"
            type="text"
            placeholder="搜索书名或作者..."
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
          />

          {loadingNovels ? (
            <p className="empty-hint">加载中…</p>
          ) : filteredNovels.length === 0 ? (
            <p className="empty-hint">
              {searchKeyword ? '未找到匹配的书籍' : '书架为空，粘贴链接开始下载'}
            </p>
          ) : (
            <ul className="novel-list">
              {filteredNovels.map((novel) => (
                <li
                  key={novel.id}
                  className={`novel-item${activeNovel?.id === novel.id ? ' novel-item--active' : ''}`}
                  onClick={() => handleSelectNovel(novel)}
                >
                  <div className="novel-item__cover">
                    <span>📖</span>
                  </div>
                  <div className="novel-item__info">
                    <span className="novel-item__title">{novel.title}</span>
                    <span className="novel-item__author">{novel.author || '未知作者'}</span>
                    <div className="novel-item__stats">
                      <span>
                        {novel.downloaded_chapters}/{novel.total_chapters} 章
                      </span>
                      {novel.char_count > 0 && (
                        <span>{fmtChars(novel.char_count)}</span>
                      )}
                    </div>
                    {novel.total_chapters > 0 && (
                      <div className="novel-progress">
                        <div
                          className="novel-progress__bar"
                          style={{ width: `${novel.download_pct}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <button
                    className="novel-item__delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteNovel(novel);
                    }}
                    title="删除"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* 右：章节列表 */}
        <main className="download-main">
          {!activeNovel ? (
            <div className="download-placeholder">
              <p>← 从书架选择一本小说查看章节</p>
              <p className="download-placeholder__sub">
                下载完成后，可在改编项目中引用章节内容
              </p>
            </div>
          ) : (
            <>
              <div className="chapter-header">
                <div>
                  <h3 className="chapter-book-title">《{activeNovel.title}》</h3>
                  <p
                    className="chapter-book-meta"
                    title={
                      '书架字数 = 本书已下载正文条目的字符数之和（不含「分卷」占位行）。点击已下载章节可查看单章内容与字数，应与合计大致吻合。'
                    }
                  >
                    {activeNovel.author && `作者：${activeNovel.author}　`}
                    共 {activeNovel.total_chapters} 章　
                    已下载 {activeNovel.downloaded_chapters} 章
                    {activeNovel.char_count > 0 && `　${fmtChars(activeNovel.char_count)}`}
                  </p>
                </div>
                <div className="chapter-actions">
                  <button
                    className="btn-ghost btn--sm"
                    onClick={() => void loadChapters(activeNovel.id)}
                    disabled={loadingChapters}
                  >
                    刷新章节
                  </button>
                  {activeNovel.downloaded_chapters > 0 && (
                    <button
                      className="btn-ghost btn--sm"
                      title="清空已下载正文并重新抓取（修复番茄等站乱码）"
                      onClick={() => void handleRefetchBodies()}
                    >
                      重新抓取正文
                    </button>
                  )}
                  {activeNovel.downloaded_chapters < activeNovel.total_chapters && (
                    <button
                      className="btn-ghost btn--sm"
                      title="不按勾选，抓取当前所有未有正文的章节"
                      onClick={() => void handleDownloadAllPending()}
                    >
                      下载全部未抓取
                    </button>
                  )}
                  <button
                    className="btn-primary btn--sm"
                    disabled={!selectedPendingCount}
                    title={selectedPendingCount ? undefined : '请勾选左侧尚未下载的正文'}
                    onClick={() => void handleDownloadSelectedChapters()}
                  >
                    下载所选{selectedPendingCount ? ` (${selectedPendingCount})` : ''}
                  </button>
                </div>
              </div>

              {loadingChapters ? (
                <p className="empty-hint">加载章节中…</p>
              ) : chapters.length === 0 ? (
                <p className="empty-hint">暂无章节，请先下载</p>
              ) : (
                <>
                  <div className="chapter-select-toolbar">
                    <span>
                      已选 {selectedChapterIds.size} 条（其中待抓取 {selectedPendingCount}）
                    </span>
                    <button type="button" className="btn-ghost btn--sm" onClick={selectAllUndownloaded}>
                      一键全选未下载
                    </button>
                    <button type="button" className="btn-ghost btn--sm" onClick={clearChapterSelection}>
                      清空勾选
                    </button>
                    <div className="chapter-range">
                      <span className="chapter-range__label">序号</span>
                      <input
                        className="download-url-input chapter-range__input"
                        inputMode="numeric"
                        placeholder="起"
                        value={chapterRangeLo}
                        aria-label="范围起点章节序号"
                        onChange={(e) => setChapterRangeLo(e.target.value)}
                      />
                      <span>—</span>
                      <input
                        className="download-url-input chapter-range__input"
                        inputMode="numeric"
                        placeholder="止"
                        value={chapterRangeHi}
                        aria-label="范围终点章节序号"
                        onChange={(e) => setChapterRangeHi(e.target.value)}
                      />
                      <button type="button" className="btn-ghost btn--sm" onClick={() => applyChapterIndexRange()}>
                        勾选该范围
                      </button>
                      <span className="chapter-select-toolbar__hint">
                        序号即列表左侧数字。「分卷」仅为目录占位，不参与字数统计与勾选下载。已下载章节可点击标题行预览正文。
                      </span>
                    </div>
                  </div>

                  <div className="chapter-list-wrap">
                    <ul className="chapter-list">
                      {chapters.map((ch) => {
                        const bodyDone = !!(ch.downloaded && !ch.is_volume_header);
                        return (
                          <li
                            key={ch.id}
                            className={`chapter-item${bodyDone ? ' chapter-item--done chapter-item--previewable' : ''}${
                              ch.is_volume_header ? ' chapter-item--volume-row' : ''
                            }`}
                            title={bodyDone ? '点击查看本章正文与字数' : undefined}
                            onClick={(ev) => {
                              if (
                                (ev.target as HTMLElement).closest(
                                  'input[type="checkbox"], .chapter-item__chk'
                                )
                              ) {
                                return;
                              }
                              if (!activeNovel || !bodyDone) return;
                              void loadChapterPreview(activeNovel.id, ch);
                            }}
                          >
                            <input
                              type="checkbox"
                              className="chapter-item__chk"
                              checked={
                                selectedChapterIds.has(ch.id) &&
                                !ch.downloaded &&
                                !ch.is_volume_header
                              }
                              disabled={!!ch.downloaded || !!ch.is_volume_header}
                              aria-label={`选择 ${ch.title}`}
                              onChange={() => toggleChapterSelected(ch)}
                            />
                            <span className="chapter-item__index">{ch.chapter_index + 1}</span>
                            <span className="chapter-item__title">{ch.title}</span>
                            <span
                              className="chapter-item__status"
                              title={
                                ch.is_volume_header
                                  ? '此为分卷小标题占位，不参与正文字数与批量下载'
                                  : undefined
                              }
                            >
                              {ch.is_volume_header ? '分卷' : bodyDone ? '✓' : '—'}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </>
              )}
            </>
          )}
        </main>
      </div>

      {chapterPreviewBusy || chapterPreview ? (
        <div className="modal-overlay" onClick={() => closeChapterPreview()}>
          <div
            className="modal modal--wide modal--chapter-preview"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="modal__title">
              {chapterPreviewBusy ? '加载正文…' : chapterPreview?.title ?? ''}
            </h2>
            {chapterPreviewBusy ? (
              <p className="modal__body-text">正在读取本章内容…</p>
            ) : chapterPreview ? (
              <>
                <p className="chapter-preview-meta">
                  本章字符数（含标点换行）：{' '}
                  <strong>{chapterPreview.content.length.toLocaleString()}</strong>
                  {' · '}
                  书架顶部字数为多章之和；若单章数值异常偏大，可对全书使用「重新抓取正文」。
                </p>
                <div className="chapter-preview-scroll">{chapterPreview.content}</div>
              </>
            ) : null}
            <div className="modal__actions">
              <button type="button" className="btn-primary" onClick={() => closeChapterPreview()}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmDeleteNovel ? (
        <div className="modal-overlay" onClick={() => !deleteBusy && setConfirmDeleteNovel(null)}>
          <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">确认删除？</h2>
            <p className="modal__body-text">
              确定要删除《{confirmDeleteNovel.title}》及其所有章节吗？此操作不可恢复。
            </p>
            <div className="modal__actions">
              <button
                type="button"
                className="btn-ghost"
                disabled={deleteBusy}
                onClick={() => setConfirmDeleteNovel(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={deleteBusy}
                onClick={() => void performDeleteNovel(confirmDeleteNovel)}
              >
                {deleteBusy ? '删除中…' : '删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {downloadToast ? (
        <div
          className={`download-task-toast download-task-toast--${downloadToast.variant}`}
          role="status"
          aria-live="polite"
        >
          {downloadToast.variant === 'progress' ? (
            <>
              <div className="download-task-toast__track">
                <div
                  className="download-task-toast__fill"
                  style={{ width: `${downloadToast.progress}%` }}
                />
              </div>
              <div className="download-task-toast__body">
                {downloadToast.bookTitle ? (
                  <span className="download-task-toast__book">{downloadToast.bookTitle}</span>
                ) : null}
                <span className="download-task-toast__msg">{downloadToast.message}</span>
                {(downloadToast.batchTotal ?? 0) > 0 ? (
                  <span className="download-task-toast__sub">
                    本批 {downloadToast.batchDone}/{downloadToast.batchTotal}（
                    {downloadToast.progress}%）
                  </span>
                ) : downloadToast.totalChapters > 0 ? (
                  <span className="download-task-toast__sub">
                    {downloadToast.downloadedChapters}/{downloadToast.totalChapters} 章（
                    {downloadToast.progress}%）
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <div className="download-task-toast__body">
              <span className="download-task-toast__msg">{downloadToast.message}</span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
