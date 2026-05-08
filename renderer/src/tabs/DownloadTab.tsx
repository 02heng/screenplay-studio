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
}

interface TaskStatus {
  task_id: string;
  status: 'pending' | 'parsing' | 'downloading' | 'done' | 'error';
  message: string;
  progress: number;
  total_chapters: number;
  downloaded_chapters: number;
  book_id: number | null;
  book_title: string;
}

const STATUS_LABELS: Record<string, string> = {
  pending: '等待中',
  parsing: '解析中',
  downloading: '下载中',
  done: '已完成',
  error: '下载失败',
};

export default function DownloadTab() {
  const [url, setUrl] = useState('');
  const [novels, setNovels] = useState<Novel[]>([]);
  const [activeNovel, setActiveNovel] = useState<Novel | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loadingNovels, setLoadingNovels] = useState(false);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [tasks, setTasks] = useState<Record<string, TaskStatus>>({});
  const [error, setError] = useState('');
  const [searchKeyword, setSearchKeyword] = useState('');
  const pollingRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  // ── 加载书架 ────────────────────────────────────────────────────

  const loadNovels = useCallback(async () => {
    setLoadingNovels(true);
    setError('');
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ novels: Novel[] }>(base, '/api/download/novels');
      setNovels(data.novels);
    } catch (e) {
      setError('加载书架失败：' + String((e as Error).message));
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

  const handleSelectNovel = (novel: Novel) => {
    setActiveNovel(novel);
    void loadChapters(novel.id);
  };

  // ── 轮询任务状态 ───────────────────────────────────────────────

  const startPolling = (taskId: string) => {
    if (pollingRef.current[taskId]) return;

    pollingRef.current[taskId] = setInterval(async () => {
      try {
        const base = await getBackendBase();
        const status = await apiFetch<TaskStatus>(base, `/api/download/status/${taskId}`);
        setTasks((prev) => ({ ...prev, [taskId]: status }));

        if (status.status === 'done' || status.status === 'error') {
          clearInterval(pollingRef.current[taskId]);
          delete pollingRef.current[taskId];
          if (status.status === 'done') {
            void loadNovels();
            if (activeNovel && status.book_id === activeNovel.id) {
              void loadChapters(activeNovel.id);
            }
          }
        }
      } catch {
        clearInterval(pollingRef.current[taskId]);
        delete pollingRef.current[taskId];
      }
    }, 1500);
  };

  useEffect(() => {
    return () => {
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
        body: JSON.stringify({ url: trimmedUrl }),
      });
      setTasks((prev) => ({ ...prev, [task.task_id]: task }));
      setUrl('');
      startPolling(task.task_id);
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
      setTasks((prev) => ({ ...prev, [task.task_id]: task }));
      startPolling(task.task_id);
    } catch (e) {
      setError('重新抓取失败：' + String((e as Error).message));
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

  // ── 当前进行中的任务 ──────────────────────────────────────────

  const activeTasks = Object.values(tasks).filter(
    (t) => t.status !== 'done' && t.status !== 'error'
  );
  const recentTasks = Object.values(tasks).slice(-5);

  return (
    <div className="download-tab">
      {/* ── 顶部：URL 输入 ── */}
      <div className="download-header">
        <h2 className="download-title">小说下载</h2>
        <p className="download-subtitle">
          粘贴链接抓取章节，下载后可用于剧本改编。可以通过网页下载小说。
        </p>

        <div className="download-input-row">
          <input
            className="download-url-input"
            type="url"
            placeholder="粘贴书页链接"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleSubmit()}
          />
          <button
            className="btn-primary"
            onClick={() => void handleSubmit()}
            disabled={!url.trim()}
          >
            开始下载
          </button>
        </div>

        {error && <p className="download-error">{error}</p>}
      </div>

      {/* ── 下载任务状态 ── */}
      {recentTasks.length > 0 && (
        <div className="download-tasks">
          <h3 className="section-title">下载任务</h3>
          {recentTasks.map((task) => (
            <div key={task.task_id} className={`task-card task-card--${task.status}`}>
              <div className="task-card__header">
                <span className="task-title">
                  {task.book_title || '解析中…'}
                </span>
                <span className={`task-badge task-badge--${task.status}`}>
                  {STATUS_LABELS[task.status] ?? task.status}
                </span>
              </div>
              <p className="task-message">{task.message}</p>
              {task.status === 'downloading' && (
                <div className="task-progress">
                  <div
                    className="task-progress__bar"
                    style={{ width: `${task.progress}%` }}
                  />
                  <span className="task-progress__text">
                    {task.downloaded_chapters}/{task.total_chapters} 章
                    （{task.progress}%）
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

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
                  <p className="chapter-book-meta">
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
                  {/* 若还未完全下载，显示下载按钮 */}
                  {activeNovel.downloaded_chapters < activeNovel.total_chapters && (
                    <button
                      className="btn-primary btn--sm"
                      onClick={() => {
                        setUrl(activeNovel.url);
                        void handleSubmit();
                      }}
                    >
                      继续下载
                    </button>
                  )}
                </div>
              </div>

              {loadingChapters ? (
                <p className="empty-hint">加载章节中…</p>
              ) : chapters.length === 0 ? (
                <p className="empty-hint">暂无章节，请先下载</p>
              ) : (
                <div className="chapter-list-wrap">
                  <ul className="chapter-list">
                    {chapters.map((ch) => (
                      <li
                        key={ch.id}
                        className={`chapter-item${ch.downloaded ? ' chapter-item--done' : ''}`}
                      >
                        <span className="chapter-item__index">
                          {ch.chapter_index + 1}
                        </span>
                        <span className="chapter-item__title">{ch.title}</span>
                        <span className="chapter-item__status">
                          {ch.downloaded ? '✓' : '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </main>
      </div>

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
    </div>
  );
}
