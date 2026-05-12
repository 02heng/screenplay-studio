import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppDialog } from '../context/AppDialogContext';
import { apiFetch, getBackendBase } from '../hooks/useBackend';
import { EV_RELOAD_STORYBOARD, importStoryboardFromPhase } from '../lib/pipelineImport';

const IMAGE_API_KEY = 'screenplay-studio-image-api-v1';

interface Scene { id: number; scene_number: number; location: string; time_of_day: string; description: string }
interface Shot {
  id: number;
  scene_id: number;
  shot_number: number;
  // 时间轴
  timecode_in: string;
  timecode_out: string;
  duration_sec: number;
  // 画面
  shot_content: string;
  shot_type: string;
  camera_movement: string;
  director_intent: string;
  // 摄影参数
  camera_params: string;
  lighting: string;
  color_tone: string;
  // 音效
  sound_design: string;
  // 台词与字幕
  dialogue: string;
  subtitle_text: string;
  // 动作与 AI
  action: string;
  ai_prompt: string;
  animation_prompt: string;
  // 关键帧 / 参考图（JSON 数组字符串）；首张为列表默认主预览
  frame_images: string;
  // 多版本镜头视频（JSON ）；首张为列表默认主预览
  video_paths?: string;
  // 生成结果（与队列首同步）
  image_path: string | null;
  video_path: string | null;
}
interface ImageApiConfig { baseUrl: string; endpointPath: string; model: string; apiKey: string }

interface BatchJobState {
  jobId: number;
  type: 'image' | 'video';
  sceneId: number;
}

interface BatchProgress {
  status: string;
  total: number;
  success: number;
  failed: number;
}

function loadImageApi(): ImageApiConfig {
  try { return JSON.parse(localStorage.getItem(IMAGE_API_KEY) || '{}') as ImageApiConfig; }
  catch { return { baseUrl: '', endpointPath: 'images/generations', model: 'dall-e-3', apiKey: '' }; }
}

function parsePathJson(raw: string | undefined): string[] {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
  } catch {
    return [];
  }
}

/** 列表中的关键帧路径；合并旧版仅 image_path */
function normalizeKeyframeUrls(shot: Shot): string[] {
  const fromFrames = parsePathJson(shot.frame_images);
  const legacy = shot.image_path?.trim();
  if (!legacy) return [...fromFrames];
  if (!fromFrames.includes(legacy)) return [legacy, ...fromFrames];
  return [...fromFrames];
}

/** 同一镜头多段视频的 URL / 路径；合并旧版仅 video_path */
function normalizeVideoUrls(shot: Shot): string[] {
  const fromVp = parsePathJson(shot.video_paths);
  const legacy = shot.video_path?.trim();
  if (!legacy) return [...fromVp];
  if (!fromVp.includes(legacy)) return [legacy, ...fromVp];
  return [...fromVp];
}

/** 汇总单镜头画面、参数、台词与各类 AI 提示词，供一键复制到剪贴板 */
function buildShotAllPromptsText(shot: Shot): string {
  const chunks: string[] = [];
  const push = (title: string, body: string | undefined) => {
    const t = (body ?? '').trim();
    if (t) chunks.push(`${title}\n${t}`);
  };
  push('画面', shot.shot_content);
  push('景别', shot.shot_type ?? '');
  push('运镜', shot.camera_movement ?? '');
  push('导演意图', shot.director_intent);
  push('动作', shot.action);
  push('台词', shot.dialogue);
  push('字幕', shot.subtitle_text);
  push('摄影', shot.camera_params);
  push('灯光', shot.lighting);
  push('影调', shot.color_tone);
  push('音效', shot.sound_design);
  push('AI 图像提示词', shot.ai_prompt);
  push('动效/视频提示词', shot.animation_prompt);
  return chunks.join('\n\n');
}

function mediaSrc(p: string): string {
  return p.startsWith('http') ? p : `file://${p}`;
}

const SHOT_TYPES = ['WS', 'MS', 'CU', 'ECU', 'OTS', 'POV', 'AERIAL', '其他'];
const CAM_MOVES = ['STATIC', 'PAN', 'TILT', 'DOLLY', 'CRANE', 'HANDHELD', '其他'];

/** Parse FastAPI error body for clearer messages */
function formatHttpError(body: string): string {
  const t = body.trim();
  try {
    const o = JSON.parse(t) as { detail?: string | string[] };
    const d = o.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d))
      return d.map((x) => (typeof x === 'object' && x && 'msg' in x ? String((x as { msg: string }).msg) : String(x))).join('；');
  } catch {
    /* raw text */
  }
  return t || '请求失败';
}

const SHOT_TYPE_BADGE: Record<string, string> = {
  WS: 'ws', MS: 'ms', CU: 'cu', ECU: 'ecu', OTS: 'ots', POV: 'pov', AERIAL: 'aerial', '其他': 'other',
};
const shotBadge = (t: string) => SHOT_TYPE_BADGE[t] ?? 'ms';

const EMPTY_SHOT_DEFAULTS: Omit<Shot, 'id' | 'scene_id'> = {
  shot_number: 1,
  timecode_in: '',
  timecode_out: '',
  duration_sec: 3,
  shot_content: '',
  shot_type: 'MS',
  camera_movement: 'STATIC',
  director_intent: '',
  camera_params: '',
  lighting: '',
  color_tone: '',
  sound_design: '',
  dialogue: '',
  subtitle_text: '',
  action: '',
  ai_prompt: '',
  animation_prompt: '',
  frame_images: '[]',
  video_paths: '[]',
  image_path: null,
  video_path: null,
};

// ── Episode grouping helpers ──────────────────────────────────────────────────

/** Extract episode key from a scene's location/description field.
 *  Understands: "EP01-S02", "第1集-场景", "1-03 ...", "EP02_S01" etc. */
function parseEpKey(scene: Scene): string {
  const loc = (scene.location || '').trim();
  const desc = (scene.description || '').trim();
  for (const s of [loc, desc]) {
    const m1 = s.match(/^EP(\d+)/i);
    if (m1) return `EP${m1[1].padStart(2, '0')}`;
    const m2 = s.match(/第\s*0*(\d+)\s*集/);
    if (m2) return `EP${m2[1].padStart(2, '0')}`;
    const m3 = s.match(/^(\d+)-\d/);
    if (m3) return `EP${m3[1].padStart(2, '0')}`;
  }
  return 'EP00'; // unclassified
}

function epKeyToLabel(key: string): string {
  if (key === 'EP00') return '未分集';
  const n = parseInt(key.slice(2), 10);
  return `第 ${n} 集`;
}

interface EpisodeGroup {
  key: string;
  label: string;
  scenes: Scene[];
}

function buildEpisodeGroups(scenes: Scene[]): EpisodeGroup[] {
  const map = new Map<string, Scene[]>();
  for (const s of scenes) {
    const k = parseEpKey(s);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(s);
  }
  // Sort by episode key; EP00 last
  const keys = [...map.keys()].sort((a, b) => {
    if (a === 'EP00') return 1;
    if (b === 'EP00') return -1;
    return a.localeCompare(b);
  });
  return keys.map((k) => ({ key: k, label: epKeyToLabel(k), scenes: map.get(k)! }));
}

// ─────────────────────────────────────────────────────────────────────────────

interface Props { projectId: number }

export default function StoryboardTab({ projectId }: Props) {
  const { confirm: appConfirm, alert: appAlert } = useAppDialog();
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [activeScene, setActiveScene] = useState<Scene | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [editingShot, setEditingShot] = useState<Shot | null>(null);
  const [shotDraft, setShotDraft] = useState<Partial<Shot>>({});
  const [generating, setGenerating] = useState<Record<number, boolean>>({});
  const [generatingVideo, setGeneratingVideo] = useState<Record<number, boolean>>({});
  const [error, setError] = useState('');
  const [showSceneForm, setShowSceneForm] = useState(false);
  const [sceneDraft, setSceneDraft] = useState({ scene_number: 1, location: '', time_of_day: 'DAY', description: '' });
  const [showJsonImport, setShowJsonImport] = useState(false);
  const [jsonImportText, setJsonImportText] = useState('');
  const [jsonImporting, setJsonImporting] = useState(false);

  // episode accordion state: set of open episode keys
  const [openEpisodes, setOpenEpisodes] = useState<Set<string>>(new Set());

  // 批量生成状态
  const [imageBatchLoading, setImageBatchLoading] = useState(false);
  const [videoBatchLoading, setVideoBatchLoading] = useState(false);
  const [batchJob, setBatchJob] = useState<BatchJobState | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);

  // 视图模式
  const [viewMode, setViewMode] = useState<'list' | 'grid4' | 'table'>('table');

  // Hyperframes 视频渲染
  const [renderBusy, setRenderBusy] = useState(false);
  const [renderPct, setRenderPct] = useState(0);
  const [renderLog, setRenderLog] = useState('');
  const [renderedVideos, setRenderedVideos] = useState<Array<{ name: string; relative: string; size_mb: number }>>([]);
  const [showVideoPanel, setShowVideoPanel] = useState(false);
  const [playingVideo, setPlayingVideo] = useState<string | null>(null);
  const [thumbPick, setThumbPick] = useState<Record<number, { v: number; i: number }>>({});
  /** 编辑弹窗内关键帧 / 视频轮播当前索引 */
  const [editKfCarouselIdx, setEditKfCarouselIdx] = useState(0);
  const [editVidCarouselIdx, setEditVidCarouselIdx] = useState(0);
  const kbUploadRef = useRef<HTMLInputElement | null>(null);
  const vidUploadRef = useRef<HTMLInputElement | null>(null);
  const shotUploadTargetRef = useRef<{ sceneId: number; shotId: number } | null>(null);
  const renderAbortRef = useRef<AbortController | null>(null);

  const imgCfg = useRef(loadImageApi());
  const activeSceneRef = useRef<Scene | null>(null);
  activeSceneRef.current = activeScene;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadScenes = useCallback(async () => {
    const base = await getBackendBase();
    const data = await apiFetch<{ scenes: Scene[] }>(base, `/api/projects/${projectId}/scenes`);
    const list = data.scenes;
    setScenes(list);
    setActiveScene((cur) => {
      if (list.length === 0) return null;
      if (!cur) return list[0];
      const fresh = list.find((s) => s.id === cur.id);
      return fresh ?? cur;
    });
  }, [projectId]);

  const loadShots = useCallback(async (sceneId: number) => {
    const base = await getBackendBase();
    const data = await apiFetch<{ shots: Shot[] }>(base, `/api/projects/${projectId}/scenes/${sceneId}/shots`);
    setShots(data.shots);
  }, [projectId]);

  // ── Derived episode groups ──────────────────────────────────────────────────
  const episodeGroups = buildEpisodeGroups(scenes);

  // Auto-open episode that contains the active scene; open first episode on load
  useEffect(() => {
    if (scenes.length === 0) return;
    const firstKey = parseEpKey(scenes[0]);
    setOpenEpisodes((prev) => {
      const next = new Set(prev);
      if (next.size === 0) next.add(firstKey);
      return next;
    });
  }, [scenes]);

  useEffect(() => {
    if (!activeScene) return;
    const key = parseEpKey(activeScene);
    setOpenEpisodes((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, [activeScene]);

  const toggleEpisode = (key: string) => {
    setOpenEpisodes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => { void loadScenes(); }, [loadScenes]);
  useEffect(() => {
    const fn = () => {
      void (async () => {
        await loadScenes();
        const cur = activeSceneRef.current;
        if (cur) await loadShots(cur.id);
      })();
    };
    window.addEventListener(EV_RELOAD_STORYBOARD, fn);
    return () => window.removeEventListener(EV_RELOAD_STORYBOARD, fn);
  }, [loadScenes, loadShots]);
  useEffect(() => { if (activeScene) void loadShots(activeScene.id); }, [activeScene, loadShots]);

  useEffect(() => {
    setEditKfCarouselIdx(0);
    setEditVidCarouselIdx(0);
  }, [editingShot?.id]);

  useEffect(() => {
    const n = parsePathJson(shotDraft.frame_images ?? '[]').length;
    setEditKfCarouselIdx((i) => Math.min(i, Math.max(0, n - 1)));
  }, [shotDraft.frame_images]);

  useEffect(() => {
    const n = parsePathJson((shotDraft as Shot).video_paths ?? '[]').length;
    setEditVidCarouselIdx((i) => Math.min(i, Math.max(0, n - 1)));
  }, [shotDraft.video_paths]);

  // ── 批量任务轮询 ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!batchJob) {
      if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }

    const doPoll = async () => {
      try {
        const base = await getBackendBase();
        const data = await apiFetch<{ status: string; total: number; success: number; failed: number }>(
          base,
          `/api/projects/${projectId}/generation-jobs/${batchJob.jobId}`,
        );
        setBatchProgress({ status: data.status, total: data.total, success: data.success, failed: data.failed });

        if (data.status !== 'running') {
          if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null; }
          const cur = activeSceneRef.current;
          if (cur?.id === batchJob.sceneId) void loadShots(cur.id);
          if (batchJob.type === 'image') setImageBatchLoading(false);
          else setVideoBatchLoading(false);
          setTimeout(() => { setBatchJob(null); setBatchProgress(null); }, 3000);
        }
      } catch { /* ignore transient poll errors */ }
    };

    void doPoll();
    pollRef.current = setInterval(() => { void doPoll(); }, 1500);
    return () => { if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null; } };
  // projectId and loadShots are stable; activeSceneRef is a ref (no re-render)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchJob]);

  const createScene = async () => {
    const base = await getBackendBase();
    const s = await apiFetch<Scene>(base, `/api/projects/${projectId}/scenes`, {
      method: 'POST',
      body: JSON.stringify(sceneDraft),
    });
    setScenes((prev) => [...prev, s].sort((a, b) => a.scene_number - b.scene_number));
    setActiveScene(s);
    setShowSceneForm(false);
  };

  const deleteScene = async (id: number) => {
    if (!(await appConfirm({ title: '删除场次', message: '确定删除该场次吗？其下所有镜头将一并从数据库移除，且不可恢复。', confirmLabel: '删除' }))) return;
    const base = await getBackendBase();
    await apiFetch(base, `/api/projects/${projectId}/scenes/${id}`, { method: 'DELETE' });
    setScenes((prev) => prev.filter((s) => s.id !== id));
    if (activeScene?.id === id) { setActiveScene(null); setShots([]); }
  };

  const addShot = async () => {
    if (!activeScene) return;
    const base = await getBackendBase();
    const nextNum = (shots[shots.length - 1]?.shot_number ?? 0) + 1;
    const s = await apiFetch<Shot>(base, `/api/projects/${projectId}/scenes/${activeScene.id}/shots`, {
      method: 'POST',
      body: JSON.stringify({ ...EMPTY_SHOT_DEFAULTS, shot_number: nextNum }),
    });
    setShots((prev) => [...prev, s]);
    setEditingShot(s);
    setShotDraft(s);
  };

  const saveShot = async () => {
    if (!editingShot || !activeScene) return;
    const base = await getBackendBase();
    const kfs = parsePathJson(shotDraft.frame_images ?? '[]');
    const vfs = parsePathJson((shotDraft as Shot).video_paths ?? '[]');
    const payload: Record<string, unknown> = { ...shotDraft };
    delete payload.id;
    delete payload.scene_id;
    payload.frame_images = JSON.stringify(kfs);
    payload.video_paths = JSON.stringify(vfs);
    payload.image_path = kfs[0] ?? null;
    payload.video_path = vfs[0] ?? null;
    const updated = await apiFetch<Shot>(
      base,
      `/api/projects/${projectId}/scenes/${activeScene.id}/shots/${editingShot.id}`,
      { method: 'PATCH', body: JSON.stringify(payload) },
    );
    setShots((prev) => prev.map((s) => s.id === updated.id ? updated : s));
    setEditingShot(null);
  };

  const deleteShot = async (shotId: number) => {
    if (!activeScene) return;
    if (!(await appConfirm({ title: '删除镜头', message: '确定删除该镜头吗？此操作不可恢复。', confirmLabel: '删除' }))) return;
    const base = await getBackendBase();
    await apiFetch(base, `/api/projects/${projectId}/scenes/${activeScene.id}/shots/${shotId}`, { method: 'DELETE' });
    setShots((prev) => prev.filter((s) => s.id !== shotId));
  };

  const generateImage = async (shot: Shot) => {
    const cfg = imgCfg.current;
    if (!cfg.apiKey || !cfg.baseUrl) {
      setError('请先在原版界面的「图片生成 API」配置 Base URL 和 API Key');
      return;
    }
    setGenerating((g) => ({ ...g, [shot.id]: true }));
    setError('');
    try {
      const url = `${cfg.baseUrl.replace(/\/+$/, '')}/${cfg.endpointPath.replace(/^\//, '')}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, prompt: shot.ai_prompt, n: 1, size: '1024x1024', response_format: 'url' }),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json() as { data: { url: string }[] };
      const imgUrl = json.data?.[0]?.url;
      if (!imgUrl) throw new Error('No image URL returned');

      const base = await getBackendBase();
      const merged = normalizeKeyframeUrls(shot);
      const nextFrames = JSON.stringify([imgUrl, ...merged.filter((x) => x !== imgUrl)]);
      const updated = await apiFetch<Shot>(
        base,
        `/api/projects/${projectId}/scenes/${shot.scene_id}/shots/${shot.id}`,
        { method: 'PATCH', body: JSON.stringify({ frame_images: nextFrames, image_path: imgUrl }) },
      );
      setThumbPick((tp) => ({ ...tp, [shot.id]: { v: tp[shot.id]?.v ?? 0, i: 0 } }));
      setShots((prev) => prev.map((s) => s.id === updated.id ? updated : s));
    } catch (e) { setError(String((e as Error).message)); }
    finally { setGenerating((g) => ({ ...g, [shot.id]: false })); }
  };

  const generateVideo = async (shot: Shot) => {
    setGeneratingVideo((g) => ({ ...g, [shot.id]: true }));
    setError('');
    try {
      const base = await getBackendBase();
      const updated = await apiFetch<Shot>(
        base,
        `/api/projects/${projectId}/shots/${shot.id}/generate-video`,
        { method: 'POST' },
      );
      setThumbPick((tp) => ({ ...tp, [shot.id]: { v: 0, i: tp[shot.id]?.i ?? 0 } }));
      setShots((prev) => prev.map((s) => s.id === updated.id ? updated : s));
    } catch (e) {
      const raw = String((e as Error).message);
      setError(
        `「AI 生成镜头视频」失败：${formatHttpError(raw)}\n` +
        '（此项需配置 media_providers.yaml 的视频 API；与工具栏「🎞 渲染视频」本地合成不同。）'
      );
    }
    finally { setGeneratingVideo((g) => ({ ...g, [shot.id]: false })); }
  };

  const synthesizeVoice = async (shot: Shot) => {
    const text = shot.subtitle_text || shot.dialogue || '';
    if (!text.trim()) {
      await appAlert({ title: '无法配音', message: '该镜头无台词/字幕文本' });
      return;
    }
    try {
      const base = await getBackendBase();
      await apiFetch(base, `/api/projects/${projectId}/shots/${shot.id}/synthesize-voice`, {
        method: 'POST',
        body: JSON.stringify({ text, voice: '', speed: 1.0, pitch: 0.0 }),
      });
      if (activeScene) void loadShots(activeScene.id);
    } catch {
      await appAlert({ title: 'TTS 失败', message: 'TTS 合成失败，请检查 media_providers.yaml 配置' });
    }
  };

  const batchSynthesizeVoice = async () => {
    if (!activeScene) return;
    try {
      const base = await getBackendBase();
      await apiFetch(base, `/api/projects/${projectId}/scenes/${activeScene.id}/synthesize-voice-batch`, {
        method: 'POST',
        body: JSON.stringify({ text: '', voice: '', speed: 1.0, pitch: 0.0 }),
      });
      void loadShots(activeScene.id);
    } catch {
      await appAlert({ title: '批量配音失败', message: '请检查后端与 media_providers.yaml 配置' });
    }
  };

  const batchGenerateImages = async () => {
    if (!activeScene) return;
    setImageBatchLoading(true);
    setError('');
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ job_id: number; total: number }>(
        base,
        `/api/projects/${projectId}/scenes/${activeScene.id}/generate-images-batch`,
        { method: 'POST' },
      );
      setBatchJob({ jobId: data.job_id, type: 'image', sceneId: activeScene.id });
      setBatchProgress({ status: 'running', total: data.total, success: 0, failed: 0 });
    } catch (e) {
      setError(String((e as Error).message));
      setImageBatchLoading(false);
    }
  };

  const batchGenerateVideos = async () => {
    if (!activeScene) return;
    setVideoBatchLoading(true);
    setError('');
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ job_id: number; total: number }>(
        base,
        `/api/projects/${projectId}/scenes/${activeScene.id}/generate-videos-batch`,
        { method: 'POST' },
      );
      setBatchJob({ jobId: data.job_id, type: 'video', sceneId: activeScene.id });
      setBatchProgress({ status: 'running', total: data.total, success: 0, failed: 0 });
    } catch (e) {
      const raw = String((e as Error).message);
      setError(
        `「批量 AI 出视频」失败：${formatHttpError(raw)}\n` +
        '（需配置 media_providers.yaml 的视频 Provider。）'
      );
      setVideoBatchLoading(false);
    }
  };

  const loadRenderedVideos = useCallback(async () => {
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ videos: Array<{ name: string; relative: string; size_mb: number }> }>(
        base, `/api/projects/${projectId}/video/list`
      );
      setRenderedVideos(data.videos || []);
    } catch { /* ignore */ }
  }, [projectId]);

  const renderSceneVideo = async () => {
    if (!activeScene || renderBusy) return;
    setError('');
    setRenderBusy(true);
    setRenderPct(0);
    const logLines: string[] = [];
    setRenderLog('准备渲染…');
    setShowVideoPanel(true);

    const ac = new AbortController();
    renderAbortRef.current = ac;

    try {
      const base = await getBackendBase();
      const res = await fetch(`${base}/api/projects/${projectId}/video/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene_id: activeScene.id }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(await res.text());
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop() || '';
        for (const block of lines) {
          const dataLine = block.replace(/^data:\s?/, '').trim();
          if (!dataLine) continue;
          try {
            const ev = JSON.parse(dataLine) as Record<string, unknown>;
            if (ev.type === 'progress') {
              setRenderPct(Number(ev.pct) || 0);
              const ln = String(ev.line || '');
              if (ln) {
                logLines.push(ln);
                setRenderLog(logLines.slice(-50).join('\n'));
              }
            } else if (ev.type === 'log') {
              const ln = String(ev.line || '');
              if (ln) {
                logLines.push(ln);
                setRenderLog(logLines.slice(-50).join('\n'));
              }
            } else if (ev.type === 'done') {
              setRenderPct(100);
              setRenderLog(`渲染完成 (${ev.size_mb}MB)`);
              void loadRenderedVideos();
            } else if (ev.type === 'error') {
              const tail = logLines.slice(-35).join('\n');
              const msg = String(ev.message || '');
              setRenderLog(tail ? `${tail}\n\n错误: ${msg}` : `错误: ${msg}`);
            }
          } catch { /* skip invalid JSON */ }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setRenderLog(`渲染失败: ${String((e as Error).message)}`);
      }
    } finally {
      setRenderBusy(false);
      renderAbortRef.current = null;
    }
  };

  const renderEpisodeVideo = async (epKey: string) => {
    if (renderBusy) return;
    const epNum = parseInt(epKey.replace('EP', ''), 10);
    if (!epNum) return;

    setError('');
    setRenderBusy(true);
    setRenderPct(0);
    const logLines: string[] = [];
    setRenderLog(`正在渲染第 ${epNum} 集…`);
    setShowVideoPanel(true);

    const ac = new AbortController();
    renderAbortRef.current = ac;

    try {
      const base = await getBackendBase();
      const res = await fetch(`${base}/api/projects/${projectId}/video/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episode: epNum }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(await res.text());
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop() || '';
        for (const block of lines) {
          const dataLine = block.replace(/^data:\s?/, '').trim();
          if (!dataLine) continue;
          try {
            const ev = JSON.parse(dataLine) as Record<string, unknown>;
            if (ev.type === 'progress') {
              setRenderPct(Number(ev.pct) || 0);
              const ln = String(ev.line || '');
              if (ln) {
                logLines.push(ln);
                setRenderLog(logLines.slice(-50).join('\n'));
              }
            } else if (ev.type === 'log') {
              const ln = String(ev.line || '');
              if (ln) {
                logLines.push(ln);
                setRenderLog(logLines.slice(-50).join('\n'));
              }
            } else if (ev.type === 'done') {
              setRenderPct(100);
              setRenderLog(`渲染完成 (${ev.size_mb}MB)`);
              void loadRenderedVideos();
            } else if (ev.type === 'error') {
              const tail = logLines.slice(-35).join('\n');
              const msg = String(ev.message || '');
              setRenderLog(tail ? `${tail}\n\n错误: ${msg}` : `错误: ${msg}`);
            }
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setRenderLog(`渲染失败: ${String((e as Error).message)}`);
      }
    } finally {
      setRenderBusy(false);
      renderAbortRef.current = null;
    }
  };

  const stopRender = () => {
    renderAbortRef.current?.abort();
    renderAbortRef.current = null;
    setRenderBusy(false);
    setRenderLog('已中止');
  };

  const copyPrompt = (p: string) => void navigator.clipboard.writeText(p);

  const importFromJson = async () => {
    if (!jsonImportText.trim()) return;
    setJsonImporting(true);
    try {
      const n = await importStoryboardFromPhase(projectId, jsonImportText);
      await loadScenes();
      setShowJsonImport(false);
      setJsonImportText('');
      await appAlert({ title: '导入完成', message: `成功导入 ${n} 个镜头` });
    } catch (e) {
      await appAlert({ title: '导入失败', message: String((e as Error).message) });
    } finally {
      setJsonImporting(false);
    }
  };

  const openShotEditor = (shot: Shot) => {
    setEditingShot(shot);
    const kfs = normalizeKeyframeUrls(shot);
    const vfs = normalizeVideoUrls(shot);
    setShotDraft({ ...shot, frame_images: JSON.stringify(kfs), video_paths: JSON.stringify(vfs) });
  };

  const runUploadKeyframe = async (sceneId: number, shotId: number, file: File) => {
    const base = await getBackendBase();
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(
      `${base}/api/projects/${projectId}/scenes/${sceneId}/shots/${shotId}/upload-keyframe`,
      { method: 'POST', body: fd },
    );
    if (!res.ok) throw new Error(await res.text());
    const updated = await res.json() as Shot;
    setShots((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    if (editingShot?.id === shotId) openShotEditor(updated);
  };

  const runUploadShotVideo = async (sceneId: number, shotId: number, file: File) => {
    const base = await getBackendBase();
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(
      `${base}/api/projects/${projectId}/scenes/${sceneId}/shots/${shotId}/upload-video`,
      { method: 'POST', body: fd },
    );
    if (!res.ok) throw new Error(await res.text());
    const updated = await res.json() as Shot;
    setShots((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    if (editingShot?.id === shotId) openShotEditor(updated);
  };

  const pickThumbIndex = (raw: number, len: number) => {
    if (len <= 0) return 0;
    return ((raw % len) + len) % len;
  };

  const cycleShotThumb = (shotId: number, delta: number, shot: Shot) => {
    const vids = normalizeVideoUrls(shot);
    const kfs = normalizeKeyframeUrls(shot);
    setThumbPick((prev) => {
      const cur = prev[shotId] ?? { v: 0, i: 0 };
      if (vids.length > 1) return { ...prev, [shotId]: { ...cur, v: cur.v + delta } };
      if (!vids.length && kfs.length > 1) return { ...prev, [shotId]: { ...cur, i: cur.i + delta } };
      return prev;
    });
  };

  const renderShotStillOrVideoEl = (shot: Shot, imgCls: string, vidCls: string, autoplayVideo: boolean) => {
    const picks = thumbPick[shot.id] ?? { v: 0, i: 0 };
    const vids = normalizeVideoUrls(shot);
    const kfs = normalizeKeyframeUrls(shot);
    const vi = pickThumbIndex(picks.v, vids.length);
    const ii = pickThumbIndex(picks.i, kfs.length);
    if (vids.length > 0) {
      return (
        <video className={vidCls} src={mediaSrc(vids[vi])} autoPlay={autoplayVideo} loop muted playsInline />
      );
    }
    if (kfs.length > 0) {
      return <img className={imgCls} src={mediaSrc(kfs[ii])} alt={`镜头 ${shot.shot_number}`} />;
    }
    return null;
  };

  const renderShotThumbNavEl = (shot: Shot) => {
    const vids = normalizeVideoUrls(shot);
    const kfs = normalizeKeyframeUrls(shot);
    const picks = thumbPick[shot.id] ?? { v: 0, i: 0 };
    const multiV = vids.length > 1;
    const multiK = vids.length === 0 && kfs.length > 1;
    const countLine = (vids.length > 0 || kfs.length > 0) ? (
      <div className="sb-thumb-count">
        {vids.length > 0 ? `${vids.length} 视频` : ''}
        {vids.length > 0 && kfs.length > 0 ? ' · ' : ''}
        {kfs.length > 0 ? `${kfs.length} 关键帧` : ''}
      </div>
    ) : null;
    if (multiV || multiK) {
      const label = multiV
        ? `${pickThumbIndex(picks.v, vids.length) + 1}/${vids.length}`
        : `${pickThumbIndex(picks.i, kfs.length) + 1}/${kfs.length}`;
      return (
        <div className="sb-thumb-below">
          {countLine}
          <div className="sb-thumb-nav">
            <button type="button" className="sb-thumb-nav__btn" onClick={(e) => { e.stopPropagation(); cycleShotThumb(shot.id, -1, shot); }}>◀</button>
            <span className="sb-thumb-nav__label">{label}</span>
            <button type="button" className="sb-thumb-nav__btn" onClick={(e) => { e.stopPropagation(); cycleShotThumb(shot.id, 1, shot); }}>▶</button>
          </div>
        </div>
      );
    }
    if (countLine) return <div className="sb-thumb-below">{countLine}</div>;
    return null;
  };

  const triggerShotKeyframeUpload = (e: React.MouseEvent, shot: Shot) => {
    e.stopPropagation();
    shotUploadTargetRef.current = { sceneId: shot.scene_id, shotId: shot.id };
    kbUploadRef.current?.click();
  };

  const triggerShotVideoUpload = (e: React.MouseEvent, shot: Shot) => {
    e.stopPropagation();
    shotUploadTargetRef.current = { sceneId: shot.scene_id, shotId: shot.id };
    vidUploadRef.current?.click();
  };

  const handleShotKeyframeFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const t = shotUploadTargetRef.current;
    e.target.value = '';
    if (!file || !t) return;
    try {
      await runUploadKeyframe(t.sceneId, t.shotId, file);
    } catch (err) {
      setError(String((err as Error).message));
    }
  };

  const handleShotVideoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const t = shotUploadTargetRef.current;
    e.target.value = '';
    if (!file || !t) return;
    try {
      await runUploadShotVideo(t.sceneId, t.shotId, file);
    } catch (err) {
      setError(String((err as Error).message));
    }
  };

  // ── 参考帧图片辅助 ───────────────────────────────────────────────────────
  const addFrameImage = (url: string) => {
    const cur = parsePathJson(shotDraft.frame_images ?? '[]');
    const next = [url, ...cur.filter((x) => x !== url)];
    setShotDraft((d) => ({ ...d, frame_images: JSON.stringify(next) }));
    setEditKfCarouselIdx(0);
  };

  const removeFrameImage = async (idx: number) => {
    if (!(await appConfirm({ title: '移除关键帧', message: '确定移除该关键帧吗？（保存镜头后才会写入数据库）', confirmLabel: '移除' }))) return;
    const cur = parsePathJson(shotDraft.frame_images ?? '[]');
    cur.splice(idx, 1);
    setShotDraft((d) => ({ ...d, frame_images: JSON.stringify(cur) }));
  };

  const promoteFrameImage = (idx: number) => {
    const cur = parsePathJson(shotDraft.frame_images ?? '[]');
    if (idx <= 0 || idx >= cur.length) return;
    const [item] = cur.splice(idx, 1);
    cur.unshift(item);
    setShotDraft((d) => ({ ...d, frame_images: JSON.stringify(cur) }));
  };

  const addVideoPathDraft = (url: string) => {
    const cur = parsePathJson((shotDraft as Shot).video_paths ?? '[]');
    const next = [url, ...cur.filter((x) => x !== url)];
    setShotDraft((d) => ({ ...d, video_paths: JSON.stringify(next) } as Partial<Shot>));
    setEditVidCarouselIdx(0);
  };

  const removeVideoPathDraft = async (idx: number) => {
    if (!(await appConfirm({ title: '移除视频', message: '确定移除该视频条目吗？（保存后写入数据库）', confirmLabel: '移除' }))) return;
    const cur = parsePathJson((shotDraft as Shot).video_paths ?? '[]');
    cur.splice(idx, 1);
    setShotDraft((d) => ({ ...d, video_paths: JSON.stringify(cur) } as Partial<Shot>));
  };

  const promoteVideoPathDraft = (idx: number) => {
    const cur = parsePathJson((shotDraft as Shot).video_paths ?? '[]');
    if (idx <= 0 || idx >= cur.length) return;
    const [item] = cur.splice(idx, 1);
    cur.unshift(item);
    setShotDraft((d) => ({ ...d, video_paths: JSON.stringify(cur) } as Partial<Shot>));
  };

  const patch = <K extends keyof Shot>(key: K, val: Shot[K]) =>
    setShotDraft((d) => ({ ...d, [key]: val }));

  // ── 批量进度条渲染辅助 ────────────────────────────────────────────────────
  const renderBatchProgress = () => {
    if (!batchProgress || !batchJob || batchJob.sceneId !== activeScene?.id) return null;
    const { status, total, success, failed } = batchProgress;
    const done = success + failed;
    const pct = total > 0 ? (done / total) * 100 : 0;

    return (
      <div className="sb-batch-progress">
        {status === 'running' ? (
          <>
            <span>生成中 {done}/{total} 镜头…</span>
            <div className="sb-batch-progress__bar">
              <div className="sb-batch-progress__fill" style={{ width: `${pct}%` }} />
            </div>
          </>
        ) : (
          <span className={failed > 0 ? 'sb-batch-progress__error' : 'sb-batch-progress__done'}>
            {failed > 0
              ? `✓ 完成 ${success}/${total}（${failed} 失败）`
              : `✓ 完成 ${success}/${total}`}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="sb-tab">
      {/* ── 场次侧栏（按集数分组）── */}
      <aside className="sb-tab__scenes">
        <div className="sb-tab__scenes-head">
          <span className="section-title">分镜场次</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="btn-icon" onClick={() => setShowJsonImport(true)} title="粘贴分镜JSON导入">⬇</button>
            <button className="btn-icon" onClick={() => setShowSceneForm(true)} title="新建场次">＋</button>
          </div>
        </div>

        <div className="sb-ep-groups">
          {episodeGroups.length === 0 && (
            <div className="scene-list__empty">暂无场次，点击 ⬇ 导入或 ＋ 新建</div>
          )}

          {episodeGroups.map((group) => {
            const isOpen = openEpisodes.has(group.key);
            const sceneCount = group.scenes.length;
            const shotCountHint = ''; // optional: could sum shots but requires extra fetches
            return (
              <div key={group.key} className="sb-ep-group">
                {/* Episode accordion header */}
                <button
                  className={`sb-ep-group__header${isOpen ? ' sb-ep-group__header--open' : ''}`}
                  onClick={() => toggleEpisode(group.key)}
                  title={`${group.label}（${sceneCount} 场）`}
                >
                  <span className="sb-ep-group__arrow">{isOpen ? '▾' : '▸'}</span>
                  <span className="sb-ep-group__label">{group.label}</span>
                  <span className="sb-ep-group__count">{sceneCount} 场{shotCountHint}</span>
                </button>
                {group.key !== 'EP00' && (
                  <button
                    className="sb-ep-group__render-btn"
                    disabled={renderBusy}
                    onClick={(e) => { e.stopPropagation(); void renderEpisodeVideo(group.key); }}
                    title={`渲染${group.label}的分镜视频`}
                  >
                    🎞
                  </button>
                )}

                {/* Scene list drawer */}
                {isOpen && (
                  <ul className="scene-list scene-list--nested">
                    {group.scenes
                      .slice()
                      .sort((a, b) => a.scene_number - b.scene_number)
                      .map((s) => {
                        // Strip episode prefix from location for display
                        const displayLoc = (s.location || '')
                          .replace(/^EP\d+-?/i, '')
                          .replace(/^第\s*\d+\s*集[-·]?/, '')
                          .trim() || '（未命名）';
                        return (
                          <li
                            key={s.id}
                            className={`scene-list__item${activeScene?.id === s.id ? ' scene-list__item--active' : ''}`}
                            onClick={() => setActiveScene(s)}
                          >
                            <span className="scene-list__num">场 {s.scene_number}</span>
                            <span className="scene-list__loc">{displayLoc}</span>
                            <button
                              className="scene-list__del"
                              onClick={(e) => { e.stopPropagation(); void deleteScene(s.id); }}
                            >×</button>
                          </li>
                        );
                      })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* ── 分镜板主区域 ── */}
      <div className="sb-tab__board">
        {error && <div className="error">{error}</div>}

        {activeScene ? (
          <>
            <div className="sb-tab__board-head">
              <h3 className="sb-tab__scene-title">
                场 {activeScene.scene_number}
                {activeScene.location ? ` — ${activeScene.location}` : ''}
                {activeScene.time_of_day ? ` (${activeScene.time_of_day})` : ''}
              </h3>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  className="btn-ghost btn-sm"
                  disabled={imageBatchLoading || videoBatchLoading}
                  onClick={() => void batchGenerateImages()}
                  title="对该场次所有含 AI 提示词的镜头批量生成图片"
                >
                  {imageBatchLoading ? '生成中…' : '🖼 批量出图'}
                </button>
                <button
                  className="btn-ghost btn-sm"
                  disabled={imageBatchLoading || videoBatchLoading}
                  onClick={() => void batchGenerateVideos()}
                  title="调用 media_providers.yaml 中配置的「视频 API」为各镜头生成小片段（与下方「渲染视频」本地合成不同）"
                >
                  {videoBatchLoading ? '生成中…' : '🎬 批量出视频'}
                </button>
                <button
                  className="btn-ghost btn-sm"
                  title="导出该场次字幕为 SRT 文件"
                  onClick={async () => {
                    const base = await getBackendBase();
                    const url = `${base}/api/projects/${projectId}/scenes/${activeScene.id}/export-srt`;
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `scene_${activeScene.id}.srt`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                  }}
                >
                  📄 导出字幕
                </button>
                <button
                  className="btn-ghost btn-sm"
                  title="对该场次所有含台词/字幕的镜头批量合成语音"
                  onClick={() => void batchSynthesizeVoice()}
                >
                  🎙 批量配音
                </button>
                <button
                  className="btn-ghost btn-sm"
                  disabled={renderBusy}
                  onClick={() => void renderSceneVideo()}
                  title="用 Hyperframes 将该场次分镜渲染为 MP4 视频"
                >
                  {renderBusy ? '渲染中…' : '🎞 渲染视频'}
                </button>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => { setShowVideoPanel((v) => !v); void loadRenderedVideos(); }}
                  title="查看已渲染的视频"
                >
                  📂 视频库
                </button>
                <div className="tl-toolbar__view-toggle">
                  <button
                    className={`btn-ghost btn-sm${viewMode === 'table' ? ' btn-active' : ''}`}
                    onClick={() => setViewMode('table')}
                    title="分镜表格模式"
                  >⊟</button>
                  <button
                    className={`btn-ghost btn-sm${viewMode === 'list' ? ' btn-active' : ''}`}
                    onClick={() => setViewMode('list')}
                    title="卡片模式"
                  >☰</button>
                  <button
                    className={`btn-ghost btn-sm${viewMode === 'grid4' ? ' btn-active' : ''}`}
                    onClick={() => setViewMode('grid4')}
                    title="四宫格模式"
                  >⊞</button>
                </div>
                <button className="btn-primary" onClick={() => void addShot()}>+ 添加镜头</button>
              </div>
            </div>

            {renderBatchProgress()}

            {/* ── 列表模式 ── */}
            {viewMode === 'list' && (
              <div className="sb-grid">
                {shots.map((shot) => (
                  <div
                    key={shot.id}
                    className="sb-cell"
                    role="button"
                    tabIndex={0}
                    onClick={() => openShotEditor(shot)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openShotEditor(shot);
                      }
                    }}
                  >
                    {/* 图片/视频区 */}
                    <div className="sb-cell__img-wrap">
                      <div className="sb-cell__media-fill">
                        {renderShotStillOrVideoEl(shot, 'sb-cell__img', 'sb-cell__video', true) || (
                          <div className="sb-cell__img-placeholder">
                            <span>{shot.shot_type || 'SHOT'}</span>
                          </div>
                        )}
                      </div>
                      <div className="sb-cell__thumb-strip">{renderShotThumbNavEl(shot)}</div>
                      <div className="sb-cell__overlay">
                        <button
                          type="button"
                          className="sb-cell__gen-btn"
                          onClick={(e) => { e.stopPropagation(); void generateImage(shot); }}
                          disabled={generating[shot.id] || !shot.ai_prompt}
                          title={shot.ai_prompt ? '追加生成关键帧' : '请先填写 AI 提示词'}
                        >
                          {generating[shot.id] ? '生成中…' : '✦ 生成图片'}
                        </button>
                        <button
                          type="button"
                          className="sb-cell__gen-btn"
                          style={{ marginLeft: '6px' }}
                          onClick={(e) => { e.stopPropagation(); void generateVideo(shot); }}
                          disabled={generatingVideo[shot.id]}
                          title="追加生成视频"
                        >
                          {generatingVideo[shot.id] ? '生成中…' : '▶ 生成视频'}
                        </button>
                        <button
                          type="button"
                          className="sb-cell__gen-btn"
                          style={{ marginLeft: '6px' }}
                          onClick={(e) => triggerShotKeyframeUpload(e, shot)}
                          title="上传关键帧"
                        >
                          📷
                        </button>
                        <button
                          type="button"
                          className="sb-cell__gen-btn"
                          style={{ marginLeft: '6px' }}
                          onClick={(e) => triggerShotVideoUpload(e, shot)}
                          title="上传镜头视频"
                        >
                          🎞
                        </button>
                        <button
                          type="button"
                          className="sb-cell__gen-btn"
                          style={{ marginLeft: '6px' }}
                          onClick={(e) => { e.stopPropagation(); void synthesizeVoice(shot); }}
                          title="合成语音"
                        >
                          🎙
                        </button>
                      </div>
                    </div>

                    {/* 信息区 */}
                    <div className="sb-cell__info">
                      <div className="sb-cell__meta">
                        <span className="sb-cell__num">#{shot.shot_number}</span>
                        <span className="sb-cell__type">{shot.shot_type}</span>
                        <span className="sb-cell__cam">{shot.camera_movement}</span>
                        <span className="sb-cell__dur">{shot.duration_sec}s</span>
                      </div>
                      {/* 摘要字段（折叠显示） */}
                      {(shot.timecode_in || shot.timecode_out) && (
                        <p className="sb-cell__meta-extra">
                          🕐 {shot.timecode_in || '—'} → {shot.timecode_out || '—'}
                        </p>
                      )}
                      {shot.shot_content && (
                        <p className="sb-cell__action">{shot.shot_content.slice(0, 60)}{shot.shot_content.length > 60 ? '…' : ''}</p>
                      )}
                      {!shot.shot_content && shot.action && <p className="sb-cell__action">{shot.action}</p>}
                      {shot.lighting && <p className="sb-cell__meta-extra">💡 {shot.lighting.slice(0, 40)}{shot.lighting.length > 40 ? '…' : ''}</p>}
                      {shot.sound_design && <p className="sb-cell__meta-extra">🔊 {shot.sound_design.slice(0, 40)}{shot.sound_design.length > 40 ? '…' : ''}</p>}
                      {shot.dialogue && <p className="sb-cell__dialogue">"{shot.dialogue}"</p>}
                      {shot.ai_prompt && (
                        <div className="sb-cell__prompt" title={shot.ai_prompt}>
                          <span className="sb-cell__prompt-text">{shot.ai_prompt.slice(0, 60)}{shot.ai_prompt.length > 60 ? '…' : ''}</span>
                          <button
                            type="button"
                            className="btn-icon btn-xs"
                            onClick={(e) => { e.stopPropagation(); copyPrompt(shot.ai_prompt); }}
                            title="复制提示词"
                          >
                            ⎘
                          </button>
                        </div>
                      )}
                      <div className="sb-cell__actions">
                        <button type="button" className="btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); openShotEditor(shot); }}>编辑</button>
                        <button type="button" className="btn-danger btn-sm" onClick={(e) => { e.stopPropagation(); void deleteShot(shot.id); }}>删除</button>
                      </div>
                    </div>
                  </div>
                ))}
                {shots.length === 0 && <div className="sb-grid__empty">该场次还没有镜头，点击「添加镜头」</div>}
              </div>
            )}

            {/* ── 四宫格模式 ── */}
            {viewMode === 'grid4' && (
              <div className="sb-grid sb-grid--4col">
                {shots.map((shot) => (
                  <div
                    key={shot.id}
                    className="sb-cell sb-cell--compact"
                    onClick={() => openShotEditor(shot)}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') openShotEditor(shot); }}
                  >
                    <div className="sb-cell__compact-visual">
                      {renderShotStillOrVideoEl(shot, 'sb-cell__thumb', 'sb-cell__thumb', false) || (
                        <div className="sb-cell__placeholder">📷</div>
                      )}
                    </div>
                    {renderShotThumbNavEl(shot)}
                    <div className="sb-cell__compact-info">
                      <span className="sb-cell__num">#{shot.shot_number}</span>
                      <span className="sb-cell__type">{shot.shot_type || ''}</span>
                    </div>
                    {shot.dialogue && (
                      <div className="sb-cell__dialogue-preview">
                        {shot.dialogue.slice(0, 20)}{shot.dialogue.length > 20 ? '…' : ''}
                      </div>
                    )}
                  </div>
                ))}
                {shots.length === 0 && <div className="sb-grid__empty">该场次还没有镜头，点击「添加镜头」</div>}
              </div>
            )}

            {/* ── 专业分镜表格模式 ── */}
            {viewMode === 'table' && (
              <div className="sbt-wrap">
                {shots.length > 0 && (
                  <div className="sbt-cards__legend" aria-hidden>
                    <span className="sbt-cards__legend-cell">序号 · 预览</span>
                    <span className="sbt-cards__legend-cell">画面 · 参数 · 操作</span>
                  </div>
                )}
                <div className="sbt-cards" role="list">
                  {shots.map((shot) => (
                    <div
                      key={shot.id}
                      className="sbt-card"
                      role="listitem"
                      onClick={() => openShotEditor(shot)}
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') openShotEditor(shot); }}
                    >
                      <div className="sbt-card__viz">
                        <div className="sbt-card__viz-inner" onClick={(e) => e.stopPropagation()}>
                          <div className="sbt__thumb-wrap">
                            {renderShotStillOrVideoEl(shot, 'sbt__thumb', 'sbt__thumb', true) || (
                              <div className="sbt__thumb-empty">
                                <span className="sbt__thumb-type">{shot.shot_type || '📷'}</span>
                              </div>
                            )}
                            {renderShotThumbNavEl(shot)}
                            <button
                              className="sbt__gen-btn"
                              onClick={(e) => { e.stopPropagation(); void generateImage(shot); }}
                              disabled={generating[shot.id] || !shot.ai_prompt}
                              title={shot.ai_prompt ? '追加生成关键帧' : '请先填写 AI 提示词'}
                            >
                              {generating[shot.id] ? '…' : '✦'}
                            </button>
                          </div>
                        </div>
                        <div className="sbt-card__aside-meta">
                          <span className="sbt__shot-num">#{shot.shot_number}</span>
                          {(shot.timecode_in || shot.timecode_out) && (
                            <span className="sbt__tc">
                              {shot.timecode_in || '—'} · {shot.timecode_out || '—'}
                            </span>
                          )}
                          <span className="sbt__dur">{shot.duration_sec}s</span>
                          <div className="sbt-card__badges">
                            <span className={`sbt__badge sbt__badge--${shotBadge(shot.shot_type)}`}>
                              {shot.shot_type || 'MS'}
                            </span>
                            <span className="sbt__cam-tag">{shot.camera_movement || 'STATIC'}</span>
                          </div>
                        </div>
                      </div>

                      <div className="sbt-card__main">
                        <div className="sbt-card__copy">
                          <div className="sbt__line1">
                            <span className="sbt__content">
                              {shot.shot_content || shot.action || <span className="sbt__muted">暂无画面描述</span>}
                            </span>
                          </div>
                          {(shot.director_intent || (shot.action && shot.shot_content) || shot.dialogue) && (
                            <div className="sbt__line2">
                              {shot.director_intent && (
                                <span className="sbt__intent">{shot.director_intent}</span>
                              )}
                              {shot.action && shot.shot_content && (
                                <span className="sbt__action-tag">△ {shot.action}</span>
                              )}
                              {shot.dialogue && (
                                <span className="sbt__dialogue">「{shot.dialogue}」</span>
                              )}
                            </div>
                          )}
                          {(shot.camera_params || shot.lighting || shot.color_tone || shot.ai_prompt) && (
                            <div className="sbt__line3">
                              {shot.camera_params && (
                                <span className="sbt__param">📷 {shot.camera_params}</span>
                              )}
                              {shot.lighting && (
                                <span className="sbt__param">💡 {shot.lighting}</span>
                              )}
                              {shot.color_tone && (
                                <span className="sbt__param">🎨 {shot.color_tone}</span>
                              )}
                              {shot.ai_prompt && (
                                <span
                                  className="sbt__param sbt__param--prompt"
                                  title={shot.ai_prompt}
                                  onClick={(e) => { e.stopPropagation(); copyPrompt(shot.ai_prompt); }}
                                >
                                  AI: {shot.ai_prompt.slice(0, 80)}{shot.ai_prompt.length > 80 ? '…' : ''}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="sbt-card__ops" onClick={(e) => e.stopPropagation()} role="group" aria-label="镜头操作">
                          <button
                            className="sbt__op-chip"
                            type="button"
                            title="一键复制所有提示词（画面、参数、台词、AI 等）"
                            disabled={!buildShotAllPromptsText(shot)}
                            onClick={(e) => {
                              e.stopPropagation();
                              const t = buildShotAllPromptsText(shot);
                              if (t) copyPrompt(t);
                            }}
                          >
                            <span className="sbt__op-chip__glyph" aria-hidden>⎘</span>
                            <span>复制全部</span>
                          </button>
                          <button
                            className="sbt__op-chip"
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void generateVideo(shot); }}
                            disabled={generatingVideo[shot.id]}
                          >
                            <span className="sbt__op-chip__glyph" aria-hidden>▶</span>
                            <span>出视频</span>
                          </button>
                          <button
                            className="sbt__op-chip"
                            type="button"
                            onClick={(e) => triggerShotKeyframeUpload(e, shot)}
                          >
                            <span className="sbt__op-chip__glyph" aria-hidden>📷</span>
                            <span>上传关键帧</span>
                          </button>
                          <button
                            className="sbt__op-chip"
                            type="button"
                            onClick={(e) => triggerShotVideoUpload(e, shot)}
                          >
                            <span className="sbt__op-chip__glyph" aria-hidden>🎞</span>
                            <span>上传视频</span>
                          </button>
                          <button
                            className="sbt__op-chip"
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void synthesizeVoice(shot); }}
                          >
                            <span className="sbt__op-chip__glyph" aria-hidden>🎙</span>
                            <span>配音</span>
                          </button>
                          <button
                            className="sbt__op-chip"
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openShotEditor(shot); }}
                          >
                            <span className="sbt__op-chip__glyph" aria-hidden>✎</span>
                            <span>编辑</span>
                          </button>
                          <button
                            className="sbt__op-chip sbt__op-chip--del"
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void deleteShot(shot.id); }}
                          >
                            <span className="sbt__op-chip__glyph" aria-hidden>×</span>
                            <span>删除</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {shots.length === 0 && <div className="sb-grid__empty">该场次还没有镜头，点击「添加镜头」</div>}
              </div>
            )}
          </>
        ) : (
          <div className="sb-tab__no-scene">请从左侧选择或新建场次</div>
        )}
      </div>

      {/* 视频渲染面板 */}
      {showVideoPanel && (
        <div className="modal-overlay" onClick={() => !renderBusy && setShowVideoPanel(false)}>
          <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">视频渲染（Hyperframes）</h2>

            {renderBusy && (
              <div className="hf-render-progress">
                <div className="hf-render-progress__bar-wrap">
                  <div className="hf-render-progress__bar" style={{ width: `${renderPct}%` }} />
                </div>
                <div className="hf-render-progress__row-actions">
                  <span className="hf-render-progress__pct">{renderPct}%</span>
                  <button type="button" className="btn-ghost btn-sm" onClick={stopRender}>中止</button>
                </div>
                {renderLog ? (
                  <div className="hf-render-progress__log">{renderLog}</div>
                ) : null}
              </div>
            )}
            {!renderBusy && renderLog && (
              <div
                className={`hf-render-progress__log hf-render-progress__log--block${renderLog.includes('失败') ? ' hf-render-progress__log--error' : ''}`}
                style={{ marginBottom: 12 }}
              >
                {renderLog}
              </div>
            )}

            <div className="hf-video-list">
              <div className="hf-video-list__head">
                <span>已渲染视频</span>
                <button className="btn-ghost btn-sm" onClick={() => void loadRenderedVideos()}>刷新</button>
              </div>
              {renderedVideos.length === 0 ? (
                <div className="hf-video-list__empty">暂无渲染视频。选择场次或集数后点击「渲染视频」。</div>
              ) : (
                <div className="hf-video-list__items">
                  {renderedVideos.map((v) => (
                    <div key={v.name} className="hf-video-list__item">
                      <span className="hf-video-list__name">{v.name}</span>
                      <span className="hf-video-list__size">{v.size_mb}MB</span>
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() => setPlayingVideo(playingVideo === v.relative ? null : v.relative)}
                      >
                        {playingVideo === v.relative ? '收起' : '播放'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {playingVideo && (
                <div className="hf-video-player">
                  <video
                    controls
                    autoPlay
                    style={{ width: '100%', maxHeight: '60vh', background: '#000', borderRadius: 8 }}
                    src={`file://${renderedVideos.find((v) => v.relative === playingVideo)?.name ? '' : ''}${playingVideo}`}
                    onError={() => setPlayingVideo(null)}
                  >
                    浏览器不支持该视频格式
                  </video>
                </div>
              )}
            </div>

            <div className="modal__actions">
              <button className="btn-ghost" onClick={() => setShowVideoPanel(false)} disabled={renderBusy}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* JSON 粘贴导入弹窗 */}
      {showJsonImport && (
        <div className="modal-overlay" onClick={() => setShowJsonImport(false)}>
          <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">粘贴分镜 JSON 导入</h2>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              将 LLM 生成的分镜 JSON 数组（或包含 storyboard/shots 字段的对象）粘贴到下方，自动按 scene 字段分组建场次。
            </p>
            <textarea
              rows={14}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, boxSizing: 'border-box' }}
              placeholder={'[\n  { "shot_id": "EP01-S01-C01", "scene": "场景1", "shot_type": "CU", ... },\n  ...\n]'}
              value={jsonImportText}
              onChange={(e) => setJsonImportText(e.target.value)}
            />
            <div className="modal__actions">
              <button className="btn-ghost" onClick={() => setShowJsonImport(false)}>取消</button>
              <button className="btn-primary" onClick={() => void importFromJson()} disabled={jsonImporting}>
                {jsonImporting ? '导入中…' : '导入'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建场次弹窗 */}
      {showSceneForm && (
        <div className="modal-overlay" onClick={() => setShowSceneForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">新建场次</h2>
            <label className="field-label">场次编号</label>
            <input type="number" min={1} value={sceneDraft.scene_number}
              onChange={(e) => setSceneDraft((d) => ({ ...d, scene_number: Number(e.target.value) }))} />
            <label className="field-label">地点</label>
            <input type="text" placeholder="INT. 咖啡馆" value={sceneDraft.location}
              onChange={(e) => setSceneDraft((d) => ({ ...d, location: e.target.value }))} />
            <label className="field-label">时段</label>
            <select value={sceneDraft.time_of_day}
              onChange={(e) => setSceneDraft((d) => ({ ...d, time_of_day: e.target.value }))}>
              {['DAY', 'NIGHT', 'DAWN', 'DUSK', 'CONTINUOUS'].map((t) => <option key={t}>{t}</option>)}
            </select>
            <label className="field-label">场次描述</label>
            <textarea rows={3} value={sceneDraft.description}
              onChange={(e) => setSceneDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder="简要描述本场次发生的事" />
            <div className="modal__actions">
              <button className="btn-ghost" onClick={() => setShowSceneForm(false)}>取消</button>
              <button className="btn-primary" onClick={() => void createScene()}>创建</button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑镜头弹窗 */}
      {editingShot && (
        <div className="modal-overlay" onClick={() => setEditingShot(null)}>
          <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">编辑镜头 #{editingShot.shot_number}</h2>

            {/* ── 📽️ 时间轴 ── */}
            <h3 className="modal__section-title">📽️ 时间轴</h3>
            <div className="modal__grid3">
              <div>
                <label className="field-label">开始时间码</label>
                <input type="text" placeholder="00:00:03:00" value={shotDraft.timecode_in ?? ''}
                  onChange={(e) => patch('timecode_in', e.target.value)} />
              </div>
              <div>
                <label className="field-label">结束时间码</label>
                <input type="text" placeholder="00:00:06:00" value={shotDraft.timecode_out ?? ''}
                  onChange={(e) => patch('timecode_out', e.target.value)} />
              </div>
              <div>
                <label className="field-label">时长（秒）</label>
                <input type="number" min={0.5} step={0.5} value={shotDraft.duration_sec ?? 3}
                  onChange={(e) => patch('duration_sec', Number(e.target.value))} />
              </div>
            </div>

            {/* ── 🎬 画面 ── */}
            <h3 className="modal__section-title">🎬 画面</h3>
            <label className="field-label">画面内容描述（主体、环境、构图）</label>
            <textarea rows={2} value={shotDraft.shot_content ?? ''}
              onChange={(e) => patch('shot_content', e.target.value)}
              placeholder="主角站在窗边，逆光，背景为城市夜景…" />
            <div className="modal__grid2">
              <div>
                <label className="field-label">景别</label>
                <select value={shotDraft.shot_type ?? ''} onChange={(e) => patch('shot_type', e.target.value)}>
                  {SHOT_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label">运镜方式</label>
                <select value={shotDraft.camera_movement ?? ''} onChange={(e) => patch('camera_movement', e.target.value)}>
                  {CAM_MOVES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
            </div>
            <label className="field-label">导演意图 / 动作焦点</label>
            <input type="text" value={shotDraft.director_intent ?? ''}
              onChange={(e) => patch('director_intent', e.target.value)}
              placeholder="捕捉主角的惊恐瞬间，强调手部颤抖…" />

            {/* ── 📷 摄影参数 ── */}
            <h3 className="modal__section-title">📷 摄影参数</h3>
            <div className="modal__grid3">
              <div>
                <label className="field-label">摄影参数（焦段/光圈/快门）</label>
                <input type="text" placeholder="35mm f/1.8 1/250s" value={shotDraft.camera_params ?? ''}
                  onChange={(e) => patch('camera_params', e.target.value)} />
              </div>
              <div>
                <label className="field-label">灯光描述</label>
                <input type="text" placeholder="暖光侧逆光，冷暖对比" value={shotDraft.lighting ?? ''}
                  onChange={(e) => patch('lighting', e.target.value)} />
              </div>
              <div>
                <label className="field-label">色调风格</label>
                <input type="text" placeholder="高对比度·橙青色调" value={shotDraft.color_tone ?? ''}
                  onChange={(e) => patch('color_tone', e.target.value)} />
              </div>
            </div>

            {/* ── 🔊 音效 ── */}
            <h3 className="modal__section-title">🔊 音效</h3>
            <label className="field-label">音效设计（环境音、音效）</label>
            <input type="text" value={shotDraft.sound_design ?? ''}
              onChange={(e) => patch('sound_design', e.target.value)}
              placeholder="城市噪音渐隐，钢琴单音，心跳声…" />

            {/* ── 💬 台词与字幕 ── */}
            <h3 className="modal__section-title">💬 台词与字幕</h3>
            <label className="field-label">台词 / VO</label>
            <textarea rows={2} value={shotDraft.dialogue ?? ''}
              onChange={(e) => patch('dialogue', e.target.value)} />
            <label className="field-label">字幕文本（可与台词不同，用于屏幕显示）</label>
            <input type="text" value={shotDraft.subtitle_text ?? ''}
              onChange={(e) => patch('subtitle_text', e.target.value)}
              placeholder="（字幕内容）" />

            {/* ── 动作描述（保留旧字段） ── */}
            <h3 className="modal__section-title">🎭 动作描述</h3>
            <textarea rows={2} value={shotDraft.action ?? ''}
              onChange={(e) => patch('action', e.target.value)}
              placeholder="镜头内发生了什么" />

            {/* ── 🤖 AI 提示词 ── */}
            <h3 className="modal__section-title">🤖 AI 提示词</h3>
            <label className="field-label">AI 图片生成提示词</label>
            <textarea rows={3} value={shotDraft.ai_prompt ?? ''}
              onChange={(e) => patch('ai_prompt', e.target.value)}
              placeholder="photorealistic, wide shot, city skyline at night, cinematic…" />
            <label className="field-label">帧动画 / 视频提示词</label>
            <textarea rows={2} value={shotDraft.animation_prompt ?? ''}
              onChange={(e) => patch('animation_prompt', e.target.value)}
              placeholder="camera slowly dolly forward, clouds moving, warm lighting…" />

            {/* ── 🖼️ 关键帧图片（多图） ── */}
            <h3 className="modal__section-title">🖼️ 关键帧图片</h3>
            <p className="field-hint" style={{ marginBottom: 8 }}>
              可多张；第一位为场次列表默认预览，并参与视频生成的参考帧。工具栏「生成图片」会在队首追加新图。
            </p>
            <div style={{ marginBottom: 8 }}>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => {
                  if (!editingShot || !activeScene) return;
                  shotUploadTargetRef.current = { sceneId: activeScene.id, shotId: editingShot.id };
                  kbUploadRef.current?.click();
                }}
              >从本地上传图片</button>
            </div>
            {(() => {
              const kfList = parsePathJson(shotDraft.frame_images ?? '[]');
              const kfIdx = Math.min(editKfCarouselIdx, Math.max(0, kfList.length - 1));
              const curSrc = kfList[kfIdx];
              return (
                <div className="sb-edit-carousel">
                  <div className="sb-edit-carousel__viewport">
                    {kfList.length === 0 ? (
                      <div className="sb-edit-carousel__placeholder">暂无关键帧</div>
                    ) : (
                      <img
                        className="sb-edit-carousel__media"
                        src={curSrc.startsWith('http') ? curSrc : `file://${curSrc}`}
                        alt={`关键帧 ${kfIdx + 1}`}
                      />
                    )}
                    {kfList.length > 1 ? (
                      <>
                        <button
                          type="button"
                          className="sb-edit-carousel__arrow sb-edit-carousel__arrow--prev"
                          aria-label="上一张"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditKfCarouselIdx((i) => (i - 1 + kfList.length) % kfList.length);
                          }}
                        >‹</button>
                        <button
                          type="button"
                          className="sb-edit-carousel__arrow sb-edit-carousel__arrow--next"
                          aria-label="下一张"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditKfCarouselIdx((i) => (i + 1) % kfList.length);
                          }}
                        >›</button>
                      </>
                    ) : null}
                  </div>
                  {kfList.length > 0 ? (
                    <div className="sb-edit-carousel__footer">
                      <div className="sb-edit-carousel__meta">
                        <span className="sb-edit-carousel__counter">{kfIdx + 1} / {kfList.length}</span>
                        {kfList.length > 1 ? (
                          <div className="sb-edit-carousel__dots">
                            {kfList.map((_, i) => (
                              <button
                                key={i}
                                type="button"
                                className={'sb-edit-carousel__dot' + (i === kfIdx ? ' sb-edit-carousel__dot--active' : '')}
                                aria-label={`第 ${i + 1} 张`}
                                aria-pressed={i === kfIdx}
                                onClick={() => setEditKfCarouselIdx(i)}
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="sb-edit-carousel__actions">
                        {kfIdx > 0 ? (
                          <button type="button" className="btn-ghost btn-sm" onClick={() => promoteFrameImage(kfIdx)}>设为主预览</button>
                        ) : null}
                        <button type="button" className="btn-danger btn-sm" onClick={() => void removeFrameImage(kfIdx)}>删除本帧</button>
                      </div>
                    </div>
                  ) : null}
                  <div className="frame-images__add" style={{ marginTop: 10 }}>
                    <input
                      type="text"
                      placeholder="粘贴图片 URL 或本地路径，回车添加到队首"
                      className="frame-images__input"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const val = (e.target as HTMLInputElement).value.trim();
                          if (val) { addFrameImage(val); (e.target as HTMLInputElement).value = ''; }
                        }
                      }}
                    />
                  </div>
                </div>
              );
            })()}

            {/* ── 🎞️ 镜头视频（多段） ── */}
            <h3 className="modal__section-title">🎞️ 镜头视频</h3>
            <p className="field-hint" style={{ marginBottom: 8 }}>
              同一镜头可保存多版视频；第一位为列表默认预览，可与后台「AI 生成视频」混用。
            </p>
            <div style={{ marginBottom: 8 }}>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => {
                  if (!editingShot || !activeScene) return;
                  shotUploadTargetRef.current = { sceneId: activeScene.id, shotId: editingShot.id };
                  vidUploadRef.current?.click();
                }}
              >从本地上传视频</button>
            </div>
            {(() => {
              const vidList = parsePathJson((shotDraft as Shot).video_paths ?? '[]');
              const vidIdx = Math.min(editVidCarouselIdx, Math.max(0, vidList.length - 1));
              const vSrc = vidList[vidIdx];
              return (
                <div className="sb-edit-carousel">
                  <div className="sb-edit-carousel__viewport">
                    {vidList.length === 0 ? (
                      <div className="sb-edit-carousel__placeholder">暂无镜头视频</div>
                    ) : (
                      <video
                        className="sb-edit-carousel__media"
                        src={vSrc.startsWith('http') ? vSrc : `file://${vSrc}`}
                        controls
                        playsInline
                        muted
                      />
                    )}
                    {vidList.length > 1 ? (
                      <>
                        <button
                          type="button"
                          className="sb-edit-carousel__arrow sb-edit-carousel__arrow--prev"
                          aria-label="上一段"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditVidCarouselIdx((i) => (i - 1 + vidList.length) % vidList.length);
                          }}
                        >‹</button>
                        <button
                          type="button"
                          className="sb-edit-carousel__arrow sb-edit-carousel__arrow--next"
                          aria-label="下一段"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditVidCarouselIdx((i) => (i + 1) % vidList.length);
                          }}
                        >›</button>
                      </>
                    ) : null}
                  </div>
                  {vidList.length > 0 ? (
                    <div className="sb-edit-carousel__footer">
                      <div className="sb-edit-carousel__meta">
                        <span className="sb-edit-carousel__counter">{vidIdx + 1} / {vidList.length}</span>
                        {vidList.length > 1 ? (
                          <div className="sb-edit-carousel__dots">
                            {vidList.map((_, i) => (
                              <button
                                key={i}
                                type="button"
                                className={'sb-edit-carousel__dot' + (i === vidIdx ? ' sb-edit-carousel__dot--active' : '')}
                                aria-label={`第 ${i + 1} 段`}
                                aria-pressed={i === vidIdx}
                                onClick={() => setEditVidCarouselIdx(i)}
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="sb-edit-carousel__actions">
                        {vidIdx > 0 ? (
                          <button type="button" className="btn-ghost btn-sm" onClick={() => promoteVideoPathDraft(vidIdx)}>设为默认预览</button>
                        ) : null}
                        <button type="button" className="btn-danger btn-sm" onClick={() => void removeVideoPathDraft(vidIdx)}>删除本段</button>
                      </div>
                    </div>
                  ) : null}
                  <div className="frame-images__add" style={{ marginTop: 10 }}>
                    <input
                      type="text"
                      placeholder="粘贴视频 URL 或本地路径，回车添加到队首"
                      className="frame-images__input"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const val = (e.target as HTMLInputElement).value.trim();
                          if (val) { addVideoPathDraft(val); (e.target as HTMLInputElement).value = ''; }
                        }
                      }}
                    />
                  </div>
                </div>
              );
            })()}

            <div className="modal__actions">
              <button className="btn-ghost" onClick={() => setEditingShot(null)}>取消</button>
              <button className="btn-primary" onClick={() => void saveShot()}>保存</button>
            </div>
          </div>
        </div>
      )}
      <input ref={kbUploadRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleShotKeyframeFile} />
      <input ref={vidUploadRef} type="file" accept="video/*,.mp4,.webm,.mov,.mkv" style={{ display: 'none' }} onChange={handleShotVideoFile} />
    </div>
  );
}
