import { useCallback, useEffect, useState } from 'react';
import { useAppDialog } from '../context/AppDialogContext';
import { apiFetch, getBackendBase } from '../hooks/useBackend';
import { EV_RELOAD_EPISODES } from '../lib/pipelineImport';

interface Episode {
  id: number;
  ep_number: number;
  title: string;
  core_event: string;
  opening_hook: string;
  ending_hook: string;
  hook_type: string;
  emotion_arc: string;
  special_note: string;
  script_content: string;
  word_count: number;
  status: string;
}

type EpisodeStatus = 'planned' | 'scripted' | 'storyboarded' | 'done';

interface Props { projectId: number }

const EMPTY_DRAFT: Omit<Episode, 'id'> = {
  ep_number: 1,
  title: '',
  core_event: '',
  opening_hook: '',
  ending_hook: '',
  hook_type: '',
  emotion_arc: '',
  special_note: '',
  script_content: '',
  word_count: 0,
  status: 'planned',
};

function statusLabel(s: string): string {
  const map: Record<string, string> = {
    planned: '规划中',
    scripted: '已写稿',
    storyboarded: '已分镜',
    done: '完成',
  };
  return map[s] ?? s;
}

function statusClass(s: string): string {
  const map: Record<string, string> = {
    planned: 'ep-badge--planned',
    scripted: 'ep-badge--scripted',
    storyboarded: 'ep-badge--storyboarded',
    done: 'ep-badge--done',
  };
  return map[s] ?? '';
}

export default function EpisodesTab({ projectId }: Props) {
  const { confirm: appConfirm, alert: appAlert } = useAppDialog();
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selected, setSelected] = useState<Episode | null>(null);
  const [draft, setDraft] = useState<Omit<Episode, 'id'>>({ ...EMPTY_DRAFT });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dedupeBusy, setDedupeBusy] = useState(false);

  const loadEpisodes = useCallback(async () => {
    setLoading(true);
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ episodes: Episode[] }>(
        base,
        `/api/projects/${projectId}/episodes`
      );
      setEpisodes(data.episodes);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadEpisodes(); }, [loadEpisodes]);

  useEffect(() => {
    const fn = () => void loadEpisodes();
    window.addEventListener(EV_RELOAD_EPISODES, fn);
    return () => window.removeEventListener(EV_RELOAD_EPISODES, fn);
  }, [loadEpisodes]);

  const selectEpisode = (ep: Episode) => {
    setSelected(ep);
    setDraft({
      ep_number: ep.ep_number,
      title: ep.title,
      core_event: ep.core_event,
      opening_hook: ep.opening_hook,
      ending_hook: ep.ending_hook,
      hook_type: ep.hook_type,
      emotion_arc: ep.emotion_arc,
      special_note: ep.special_note,
      script_content: ep.script_content,
      word_count: ep.word_count,
      status: ep.status,
    });
  };

  const addEpisode = async () => {
    const nextNum = episodes.length > 0 ? Math.max(...episodes.map((e) => e.ep_number)) + 1 : 1;
    try {
      const base = await getBackendBase();
      const created = await apiFetch<Episode>(base, `/api/projects/${projectId}/episodes`, {
        method: 'POST',
        body: JSON.stringify({ ep_number: nextNum, title: `第${nextNum}集`, status: 'planned' }),
      });
      setEpisodes((prev) => [...prev, created]);
      selectEpisode(created);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const saveEpisode = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const base = await getBackendBase();
      const updated = await apiFetch<Episode>(
        base,
        `/api/projects/${projectId}/episodes/${selected.id}`,
        { method: 'PATCH', body: JSON.stringify(draft) }
      );
      setEpisodes((prev) => prev.map((ep) => (ep.id === selected.id ? updated : ep)));
      setSelected(updated);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  const deleteEpisode = async (id: number) => {
    const ep = episodes.find((e) => e.id === id);
    const label = ep ? `第 ${ep.ep_number} 集${ep.title ? `「${ep.title}」` : ''}` : '该集';
    if (!(await appConfirm({
      title: '删除剧集',
      message: `确定删除 ${label} 吗？本集剧本与规划内容将一并删除，且不可恢复。`,
      confirmLabel: '删除',
    }))) return;
    try {
      const base = await getBackendBase();
      await apiFetch(base, `/api/projects/${projectId}/episodes/${id}`, { method: 'DELETE' });
      setEpisodes((prev) => prev.filter((ep) => ep.id !== id));
      if (selected?.id === id) {
        setSelected(null);
        setDraft({ ...EMPTY_DRAFT });
      }
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const deduplicateEpisodes = async () => {
    setDedupeBusy(true);
    setError('');
    try {
      const base = await getBackendBase();
      const res = await apiFetch<{ merged_groups: number; removed_rows: number }>(
        base,
        `/api/projects/${projectId}/episodes/deduplicate`,
        { method: 'POST' }
      );
      await loadEpisodes();
      setSelected(null);
      setDraft({ ...EMPTY_DRAFT });
      if (res.removed_rows > 0) {
        await appAlert({ title: '合并完成', message: `已合并 ${res.merged_groups} 组重复集数，删除 ${res.removed_rows} 条多余记录。` });
      } else {
        await appAlert({ title: '无需合并', message: '当前没有相同集号的重复条目。' });
      }
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setDedupeBusy(false);
    }
  };

  const setField = <K extends keyof Omit<Episode, 'id'>>(key: K, val: Omit<Episode, 'id'>[K]) => {
    setDraft((d) => ({ ...d, [key]: val }));
  };

  return (
    <div className="ep-tab">
      {/* ── 顶部工具栏 ── */}
      <div className="ep-tab__head">
        <h2 className="section-title">集数规划</h2>
        <div className="ep-tab__head-actions">
          <button
            type="button"
            className="btn-ghost btn-sm"
            disabled={dedupeBusy || episodes.length === 0}
            title="将同一集号的多条合并为一条（保留已写稿最长正文，规划字段互相补全）"
            onClick={() => void deduplicateEpisodes()}
          >
            {dedupeBusy ? '合并中…' : '合并重复集数'}
          </button>
          <button className="btn-primary" onClick={() => void addEpisode()}>＋ 添加集</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="ep-tab__body">
        {/* ── 左侧集数列表 ── */}
        <div className="ep-list">
          {loading && <div className="tab-loading">加载中…</div>}
          {episodes.length === 0 && !loading && (
            <div className="ep-list__empty">暂无集数，点击「＋ 添加集」创建</div>
          )}
          {episodes.map((ep) => (
            <div
              key={ep.id}
              className={`ep-list__item${selected?.id === ep.id ? ' ep-list__item--active' : ''}`}
              onClick={() => selectEpisode(ep)}
            >
              <div className="ep-list__item-top">
                <span className="ep-list__num">第{ep.ep_number}集</span>
                <span className={`ep-badge ${statusClass(ep.status)}`}>{statusLabel(ep.status)}</span>
              </div>
              <div className="ep-list__title">{ep.title || '（无标题）'}</div>
              <button
                type="button"
                className="ep-list__del"
                onClick={(e) => { e.stopPropagation(); void deleteEpisode(ep.id); }}
                title="删除本集"
                aria-label="删除本集"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {/* ── 右侧详情编辑区 ── */}
        <div className="ep-detail">
          {!selected ? (
            <div className="ep-detail__placeholder">← 选择左侧集数以编辑</div>
          ) : (
            <>
              <div className="ep-detail__row ep-detail__row--2col">
                <div className="ep-detail__field">
                  <label className="field-label">集号</label>
                  <input
                    type="number"
                    value={draft.ep_number}
                    onChange={(e) => setField('ep_number', Number(e.target.value))}
                  />
                </div>
                <div className="ep-detail__field">
                  <label className="field-label">状态</label>
                  <select
                    value={draft.status}
                    onChange={(e) => setField('status', e.target.value as EpisodeStatus)}
                  >
                    <option value="planned">规划中</option>
                    <option value="scripted">已写稿</option>
                    <option value="storyboarded">已分镜</option>
                    <option value="done">完成</option>
                  </select>
                </div>
              </div>

              <div className="ep-detail__field">
                <label className="field-label">标题</label>
                <input
                  type="text"
                  value={draft.title}
                  onChange={(e) => setField('title', e.target.value)}
                  placeholder="本集标题"
                />
              </div>

              <div className="ep-detail__field">
                <label className="field-label">核心事件</label>
                <textarea
                  rows={2}
                  value={draft.core_event}
                  onChange={(e) => setField('core_event', e.target.value)}
                  placeholder="本集最重要的情节转折或事件"
                />
              </div>

              <div className="ep-detail__row ep-detail__row--2col">
                <div className="ep-detail__field">
                  <label className="field-label">开场钩子</label>
                  <textarea
                    rows={2}
                    value={draft.opening_hook}
                    onChange={(e) => setField('opening_hook', e.target.value)}
                    placeholder="前3秒吸引观众的钩子"
                  />
                </div>
                <div className="ep-detail__field">
                  <label className="field-label">结尾钩子</label>
                  <textarea
                    rows={2}
                    value={draft.ending_hook}
                    onChange={(e) => setField('ending_hook', e.target.value)}
                    placeholder="促使观众追下一集的悬念"
                  />
                </div>
              </div>

              <div className="ep-detail__row ep-detail__row--2col">
                <div className="ep-detail__field">
                  <label className="field-label">钩子类型</label>
                  <input
                    type="text"
                    value={draft.hook_type}
                    onChange={(e) => setField('hook_type', e.target.value)}
                    placeholder="悬念 / 冲突 / 反转 / 爽点…"
                  />
                </div>
                <div className="ep-detail__field">
                  <label className="field-label">情绪走向</label>
                  <input
                    type="text"
                    value={draft.emotion_arc}
                    onChange={(e) => setField('emotion_arc', e.target.value)}
                    placeholder="压抑→爆发→释放…"
                  />
                </div>
              </div>

              <div className="ep-detail__field">
                <label className="field-label">特殊标注</label>
                <input
                  type="text"
                  value={draft.special_note}
                  onChange={(e) => setField('special_note', e.target.value)}
                  placeholder="⚡强反转 / 🔥爽点爆发 / 💔虐心节点…"
                />
              </div>

              <div className="ep-detail__field">
                <label className="field-label">本集剧本正文</label>
                <textarea
                  rows={10}
                  value={draft.script_content}
                  onChange={(e) => setField('script_content', e.target.value)}
                  placeholder="本集完整剧本内容（可粘贴流水线输出）"
                />
              </div>

              <div className="ep-detail__actions">
                <button
                  className="btn-primary"
                  onClick={() => void saveEpisode()}
                  disabled={saving}
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
