import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, getBackendBase } from '../hooks/useBackend';
import { EV_RELOAD_CHARACTERS } from '../lib/pipelineImport';

interface Character {
  id: number;
  name: string;
  description: string;
  ai_prompt: string;
  reference_images: string[];
}

interface Props { projectId: number }

const EMPTY: Omit<Character, 'id' | 'reference_images'> = { name: '', description: '', ai_prompt: '' };

export default function CharactersTab({ projectId }: Props) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [editing, setEditing] = useState<Character | null>(null);
  const [draft, setDraft] = useState({ ...EMPTY });
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const uploadRef = useRef<HTMLInputElement | null>(null);

  const loadChars = useCallback(async () => {
    setLoading(true);
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ characters: Character[] }>(base, `/api/projects/${projectId}/characters`);
      setCharacters(data.characters);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { void loadChars(); }, [loadChars]);

  useEffect(() => {
    const fn = () => void loadChars();
    window.addEventListener(EV_RELOAD_CHARACTERS, fn);
    return () => window.removeEventListener(EV_RELOAD_CHARACTERS, fn);
  }, [loadChars]);

  const startCreate = () => { setEditing(null); setDraft({ ...EMPTY }); setCreating(true); };

  const saveChar = async () => {
    if (!draft.name.trim()) return;
    const base = await getBackendBase();
    if (editing) {
      const updated = await apiFetch<Character>(base, `/api/projects/${projectId}/characters/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify(draft),
      });
      setCharacters((prev) => prev.map((c) => c.id === editing.id ? { ...updated, reference_images: editing.reference_images } : c));
    } else {
      const created = await apiFetch<Character>(base, `/api/projects/${projectId}/characters`, {
        method: 'POST',
        body: JSON.stringify(draft),
      });
      setCharacters((prev) => [...prev, created]);
    }
    setCreating(false);
    setEditing(null);
  };

  const deleteChar = async (id: number) => {
    const base = await getBackendBase();
    await apiFetch(base, `/api/projects/${projectId}/characters/${id}`, { method: 'DELETE' });
    setCharacters((prev) => prev.filter((c) => c.id !== id));
  };

  const uploadRef2 = useRef<{ charId: number } | null>(null);

  const uploadImage = async (charId: number, file: File) => {
    const base = await getBackendBase();
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${base}/api/projects/${projectId}/characters/${charId}/reference-image`, {
      method: 'POST',
      body: fd,
    });
    const json = await res.json() as { reference_images: string[] };
    setCharacters((prev) => prev.map((c) => c.id === charId ? { ...c, reference_images: json.reference_images } : c));
  };

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !uploadRef2.current) return;
    await uploadImage(uploadRef2.current.charId, file);
    e.target.value = '';
  };

  const copyPrompt = (prompt: string) => {
    void navigator.clipboard.writeText(prompt);
  };

  return (
    <div className="chars-tab">
      <div className="chars-tab__head">
        <h2 className="section-title">角色管理</h2>
        <button className="btn-primary" onClick={startCreate}>+ 新建角色</button>
      </div>
      {error && <div className="error">{error}</div>}
      {loading && <div className="tab-loading">加载中…</div>}

      <div className="chars-grid">
        {characters.map((c) => (
          <div key={c.id} className="char-card">
            <div className="char-card__refs">
              {c.reference_images.length > 0 ? (
                <img src={`file://${c.reference_images[0]}`} alt={c.name} className="char-card__ref-img" />
              ) : (
                <div className="char-card__ref-placeholder">?</div>
              )}
            </div>
            <div className="char-card__body">
              <h3 className="char-card__name">{c.name}</h3>
              {c.description && <p className="char-card__desc">{c.description}</p>}
              {c.ai_prompt && (
                <div className="char-card__prompt">
                  <span className="char-card__prompt-label">三视图提示词</span>
                  <span className="char-card__prompt-text">{c.ai_prompt}</span>
                  <button className="btn-icon" onClick={() => copyPrompt(c.ai_prompt)} title="复制">⎘</button>
                </div>
              )}
              <div className="char-card__actions">
                <button className="btn-ghost btn-sm" onClick={() => {
                  setEditing(c);
                  setDraft({ name: c.name, description: c.description, ai_prompt: c.ai_prompt });
                  setCreating(true);
                }}>编辑</button>
                <button className="btn-ghost btn-sm" onClick={() => {
                  uploadRef2.current = { charId: c.id };
                  uploadRef.current?.click();
                }}>+ 参考图</button>
                <button className="btn-danger btn-sm" onClick={() => void deleteChar(c.id)}>删除</button>
              </div>
            </div>
          </div>
        ))}
        {characters.length === 0 && !loading && (
          <div className="chars-tab__empty">还没有角色，点击「新建角色」开始创建</div>
        )}
      </div>

      {/* 隐藏文件输入 */}
      <input ref={uploadRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileInput} />

      {/* 新建/编辑弹窗 */}
      {creating && (
        <div className="modal-overlay" onClick={() => setCreating(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">{editing ? '编辑角色' : '新建角色'}</h2>

            <label className="field-label" htmlFor="c-name">姓名</label>
            <input id="c-name" type="text" autoFocus value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="角色姓名" />

            <label className="field-label" htmlFor="c-desc">描述</label>
            <textarea id="c-desc" rows={3} value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder="外貌、性格、背景等" />

            <label className="field-label" htmlFor="c-prompt">AI 三视图 / 造型提示词</label>
            <textarea id="c-prompt" rows={4} value={draft.ai_prompt}
              onChange={(e) => setDraft((d) => ({ ...d, ai_prompt: e.target.value }))}
              placeholder="(photorealistic, young woman, black hair, red jacket, cinematic lighting...)" />
            <p className="field-hint">建议描述可用于文生图的人物三视图（正/侧/背全身一致造型）；若与分镜出图组合，可在分镜提示词里摘取 needed 造型关键词。</p>

            <div className="modal__actions">
              <button className="btn-ghost" onClick={() => setCreating(false)}>取消</button>
              <button className="btn-primary" onClick={() => void saveChar()} disabled={!draft.name.trim()}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
