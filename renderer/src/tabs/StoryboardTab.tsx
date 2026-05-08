import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, getBackendBase } from '../hooks/useBackend';
import { EV_RELOAD_STORYBOARD } from '../lib/pipelineImport';

const IMAGE_API_KEY = 'screenplay-studio-image-api-v1';

interface Scene { id: number; scene_number: number; location: string; time_of_day: string; description: string }
interface Shot {
  id: number; scene_id: number; shot_number: number; shot_type: string;
  camera_movement: string; action: string; dialogue: string;
  ai_prompt: string; animation_prompt: string;
  image_path: string | null; video_path: string | null; duration_sec: number;
}
interface ImageApiConfig { baseUrl: string; endpointPath: string; model: string; apiKey: string }

function loadImageApi(): ImageApiConfig {
  try { return JSON.parse(localStorage.getItem(IMAGE_API_KEY) || '{}') as ImageApiConfig; }
  catch { return { baseUrl: '', endpointPath: 'images/generations', model: 'dall-e-3', apiKey: '' }; }
}

const SHOT_TYPES = ['WS', 'MS', 'CU', 'ECU', 'OTS', 'POV', 'AERIAL', '其他'];
const CAM_MOVES = ['STATIC', 'PAN', 'TILT', 'DOLLY', 'CRANE', 'HANDHELD', '其他'];

interface Props { projectId: number }

export default function StoryboardTab({ projectId }: Props) {
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [activeScene, setActiveScene] = useState<Scene | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [editingShot, setEditingShot] = useState<Shot | null>(null);
  const [shotDraft, setShotDraft] = useState<Partial<Shot>>({});
  const [generating, setGenerating] = useState<Record<number, boolean>>({});
  const [error, setError] = useState('');
  const [showSceneForm, setShowSceneForm] = useState(false);
  const [sceneDraft, setSceneDraft] = useState({ scene_number: 1, location: '', time_of_day: 'DAY', description: '' });
  const imgCfg = useRef(loadImageApi());
  const activeSceneRef = useRef<Scene | null>(null);
  activeSceneRef.current = activeScene;

  const loadScenes = useCallback(async () => {
    const base = await getBackendBase();
    const data = await apiFetch<{ scenes: Scene[] }>(base, `/api/projects/${projectId}/scenes`);
    setScenes(data.scenes);
    if (data.scenes.length > 0 && !activeScene) setActiveScene(data.scenes[0]);
  }, [projectId, activeScene]);

  const loadShots = useCallback(async (sceneId: number) => {
    const base = await getBackendBase();
    const data = await apiFetch<{ shots: Shot[] }>(base, `/api/projects/${projectId}/scenes/${sceneId}/shots`);
    setShots(data.shots);
  }, [projectId]);

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
      body: JSON.stringify({ shot_number: nextNum, shot_type: 'MS', camera_movement: 'STATIC', action: '', dialogue: '', ai_prompt: '', animation_prompt: '', duration_sec: 3 }),
    });
    setShots((prev) => [...prev, s]);
    setEditingShot(s);
    setShotDraft(s);
  };

  const saveShot = async () => {
    if (!editingShot || !activeScene) return;
    const base = await getBackendBase();
    const updated = await apiFetch<Shot>(base, `/api/projects/${projectId}/scenes/${activeScene.id}/shots/${editingShot.id}`, {
      method: 'PATCH',
      body: JSON.stringify(shotDraft),
    });
    setShots((prev) => prev.map((s) => s.id === updated.id ? updated : s));
    setEditingShot(null);
  };

  const deleteShot = async (shotId: number) => {
    if (!activeScene) return;
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

      // download and save via backend
      const base = await getBackendBase();
      // For simplicity, store the remote URL as image_path for now
      const updated = await apiFetch<Shot>(base, `/api/projects/${projectId}/scenes/${shot.scene_id}/shots/${shot.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ image_path: imgUrl }),
      });
      setShots((prev) => prev.map((s) => s.id === updated.id ? updated : s));
    } catch (e) { setError(String((e as Error).message)); }
    finally { setGenerating((g) => ({ ...g, [shot.id]: false })); }
  };

  const copyPrompt = (p: string) => void navigator.clipboard.writeText(p);

  const openShotEditor = (shot: Shot) => {
    setEditingShot(shot);
    setShotDraft({ ...shot });
  };

  return (
    <div className="sb-tab">
      {/* ── 场次侧栏 ── */}
      <aside className="sb-tab__scenes">
        <div className="sb-tab__scenes-head">
          <span className="section-title">场次</span>
          <button className="btn-icon" onClick={() => setShowSceneForm(true)} title="新建场次">＋</button>
        </div>
        <ul className="scene-list">
          {scenes.map((s) => (
            <li
              key={s.id}
              className={`scene-list__item${activeScene?.id === s.id ? ' scene-list__item--active' : ''}`}
              onClick={() => setActiveScene(s)}
            >
              <span className="scene-list__num">场 {s.scene_number}</span>
              <span className="scene-list__loc">{s.location || '（未命名）'}</span>
              <button className="scene-list__del" onClick={(e) => { e.stopPropagation(); void deleteScene(s.id); }}>×</button>
            </li>
          ))}
          {scenes.length === 0 && <li className="scene-list__empty">暂无场次</li>}
        </ul>
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
              <button className="btn-primary" onClick={() => void addShot()}>+ 添加镜头</button>
            </div>

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
                  {/* 图片区 */}
                  <div className="sb-cell__img-wrap">
                    {shot.image_path ? (
                      shot.image_path.startsWith('http') ? (
                        <img src={shot.image_path} alt={`Shot ${shot.shot_number}`} className="sb-cell__img" />
                      ) : (
                        <img src={`file://${shot.image_path}`} alt={`Shot ${shot.shot_number}`} className="sb-cell__img" />
                      )
                    ) : (
                      <div className="sb-cell__img-placeholder">
                        <span>{shot.shot_type || 'SHOT'}</span>
                      </div>
                    )}
                    <div className="sb-cell__overlay">
                      <button
                        type="button"
                        className="sb-cell__gen-btn"
                        onClick={(e) => { e.stopPropagation(); void generateImage(shot); }}
                        disabled={generating[shot.id] || !shot.ai_prompt}
                        title={shot.ai_prompt ? '生成图片' : '请先填写 AI 提示词'}
                      >
                        {generating[shot.id] ? '生成中…' : '✦ 生成'}
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
                    {shot.action && <p className="sb-cell__action">{shot.action}</p>}
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
          </>
        ) : (
          <div className="sb-tab__no-scene">请从左侧选择或新建场次</div>
        )}
      </div>

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

            <div className="modal__grid2">
              <div>
                <label className="field-label">镜头类型</label>
                <select value={shotDraft.shot_type ?? ''} onChange={(e) => setShotDraft((d) => ({ ...d, shot_type: e.target.value }))}>
                  {SHOT_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label">运镜方式</label>
                <select value={shotDraft.camera_movement ?? ''} onChange={(e) => setShotDraft((d) => ({ ...d, camera_movement: e.target.value }))}>
                  {CAM_MOVES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label">时长（秒）</label>
                <input type="number" min={0.5} step={0.5} value={shotDraft.duration_sec ?? 3}
                  onChange={(e) => setShotDraft((d) => ({ ...d, duration_sec: Number(e.target.value) }))} />
              </div>
            </div>

            <label className="field-label">画面描述 / 动作</label>
            <textarea rows={3} value={shotDraft.action ?? ''}
              onChange={(e) => setShotDraft((d) => ({ ...d, action: e.target.value }))}
              placeholder="镜头内发生了什么" />

            <label className="field-label">对白 / VO</label>
            <textarea rows={2} value={shotDraft.dialogue ?? ''}
              onChange={(e) => setShotDraft((d) => ({ ...d, dialogue: e.target.value }))} />

            <label className="field-label">AI 图片生成提示词</label>
            <textarea rows={4} value={shotDraft.ai_prompt ?? ''}
              onChange={(e) => setShotDraft((d) => ({ ...d, ai_prompt: e.target.value }))}
              placeholder="photorealistic, wide shot, city skyline at night, cinematic…" />

            <label className="field-label">帧动画 / 视频提示词</label>
            <textarea rows={3} value={shotDraft.animation_prompt ?? ''}
              onChange={(e) => setShotDraft((d) => ({ ...d, animation_prompt: e.target.value }))}
              placeholder="camera slowly dolly forward, clouds moving, warm lighting…" />

            <div className="modal__actions">
              <button className="btn-ghost" onClick={() => setEditingShot(null)}>取消</button>
              <button className="btn-primary" onClick={() => void saveShot()}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
