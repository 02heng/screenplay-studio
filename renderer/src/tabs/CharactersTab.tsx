import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppDialog } from '../context/AppDialogContext';
import { apiFetch, getBackendBase } from '../hooks/useBackend';
import type { ProjectType } from '../hooks/useProjects';
import { DEFAULT_CHARACTER_BOARD_PROMPT } from '../lib/characterSheetTemplate';
import { EV_RELOAD_CHARACTERS } from '../lib/pipelineImport';

interface Character {
  id: number;
  name: string;
  description: string;
  ai_prompt: string;
  reference_images: string[];
  three_view_image_path: string;
  three_view_status: string;
}

interface Props { projectId: number; projectType: ProjectType }

const EMPTY: Omit<Character, 'id' | 'reference_images'> = {
  name: '',
  description: '',
  ai_prompt: '',
  three_view_image_path: '',
  three_view_status: '',
};

export default function CharactersTab({ projectId, projectType }: Props) {
  const { confirm } = useAppDialog();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [editing, setEditing] = useState<Character | null>(null);
  const [draft, setDraft] = useState({ ...EMPTY });
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [generatingIds, setGeneratingIds] = useState<Set<number>>(() => new Set());
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

  const startCreate = () => {
    setEditing(null);
    setDraft({ ...EMPTY, ai_prompt: DEFAULT_CHARACTER_BOARD_PROMPT });
    setCreating(true);
  };

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
    const c = characters.find((x) => x.id === id);
    const name = c?.name?.trim() || '该角色';
    const ok = await confirm({
      title: '删除角色',
      message: `确定删除角色「${name}」吗？此操作不可恢复。`,
      confirmLabel: '删除',
    });
    if (!ok) return;
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

  const generateThreeView = async (charId: number) => {
    setGeneratingIds((prev) => { const next = new Set(prev); next.add(charId); return next; });
    try {
      const base = await getBackendBase();
      const res = await apiFetch<{ three_view_image_path: string; three_view_status: string }>(
        base,
        `/api/projects/${projectId}/characters/${charId}/generate-three-view`,
        { method: 'POST' }
      );
      setCharacters((prev) =>
        prev.map((c) =>
          c.id === charId
            ? { ...c, three_view_image_path: res.three_view_image_path, three_view_status: res.three_view_status }
            : c
        )
      );
    } catch (e) {
      setCharacters((prev) =>
        prev.map((c) => (c.id === charId ? { ...c, three_view_status: 'error' } : c))
      );
      setError(String((e as Error).message));
    } finally {
      setGeneratingIds((prev) => { const next = new Set(prev); next.delete(charId); return next; });
    }
  };

  const agentPipelineHint =
    projectType === 'novel_adapt'
      ? [
          '小说改编走「多智能体」流水线时，后端有一个固定步骤：CharacterAgent（界面 SSE 里常标为「角色设计师」）。',
          '它只做一件事：跑提示词阶段「characters」，根据前一阶段 digest 与原著节选产出人物 JSON（见后端 app/agents/character.py + prompts/novel_adapt.py）。',
          '生成结束后，剧本页在「characters」阶段完成时调用 importCharactersFromPhase，把 JSON 里的人物 POST 进本项目数据库——没有另外的「任务队列」从别处拉角色。',
          '顺序：原著 digest → 角色 characters → 分集大纲 adapt_outline → **按集循环**：剧本 novel_screenplay → 导演 → 分镜 storyboard → 导演 → 剪辑 edit_script → 导演 → … → 收尾清单。续写：仅对选定集重复「剧本→分镜→剪辑」三板斧。',
        ]
      : projectType === 'short_drama'
        ? [
            '短剧同样在多智能体流水线里插入 CharacterAgent（角色设计师），阶段名为「characters」，产出写入本项目。',
            '续写模式也会再次经过 characters 阶段，可能追加新角色条目。',
          ]
        : [
            '院线长剧本项目不使用上述自动角色流水线；列表里的角色来自你手动「新建角色」或导入备份。',
          ];

  return (
    <div className="chars-tab">
      <div className="chars-tab__head">
        <h2 className="section-title">角色管理</h2>
        <button className="btn-primary" onClick={startCreate}>+ 新建角色</button>
      </div>
      <details className="chars-tab__agent-info">
        <summary>角色从哪来？（角色生成智能体说明）</summary>
        <ul>
          {agentPipelineHint.map((line, idx) => (
            <li key={idx}>{line}</li>
          ))}
        </ul>
      </details>
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
                  <button
                    className="btn-ghost btn-sm"
                    disabled={generatingIds.has(c.id)}
                    onClick={() => void generateThreeView(c.id)}
                    title="生成三视图"
                  >
                    {generatingIds.has(c.id) || c.three_view_status === 'generating' ? '生成中…' : '🎨 生成三视图'}
                  </button>
                </div>
              )}
              {c.three_view_status === 'done' && c.three_view_image_path && (
                <div className="char-card__three-view">
                  <img
                    src={c.three_view_image_path.startsWith('http') ? c.three_view_image_path : `file://${c.three_view_image_path}`}
                    alt="三视图"
                    className="char-card__three-view-img"
                    style={{ width: 100, height: 'auto', borderRadius: 4, marginTop: 6 }}
                  />
                </div>
              )}
              {c.three_view_status === 'error' && (
                <div className="char-card__three-view-error" style={{ color: 'var(--color-error, #f87171)', fontSize: '0.8rem', marginTop: 4 }}>
                  三视图生成失败
                </div>
              )}
              <div className="char-card__actions">
                <button className="btn-ghost btn-sm" onClick={() => {
                  setEditing(c);
                  setDraft({
                    name: c.name,
                    description: c.description,
                    ai_prompt: c.ai_prompt,
                    three_view_image_path: c.three_view_image_path,
                    three_view_status: c.three_view_status,
                  });
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

            <div className="field-label-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <label className="field-label" htmlFor="c-prompt" style={{ margin: 0 }}>AI 三视图 / 造型提示词</label>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => setDraft((d) => ({ ...d, ai_prompt: DEFAULT_CHARACTER_BOARD_PROMPT }))}
              >
                空白时用模板
              </button>
            </div>
            <textarea id="c-prompt" rows={10} value={draft.ai_prompt}
              onChange={(e) => setDraft((d) => ({ ...d, ai_prompt: e.target.value }))}
              placeholder="中文说明角色与需求，可接英文关键词；新建角色时已预填混写模板。" />
            <p className="field-hint">跑剧本流水线时，「人物档案」阶段会按固定框架让模型为每人生成一整段「角色板」文生图提示词（JSON 字段 character_sheet_prompt）；导入角色后会自动填入此处，你可直接复制去出图。需手写时点「空白时用模板」；具体外形也可写在上方「描述」。</p>

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
