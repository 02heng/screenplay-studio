import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppDialog } from '../context/AppDialogContext';
import { apiFetch, getBackendBase } from '../hooks/useBackend';

// ─── 数据类型 ─────────────────────────────────────────────────────────────────

interface ClipItem {
  id: string;
  shot_id: number | null;
  video_path: string;
  in_point: number;
  out_point: number;
  order_index: number;
  transition: 'cut' | 'fade' | 'dissolve';
  transition_duration: number;
}

interface SubtitleItem {
  id: string;
  text: string;
  start_sec: number;
  end_sec: number;
  position: string;
  font_size: number;
  color: string;
}

interface BgmTrack {
  id: string;
  audio_path: string;
  start_sec: number;
  volume: number;
  loop: boolean;
}

interface TimelineRecord {
  id: number;
  project_id: number;
  name: string;
  fps: number;
  resolution: string;
  clips_json: string;
  subtitles_json: string;
  bgm_json: string;
  status: string;
  export_path: string;
  created_at: string;
  updated_at: string;
}

type SelectionKind = 'clip' | 'subtitle' | 'bgm';
interface Selection {
  kind: SelectionKind;
  id: string;
}

interface Props {
  projectId: number;
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

function uid(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function parseClips(json: string): ClipItem[] {
  try { return JSON.parse(json) as ClipItem[]; } catch { return []; }
}
function parseSubtitles(json: string): SubtitleItem[] {
  try { return JSON.parse(json) as SubtitleItem[]; } catch { return []; }
}
function parseBgm(json: string): BgmTrack[] {
  try { return JSON.parse(json) as BgmTrack[]; } catch { return []; }
}

// ─── 主组件 ──────────────────────────────────────────────────────────────────

export default function TimelineTab({ projectId }: Props) {
  const { confirm: appConfirm } = useAppDialog();
  const [timelines, setTimelines] = useState<TimelineRecord[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [subtitles, setSubtitles] = useState<SubtitleItem[]>([]);
  const [bgm, setBgm] = useState<BgmTrack[]>([]);
  const [status, setStatus] = useState<string>('draft');
  const [exportPath, setExportPath] = useState<string>('');
  const [resolution, setResolution] = useState<string>('1080x1920');
  const [fps, setFps] = useState<number>(25);
  const [tlName, setTlName] = useState<string>('主时间线');

  const [selection, setSelection] = useState<Selection | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 拖拽排序状态
  const dragIndexRef = useRef<number | null>(null);

  // debounce timer
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 轮询 interval
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── 数据加载 ────────────────────────────────────────────────────────────────

  const loadTimelines = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ timelines: TimelineRecord[] }>(
        base,
        `/api/projects/${projectId}/timelines`,
      );
      setTimelines(data.timelines);
      if (data.timelines.length > 0 && activeId === null) {
        loadTimeline(data.timelines[0]);
      }
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function loadTimeline(tl: TimelineRecord) {
    setActiveId(tl.id);
    setClips(parseClips(tl.clips_json));
    setSubtitles(parseSubtitles(tl.subtitles_json));
    setBgm(parseBgm(tl.bgm_json));
    setStatus(tl.status);
    setExportPath(tl.export_path);
    setResolution(tl.resolution);
    setFps(tl.fps);
    setTlName(tl.name);
    setSelection(null);
  }

  useEffect(() => { void loadTimelines(); }, [loadTimelines]);

  // ── 导出轮询 ────────────────────────────────────────────────────────────────

  const pollExport = useCallback(async () => {
    if (activeId === null) return;
    try {
      const base = await getBackendBase();
      const tl = await apiFetch<TimelineRecord>(
        base,
        `/api/projects/${projectId}/timelines/${activeId}`,
      );
      setStatus(tl.status);
      setExportPath(tl.export_path);
      if (tl.status !== 'exporting' && pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {
      // 静默失败
    }
  }, [activeId, projectId]);

  useEffect(() => {
    if (status === 'exporting') {
      if (pollRef.current !== null) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => { void pollExport(); }, 2000);
    } else {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current !== null) clearInterval(pollRef.current);
    };
  }, [status, pollExport]);

  // ── CRUD 操作 ────────────────────────────────────────────────────────────────

  const createTimeline = async () => {
    const base = await getBackendBase();
    const tl = await apiFetch<TimelineRecord>(
      base,
      `/api/projects/${projectId}/timelines`,
      { method: 'POST', body: JSON.stringify({ name: '新时间线', fps: 25, resolution: '1080x1920' }) },
    );
    setTimelines((prev) => [...prev, tl]);
    loadTimeline(tl);
  };

  const saveTimeline = useCallback(
    async (
      newClips: ClipItem[],
      newSubs: SubtitleItem[],
      newBgm: BgmTrack[],
    ) => {
      if (activeId === null) return;
      setSaving(true);
      try {
        const base = await getBackendBase();
        await apiFetch(base, `/api/projects/${projectId}/timelines/${activeId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            clips_json: JSON.stringify(newClips),
            subtitles_json: JSON.stringify(newSubs),
            bgm_json: JSON.stringify(newBgm),
          }),
        });
      } catch (e) {
        setError(String((e as Error).message));
      } finally {
        setSaving(false);
      }
    },
    [activeId, projectId],
  );

  // debounce 自动保存
  function scheduleSave(nc: ClipItem[], ns: SubtitleItem[], nb: BgmTrack[]) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { void saveTimeline(nc, ns, nb); }, 500);
  }

  const buildFromStoryboard = async () => {
    if (activeId === null) return;
    setLoading(true);
    try {
      const base = await getBackendBase();
      const res = await apiFetch<{ clips_count: number; clips_json: string }>(
        base,
        `/api/projects/${projectId}/timelines/${activeId}/build-from-storyboard`,
        { method: 'POST' },
      );
      const newClips = parseClips(res.clips_json);
      setClips(newClips);
      scheduleSave(newClips, subtitles, bgm);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  };

  const triggerExport = async () => {
    if (activeId === null) return;
    try {
      const base = await getBackendBase();
      await apiFetch(base, `/api/projects/${projectId}/timelines/${activeId}/export`, {
        method: 'POST',
      });
      setStatus('exporting');
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  // ── Clip 操作 ────────────────────────────────────────────────────────────────

  const addClip = () => {
    const newClip: ClipItem = {
      id: uid(),
      shot_id: null,
      video_path: '',
      in_point: 0,
      out_point: 3,
      order_index: clips.length,
      transition: 'cut',
      transition_duration: 0,
    };
    const newClips = [...clips, newClip];
    setClips(newClips);
    setSelection({ kind: 'clip', id: newClip.id });
    scheduleSave(newClips, subtitles, bgm);
  };

  const updateClip = (id: string, patch: Partial<ClipItem>) => {
    const newClips = clips.map((c) => (c.id === id ? { ...c, ...patch } : c));
    setClips(newClips);
    scheduleSave(newClips, subtitles, bgm);
  };

  const removeClip = async (id: string) => {
    if (!(await appConfirm({
      title: '删除片段',
      message: '确定删除该视频片段吗？',
      confirmLabel: '删除',
    }))) return;
    const newClips = clips.filter((c) => c.id !== id).map((c, i) => ({ ...c, order_index: i }));
    setClips(newClips);
    if (selection?.id === id) setSelection(null);
    scheduleSave(newClips, subtitles, bgm);
  };

  // 拖拽排序
  const onDragStart = (index: number) => { dragIndexRef.current = index; };
  const onDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    const from = dragIndexRef.current;
    if (from === null || from === index) return;
    const newClips = [...clips];
    const [moved] = newClips.splice(from, 1);
    newClips.splice(index, 0, moved);
    const reindexed = newClips.map((c, i) => ({ ...c, order_index: i }));
    setClips(reindexed);
    dragIndexRef.current = index;
  };
  const onDragEnd = () => {
    dragIndexRef.current = null;
    scheduleSave(clips, subtitles, bgm);
  };

  // ── Subtitle 操作 ────────────────────────────────────────────────────────────

  const addSubtitle = () => {
    const newSub: SubtitleItem = {
      id: uid(),
      text: '字幕文本',
      start_sec: 0,
      end_sec: 3,
      position: 'bottom',
      font_size: 36,
      color: '#ffffff',
    };
    const newSubs = [...subtitles, newSub];
    setSubtitles(newSubs);
    setSelection({ kind: 'subtitle', id: newSub.id });
    scheduleSave(clips, newSubs, bgm);
  };

  const updateSubtitle = (id: string, patch: Partial<SubtitleItem>) => {
    const newSubs = subtitles.map((s) => (s.id === id ? { ...s, ...patch } : s));
    setSubtitles(newSubs);
    scheduleSave(clips, newSubs, bgm);
  };

  const removeSubtitle = async (id: string) => {
    if (!(await appConfirm({
      title: '删除字幕',
      message: '确定删除该字幕吗？',
      confirmLabel: '删除',
    }))) return;
    const newSubs = subtitles.filter((s) => s.id !== id);
    setSubtitles(newSubs);
    if (selection?.id === id) setSelection(null);
    scheduleSave(clips, newSubs, bgm);
  };

  // ── BGM 操作 ─────────────────────────────────────────────────────────────────

  const addBgm = () => {
    const newBgmTrack: BgmTrack = {
      id: uid(),
      audio_path: '',
      start_sec: 0,
      volume: 0.8,
      loop: true,
    };
    const newBgm = [...bgm, newBgmTrack];
    setBgm(newBgm);
    setSelection({ kind: 'bgm', id: newBgmTrack.id });
    scheduleSave(clips, subtitles, newBgm);
  };

  const updateBgm = (id: string, patch: Partial<BgmTrack>) => {
    const newBgm = bgm.map((b) => (b.id === id ? { ...b, ...patch } : b));
    setBgm(newBgm);
    scheduleSave(clips, subtitles, newBgm);
  };

  const removeBgm = async (id: string) => {
    if (!(await appConfirm({
      title: '删除 BGM',
      message: '确定删除该 BGM 轨道吗？',
      confirmLabel: '删除',
    }))) return;
    const newBgm = bgm.filter((b) => b.id !== id);
    setBgm(newBgm);
    if (selection?.id === id) setSelection(null);
    scheduleSave(clips, subtitles, newBgm);
  };

  // ── 选中项属性 ───────────────────────────────────────────────────────────────

  const selectedClip = selection?.kind === 'clip' ? clips.find((c) => c.id === selection.id) : undefined;
  const selectedSub = selection?.kind === 'subtitle' ? subtitles.find((s) => s.id === selection.id) : undefined;
  const selectedBgm = selection?.kind === 'bgm' ? bgm.find((b) => b.id === selection.id) : undefined;

  // ── 渲染 ─────────────────────────────────────────────────────────────────────

  return (
    <div className="tl-tab">
      {/* 顶部工具栏 */}
      <div className="tl-toolbar">
        <button className="btn-primary btn-sm" onClick={() => void createTimeline()}>
          + 新建时间线
        </button>

        {timelines.length > 1 && (
          <select
            className="select-sm"
            value={activeId ?? ''}
            onChange={(e) => {
              const tl = timelines.find((t) => t.id === Number(e.target.value));
              if (tl) loadTimeline(tl);
            }}
          >
            {timelines.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}

        {activeId !== null && (
          <>
            <button className="btn-ghost btn-sm" onClick={() => void buildFromStoryboard()} disabled={loading}>
              从分镜导入
            </button>
            <button
              className="btn-primary btn-sm"
              onClick={() => void triggerExport()}
              disabled={status === 'exporting'}
            >
              {status === 'exporting' ? '导出中…' : '▶ 导出 MP4'}
            </button>
            <span className="tl-toolbar__res">{resolution} · {fps}fps</span>
            {saving && <span className="tl-toolbar__saving">保存中…</span>}
          </>
        )}
      </div>

      {error && <div className="error" style={{ margin: '8px 20px' }}>{error}</div>}

      {activeId === null ? (
        <div className="tab-loading" style={{ flex: 1 }}>
          {loading ? '加载中…' : '暂无时间线，点击「新建时间线」开始'}
        </div>
      ) : (
        <div className="tl-body">
          {/* 轨道区 */}
          <div className="tl-tracks">
            {/* 视频轨 */}
            <div className="tl-track">
              <div className="tl-track__header">
                <span className="tl-track__label">视频轨</span>
                <button className="btn-ghost btn-xs" onClick={addClip}>+ 添加</button>
              </div>
              <div className="tl-track__lane">
                {clips.length === 0 && (
                  <span className="tl-track__empty">暂无片段，点击「从分镜导入」或手动添加</span>
                )}
                {clips.map((clip, index) => (
                  <div
                    key={clip.id}
                    className={`tl-clip${selection?.id === clip.id ? ' tl-clip--selected' : ''}`}
                    style={{ minWidth: `${Math.max(80, (clip.out_point - clip.in_point) * 20)}px` }}
                    onClick={() => setSelection({ kind: 'clip', id: clip.id })}
                    draggable
                    onDragStart={() => onDragStart(index)}
                    onDragOver={(e) => onDragOver(e, index)}
                    onDragEnd={onDragEnd}
                  >
                    <div className="tl-clip__name" title={clip.video_path}>
                      {clip.video_path ? basename(clip.video_path) : '(空)'}
                    </div>
                    <div className="tl-clip__dur">
                      {(clip.out_point - clip.in_point).toFixed(1)}s
                      {clip.transition !== 'cut' && ` · ${clip.transition}`}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 字幕轨 */}
            <div className="tl-track">
              <div className="tl-track__header">
                <span className="tl-track__label">字幕轨</span>
                <button className="btn-ghost btn-xs" onClick={addSubtitle}>+ 添加</button>
              </div>
              <div className="tl-track__lane">
                {subtitles.length === 0 && (
                  <span className="tl-track__empty">暂无字幕</span>
                )}
                {subtitles.map((sub) => (
                  <div
                    key={sub.id}
                    className={`tl-subtitle-item${selection?.id === sub.id ? ' tl-clip--selected' : ''}`}
                    style={{ minWidth: `${Math.max(60, (sub.end_sec - sub.start_sec) * 20)}px` }}
                    onClick={() => setSelection({ kind: 'subtitle', id: sub.id })}
                  >
                    {sub.text.slice(0, 12)}{sub.text.length > 12 ? '…' : ''}
                  </div>
                ))}
              </div>
            </div>

            {/* BGM 轨 */}
            <div className="tl-track">
              <div className="tl-track__header">
                <span className="tl-track__label">BGM 轨</span>
                <button className="btn-ghost btn-xs" onClick={addBgm}>+ 添加</button>
              </div>
              <div className="tl-track__lane">
                {bgm.length === 0 && (
                  <span className="tl-track__empty">暂无背景音乐</span>
                )}
                {bgm.map((b) => (
                  <div
                    key={b.id}
                    className={`tl-bgm-item${selection?.id === b.id ? ' tl-clip--selected' : ''}`}
                    onClick={() => setSelection({ kind: 'bgm', id: b.id })}
                  >
                    {b.audio_path ? basename(b.audio_path) : '(未选文件)'}
                    &nbsp;·&nbsp;{Math.round(b.volume * 100)}%
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 属性面板 */}
          {selection !== null && (
            <div className="tl-props">
              {selectedClip && (
                <ClipProps
                  clip={selectedClip}
                  onChange={(patch) => updateClip(selectedClip.id, patch)}
                  onRemove={() => void removeClip(selectedClip.id)}
                />
              )}
              {selectedSub && (
                <SubtitleProps
                  sub={selectedSub}
                  onChange={(patch) => updateSubtitle(selectedSub.id, patch)}
                  onRemove={() => void removeSubtitle(selectedSub.id)}
                />
              )}
              {selectedBgm && (
                <BgmProps
                  track={selectedBgm}
                  onChange={(patch) => updateBgm(selectedBgm.id, patch)}
                  onRemove={() => void removeBgm(selectedBgm.id)}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* 导出状态栏 */}
      <div className="tl-statusbar">
        <StatusBar status={status} exportPath={exportPath} />
      </div>
    </div>
  );
}

// ─── 属性面板子组件 ──────────────────────────────────────────────────────────

interface ClipPropsProps {
  clip: ClipItem;
  onChange: (patch: Partial<ClipItem>) => void;
  onRemove: () => void;
}

function ClipProps({ clip, onChange, onRemove }: ClipPropsProps) {
  return (
    <div>
      <div className="tl-props__header">
        <span className="tl-props__title">Clip 属性</span>
        <button className="btn-danger btn-xs" onClick={onRemove}>删除</button>
      </div>
      <div className="tl-props__grid">
        <div className="tl-props__field">
          <label className="field-label">Shot ID（只读）</label>
          <input readOnly value={clip.shot_id ?? '—'} />
        </div>
        <div className="tl-props__field">
          <label className="field-label">素材路径（只读）</label>
          <input readOnly value={clip.video_path} title={clip.video_path} />
        </div>
        <div className="tl-props__field">
          <label className="field-label">入点 (s)</label>
          <input
            type="number" step={0.1} min={0}
            value={clip.in_point}
            onChange={(e) => onChange({ in_point: Number(e.target.value) })}
          />
        </div>
        <div className="tl-props__field">
          <label className="field-label">出点 (s)</label>
          <input
            type="number" step={0.1} min={0}
            value={clip.out_point}
            onChange={(e) => onChange({ out_point: Number(e.target.value) })}
          />
        </div>
        <div className="tl-props__field">
          <label className="field-label">转场</label>
          <select
            value={clip.transition}
            onChange={(e) => onChange({ transition: e.target.value as ClipItem['transition'] })}
          >
            <option value="cut">硬切 (cut)</option>
            <option value="fade">淡入淡出 (fade)</option>
            <option value="dissolve">叠化 (dissolve)</option>
          </select>
        </div>
        <div className="tl-props__field">
          <label className="field-label">转场时长 (s)</label>
          <input
            type="number" step={0.1} min={0}
            value={clip.transition_duration}
            onChange={(e) => onChange({ transition_duration: Number(e.target.value) })}
          />
        </div>
      </div>
    </div>
  );
}

interface SubtitlePropsProps {
  sub: SubtitleItem;
  onChange: (patch: Partial<SubtitleItem>) => void;
  onRemove: () => void;
}

function SubtitleProps({ sub, onChange, onRemove }: SubtitlePropsProps) {
  return (
    <div>
      <div className="tl-props__header">
        <span className="tl-props__title">字幕属性</span>
        <button className="btn-danger btn-xs" onClick={onRemove}>删除</button>
      </div>
      <div className="tl-props__grid">
        <div className="tl-props__field tl-props__field--full">
          <label className="field-label">字幕文本</label>
          <textarea
            rows={3}
            value={sub.text}
            onChange={(e) => onChange({ text: e.target.value })}
          />
        </div>
        <div className="tl-props__field">
          <label className="field-label">开始时间 (s)</label>
          <input
            type="number" step={0.1} min={0}
            value={sub.start_sec}
            onChange={(e) => onChange({ start_sec: Number(e.target.value) })}
          />
        </div>
        <div className="tl-props__field">
          <label className="field-label">结束时间 (s)</label>
          <input
            type="number" step={0.1} min={0}
            value={sub.end_sec}
            onChange={(e) => onChange({ end_sec: Number(e.target.value) })}
          />
        </div>
        <div className="tl-props__field">
          <label className="field-label">字号 (px)</label>
          <input
            type="number" step={1} min={10}
            value={sub.font_size}
            onChange={(e) => onChange({ font_size: Number(e.target.value) })}
          />
        </div>
        <div className="tl-props__field">
          <label className="field-label">颜色</label>
          <input
            type="color"
            value={sub.color}
            onChange={(e) => onChange({ color: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

interface BgmPropsProps {
  track: BgmTrack;
  onChange: (patch: Partial<BgmTrack>) => void;
  onRemove: () => void;
}

function BgmProps({ track, onChange, onRemove }: BgmPropsProps) {
  return (
    <div>
      <div className="tl-props__header">
        <span className="tl-props__title">BGM 属性</span>
        <button className="btn-danger btn-xs" onClick={onRemove}>删除</button>
      </div>
      <div className="tl-props__grid">
        <div className="tl-props__field tl-props__field--full">
          <label className="field-label">音频路径</label>
          <input
            value={track.audio_path}
            placeholder="填入音频文件绝对路径"
            onChange={(e) => onChange({ audio_path: e.target.value })}
          />
        </div>
        <div className="tl-props__field">
          <label className="field-label">开始时间 (s)</label>
          <input
            type="number" step={0.1} min={0}
            value={track.start_sec}
            onChange={(e) => onChange({ start_sec: Number(e.target.value) })}
          />
        </div>
        <div className="tl-props__field">
          <label className="field-label">音量 ({Math.round(track.volume * 100)}%)</label>
          <input
            type="range" min={0} max={1} step={0.01}
            value={track.volume}
            onChange={(e) => onChange({ volume: Number(e.target.value) })}
          />
        </div>
        <div className="tl-props__field">
          <label className="field-label">循环播放</label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={track.loop}
              onChange={(e) => onChange({ loop: e.target.checked })}
            />
            <span>循环</span>
          </label>
        </div>
      </div>
    </div>
  );
}

// ─── 状态栏 ──────────────────────────────────────────────────────────────────

function StatusBar({ status, exportPath }: { status: string; exportPath: string }) {
  if (status === 'draft') {
    return <span style={{ color: 'var(--muted)' }}>● 草稿</span>;
  }
  if (status === 'exporting') {
    return (
      <>
        <span className="tl-spinner" />
        <span style={{ color: 'var(--accent)' }}>导出中…</span>
      </>
    );
  }
  if (status === 'done') {
    return (
      <>
        <span style={{ color: '#6dc886' }}>✓ 导出完成</span>
        <span style={{ color: 'var(--muted)', fontSize: '11px' }}>{exportPath}</span>
      </>
    );
  }
  if (status === 'error') {
    return (
      <>
        <span style={{ color: 'var(--danger)' }}>✕ 导出错误</span>
        <span style={{ color: 'var(--danger)', fontSize: '11px', maxWidth: '600px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {exportPath}
        </span>
      </>
    );
  }
  return <span style={{ color: 'var(--muted)' }}>● {status}</span>;
}
