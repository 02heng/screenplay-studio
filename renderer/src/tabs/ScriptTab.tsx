import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { apiFetch, getBackendBase } from '../hooks/useBackend';
import {
  EV_RELOAD_CHARACTERS,
  EV_RELOAD_EDIT,
  EV_RELOAD_STORYBOARD,
  importCharactersFromPhase,
  importEditScriptFromPhase,
  importStoryboardFromPhase,
} from '../lib/pipelineImport';

const LLM_KEYS_STORAGE_KEY = 'screenplay-studio-llm-keys-v1';
const SHORT_DRAMA_TYPES_STORAGE_KEY = 'screenplay-studio-short-drama-types-v1';

/** 竖屏短剧常见基础类型（参考平台热榜题材标签，可多选叠加） */
const SHORT_DRAMA_TYPE_OPTIONS = [
  '霸总豪门',
  '甜宠',
  '虐恋',
  '复仇重生',
  '穿越',
  '战神归来',
  '赘婿逆袭',
  '都市情感',
  '职场商战',
  '家庭伦理',
  '悬疑推理',
  '古装宫斗',
  '玄幻仙侠',
  '乡村年代',
  '神医异能',
  '江湖热血',
  '校园青春',
  '喜剧爽剧',
] as const;

/** 结构化阶段：流式正文只进库与侧栏导入，不在编辑器中展示原始 JSON */
const STRUCTURED_PHASES = new Set(['characters', 'storyboard', 'edit_script']);

function structuredPhaseHint(id: string): string {
  const m: Record<string, string> = {
    characters: '角色',
    storyboard: '分镜',
    edit_script: '剪辑脚本',
  };
  return m[id] || id;
}

function loadShortDramaTypes(): Set<string> {
  try {
    const raw = localStorage.getItem(SHORT_DRAMA_TYPES_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x) => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

type JobType = 'feature' | 'short_drama' | 'novel_adapt';
type PresetSummary = { id: string; label: string; base_url: string; model: string; api_key_env?: string };
interface ScriptRecord { id: number; title: string; content: string; stage: string; created_at: string }

function loadLlmKeys(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LLM_KEYS_STORAGE_KEY) || '{}') as Record<string, string>; }
  catch { return {}; }
}

function parseSseBlocks(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let idx = 0;
  while (true) {
    const sep = buffer.indexOf('\n\n', idx);
    if (sep === -1) return { events, rest: buffer.slice(idx) };
    const block = buffer.slice(idx, sep).trimEnd();
    idx = sep + 2;
    const dataLines = block.split('\n').filter((l) => l.startsWith('data:'));
    const payload = dataLines.map((l) => l.replace(/^data:\s?/, '')).join('\n').trim();
    if (payload) events.push(payload);
  }
}

interface Props { projectId: number; projectType: string }

interface LibraryNovel {
  id: number;
  title: string;
  author: string;
  total_chapters: number;
  downloaded_chapters: number;
  char_count: number;
  download_pct: number;
}

interface LibraryChapter {
  id: number;
  book_id: number;
  title: string;
  chapter_index: number;
  downloaded: number;
}

export default function ScriptTab({ projectId, projectType }: Props) {
  const [scripts, setScripts] = useState<ScriptRecord[]>([]);
  const [activeScript, setActiveScript] = useState<ScriptRecord | null>(null);
  const [editor, setEditor] = useState('');
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [presetId, setPresetId] = useState('');
  const [logline, setLogline] = useState('');
  const [novelExcerpt, setNovelExcerpt] = useState('');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState('就绪');
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [llmKeys, setLlmKeys] = useState<Record<string, string>>(loadLlmKeys);
  const [shortDramaTypes, setShortDramaTypes] = useState<Set<string>>(() => loadShortDramaTypes());
  const [saving, setSaving] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const novelFileRef = useRef<HTMLInputElement | null>(null);
  const autoSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const llmKeysSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [showLibrary, setShowLibrary] = useState(false);
  const [libNovels, setLibNovels] = useState<LibraryNovel[]>([]);
  const [libLoading, setLibLoading] = useState(false);
  const [libSearch, setLibSearch] = useState('');
  const [libActiveNovel, setLibActiveNovel] = useState<LibraryNovel | null>(null);
  const [libChapters, setLibChapters] = useState<LibraryChapter[]>([]);
  const [libChaptersLoading, setLibChaptersLoading] = useState(false);
  const [libSelectedIds, setLibSelectedIds] = useState<Set<number>>(() => new Set());
  const [libError, setLibError] = useState('');
  const [libBusy, setLibBusy] = useState(false);

  const [renameTarget, setRenameTarget] = useState<ScriptRecord | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScriptRecord | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const jobType = projectType as JobType;

  const toggleShortDramaType = (label: string) => {
    setShortDramaTypes((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      localStorage.setItem(SHORT_DRAMA_TYPES_STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const loadScripts = useCallback(async () => {
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ scripts: ScriptRecord[] }>(base, `/api/projects/${projectId}/scripts`);
      setScripts(data.scripts);
      if (data.scripts.length > 0 && !activeScript) {
        const first = data.scripts[0];
        setActiveScript(first);
        setEditor(first.content);
      }
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, [projectId, activeScript]);

  const loadPresets = useCallback(async () => {
    const base = await getBackendBase();
    try {
      const data = await apiFetch<{ presets: PresetSummary[] }>(base, '/api/llm/presets');
      setPresets(data.presets || []);
      setPresetId((cur) => cur || data.presets?.[0]?.id || '');
    } catch { setPresets([]); }
  }, []);

  const persistLlmKeysToBackend = useCallback(async (keys: Record<string, string>) => {
    try {
      const base = await getBackendBase();
      await apiFetch(base, '/api/settings/llm-keys', {
        method: 'PUT',
        body: JSON.stringify({ keys }),
      });
    } catch {
      /* 离线时仍保留 localStorage */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const base = await getBackendBase();
        const data = await apiFetch<{ keys: Record<string, string> }>(base, '/api/settings/llm-keys');
        const fromApi = data.keys || {};
        const fromLs = loadLlmKeys();
        if (Object.keys(fromApi).length > 0) {
          const merged = { ...fromLs, ...fromApi };
          setLlmKeys(merged);
          localStorage.setItem(LLM_KEYS_STORAGE_KEY, JSON.stringify(merged));
        } else if (Object.keys(fromLs).length > 0) {
          setLlmKeys(fromLs);
          await apiFetch(base, '/api/settings/llm-keys', {
            method: 'PUT',
            body: JSON.stringify({ keys: fromLs }),
          });
        }
      } catch {
        setLlmKeys(loadLlmKeys());
      }
    })();
  }, []);

  useEffect(() => { void loadScripts(); void loadPresets(); }, [loadScripts, loadPresets]);

  const selectScript = (s: ScriptRecord) => {
    setActiveScript(s);
    setEditor(s.content);
    setError('');
  };

  const openRename = (s: ScriptRecord, e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setRenameTarget(s);
    setRenameValue(s.title);
  };

  const submitRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    setRenameBusy(true);
    setError('');
    try {
      const base = await getBackendBase();
      const updated = await apiFetch<ScriptRecord>(
        base,
        `/api/projects/${projectId}/scripts/${renameTarget.id}`,
        { method: 'PATCH', body: JSON.stringify({ title: renameValue.trim() }) }
      );
      setScripts((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
      setActiveScript((cur) => (cur?.id === updated.id ? { ...cur, ...updated } : cur));
      setRenameTarget(null);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setRenameBusy(false);
    }
  };

  const performDeleteScript = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    const wasActive = activeScript?.id === id;
    setDeleteBusy(true);
    setError('');
    try {
      const base = await getBackendBase();
      await apiFetch(base, `/api/projects/${projectId}/scripts/${id}`, { method: 'DELETE' });
      let nextList: ScriptRecord[] = [];
      setScripts((prev) => {
        nextList = prev.filter((x) => x.id !== id);
        return nextList;
      });
      if (wasActive) {
        if (nextList.length > 0) {
          const first = nextList[0];
          setActiveScript(first);
          setEditor(first.content);
        } else {
          setActiveScript(null);
          setEditor('');
        }
      }
      setDeleteTarget(null);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setDeleteBusy(false);
    }
  };

  const newScript = async () => {
    const base = await getBackendBase();
    const s = await apiFetch<ScriptRecord>(base, `/api/projects/${projectId}/scripts`, {
      method: 'POST',
      body: JSON.stringify({ title: `草稿 ${new Date().toLocaleString('zh-CN')}`, content: '' }),
    });
    setScripts((prev) => [s, ...prev]);
    setActiveScript(s);
    setEditor('');
  };

  const saveContent = useCallback(async (content: string, scriptId: number) => {
    setSaving(true);
    try {
      const base = await getBackendBase();
      await apiFetch(base, `/api/projects/${projectId}/scripts/${scriptId}`, {
        method: 'PATCH',
        body: JSON.stringify({ content }),
      });
      setScripts((prev) => prev.map((s) => s.id === scriptId ? { ...s, content } : s));
    } catch (e) { setError(String((e as Error).message)); }
    finally { setSaving(false); }
  }, [projectId]);

  const handleEditorChange = (val: string) => {
    setEditor(val);
    if (!activeScript) return;
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
    autoSaveRef.current = setTimeout(() => void saveContent(val, activeScript.id), 1500);
  };

  const runJob = async () => {
    if (!presetId) { setError('请先选择模型预设'); return; }
    if (jobType !== 'novel_adapt' && !logline.trim()) { setError('请填写梗概'); return; }
    if (jobType === 'novel_adapt' && !novelExcerpt.trim()) { setError('请粘贴小说节选'); return; }

    const base = await getBackendBase();
    let targetScriptId = activeScript?.id;
    if (!targetScriptId) {
      const s = await apiFetch<ScriptRecord>(base, `/api/projects/${projectId}/scripts`, {
        method: 'POST',
        body: JSON.stringify({ title: logline.trim() || '新剧本', content: '' }),
      });
      setScripts((prev) => [s, ...prev]);
      setActiveScript(s);
      targetScriptId = s.id;
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setEditor('');
    setPhase('');
    setStatus('生成中…');
    setError('');

    const shouldImportSides = jobType === 'short_drama' || jobType === 'novel_adapt';

    let fullText = '';

    const flushCompletedPhase = async (phaseId: string | null, raw: string) => {
      if (!phaseId || !targetScriptId) return;
      try {
        await saveContent(fullText, targetScriptId);
      } catch {
        /* 保存失败仍尝试侧栏导入 */
      }
      if (!shouldImportSides || !raw.trim()) return;
      try {
        if (phaseId === 'characters') {
          await importCharactersFromPhase(projectId, raw);
          window.dispatchEvent(new Event(EV_RELOAD_CHARACTERS));
        } else if (phaseId === 'storyboard') {
          await importStoryboardFromPhase(projectId, raw);
          window.dispatchEvent(new Event(EV_RELOAD_STORYBOARD));
        } else if (phaseId === 'edit_script') {
          await importEditScriptFromPhase(projectId, raw);
          window.dispatchEvent(new Event(EV_RELOAD_EDIT));
        }
      } catch {
        /* JSON 解析失败等：不阻断 */
      }
    };

    let streamPhaseId: string | null = null;
    let phaseAccum = '';

    try {
      const res = await fetch(`${base}/api/jobs/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: jobType,
          preset_id: presetId,
          logline: logline.trim(),
          novel_excerpt: novelExcerpt,
          notes: notes.trim(),
          short_drama_types: jobType === 'short_drama' ? [...shortDramaTypes] : [],
          llm_api_key: (llmKeys[presetId] ?? '').trim(),
        }),
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
        const { events, rest } = parseSseBlocks(buf);
        buf = rest;
        for (const ev of events) {
          let obj: Record<string, unknown>;
          try { obj = JSON.parse(ev) as Record<string, unknown>; } catch { continue; }
          if (obj.type === 'error') throw new Error(String(obj.message));
          if (obj.type === 'phase') {
            const newId = String(obj.phase_id || '');
            if (streamPhaseId) await flushCompletedPhase(streamPhaseId, phaseAccum);
            streamPhaseId = newId || null;
            phaseAccum = '';
            setPhase(newId);
            const header = `\n\n===== 阶段：${newId} =====\n`;
            fullText += header;
            if (newId && STRUCTURED_PHASES.has(newId)) {
              setEditor(
                (p) =>
                  p +
                  header +
                  `（本阶段为结构化结果，已同步到「${structuredPhaseHint(newId)}」页；下方正文区不展示原始 JSON。）\n`
              );
            } else {
              setEditor((p) => p + header);
            }
          }
          if (obj.type === 'delta' && obj.text) {
            const chunk = String(obj.text);
            phaseAccum += chunk;
            fullText += chunk;
            if (!streamPhaseId || !STRUCTURED_PHASES.has(streamPhaseId)) {
              setEditor((p) => p + chunk);
            }
          }
          if (obj.type === 'done') setStatus('完成');
          if (obj.type === 'meta') setStatus(`流水线启动（共 ${Number(obj.phases_total) || '?'} 段）`);
        }
      }

      if (streamPhaseId) await flushCompletedPhase(streamPhaseId, phaseAccum);
      if (targetScriptId) await saveContent(fullText, targetScriptId);
      abortRef.current = null;
    } catch (e) {
      if (targetScriptId && fullText.trim()) {
        try { await saveContent(fullText, targetScriptId); } catch { /* ignore */ }
      }
      if ((e as Error).name !== 'AbortError') {
        setError(String((e as Error).message));
        setStatus('出错');
      } else {
        setStatus('已中止');
      }
      abortRef.current = null;
    }
  };

  const stopJob = () => { abortRef.current?.abort(); abortRef.current = null; setStatus('已中止'); };

  const exportFountain = async () => {
    if (!activeScript) return;
    const base = await getBackendBase();
    const text = await fetch(`${base}/api/projects/${projectId}/scripts/${activeScript.id}/fountain`).then((r) => r.text());
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${activeScript.title}.fountain`; a.click();
    URL.revokeObjectURL(url);
  };

  const onImportTxt = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setNovelExcerpt(String(reader.result ?? '')); };
    reader.readAsText(file, 'UTF-8');
    e.target.value = '';
  };

  const loadLibraryNovels = useCallback(async () => {
    setLibLoading(true);
    setLibError('');
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ novels: LibraryNovel[] }>(base, '/api/download/novels');
      setLibNovels(data.novels || []);
    } catch (e) {
      setLibError(String((e as Error).message));
    } finally {
      setLibLoading(false);
    }
  }, []);

  const loadLibraryChapters = useCallback(async (novelId: number) => {
    setLibChaptersLoading(true);
    setLibError('');
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ chapters: LibraryChapter[] }>(
        base,
        `/api/download/novel/${novelId}/chapters`
      );
      setLibChapters(data.chapters || []);
    } catch (e) {
      setLibError(String((e as Error).message));
    } finally {
      setLibChaptersLoading(false);
    }
  }, []);

  const openLibrary = () => {
    setLibError('');
    setLibSearch('');
    setLibActiveNovel(null);
    setLibChapters([]);
    setLibSelectedIds(new Set());
    setShowLibrary(true);
    void loadLibraryNovels();
  };

  const closeLibrary = () => {
    setShowLibrary(false);
    setLibError('');
  };

  const selectLibNovel = (n: LibraryNovel) => {
    setLibActiveNovel(n);
    setLibSelectedIds(new Set());
    void loadLibraryChapters(n.id);
  };

  const appendExcerptBlock = (title: string, content: string) => {
    const block = `\n\n## ${title}\n\n${(content || '').trim()}\n`;
    setNovelExcerpt((prev) => {
      const p = prev.trim();
      return p ? p + block : block.trim();
    });
  };

  const chapterContentInvalid = (content: string) =>
    !content?.trim() || content.trim().startsWith('[下载失败');

  const insertSingleChapter = async (chapterId: number) => {
    if (!libActiveNovel) return;
    setLibBusy(true);
    setLibError('');
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ title: string; content: string }>(
        base,
        `/api/download/novel/${libActiveNovel.id}/chapter/${chapterId}/content`
      );
      if (chapterContentInvalid(data.content)) {
        setLibError('该章暂无正文，请先在「小说下载」页完成下载后再插入。');
        return;
      }
      appendExcerptBlock(data.title, data.content);
    } catch (e) {
      setLibError(String((e as Error).message));
    } finally {
      setLibBusy(false);
    }
  };

  const toggleChapterSelected = (id: number) => {
    setLibSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const insertSelectedChapters = async () => {
    if (!libActiveNovel || libSelectedIds.size === 0) return;
    const ordered = libChapters
      .filter((c) => libSelectedIds.has(c.id))
      .sort((a, b) => a.chapter_index - b.chapter_index);
    setLibBusy(true);
    setLibError('');
    try {
      const base = await getBackendBase();
      let combined = '';
      for (const c of ordered) {
        const data = await apiFetch<{ title: string; content: string }>(
          base,
          `/api/download/novel/${libActiveNovel.id}/chapter/${c.id}/content`
        );
        if (chapterContentInvalid(data.content)) {
          setLibError(`「${c.title}」暂无正文，已跳过。请在「小说下载」中补齐后再合并。`);
          continue;
        }
        combined += `\n\n## ${data.title}\n\n${data.content.trim()}\n`;
      }
      if (combined.trim()) {
        setNovelExcerpt((prev) => {
          const p = prev.trim();
          return p ? p + combined : combined.trim();
        });
        setLibSelectedIds(new Set());
      }
    } catch (e) {
      setLibError(String((e as Error).message));
    } finally {
      setLibBusy(false);
    }
  };

  const filteredLibNovels = libNovels.filter((n) => {
    const q = libSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      n.title.toLowerCase().includes(q) ||
      (n.author || '').toLowerCase().includes(q)
    );
  });

  const activePreset = presets.find((p) => p.id === presetId);

  return (
    <div className="script-tab">
      {/* ── 左侧历史列表 ── */}
      <aside className={`script-tab__history${sidebarOpen ? '' : ' script-tab__history--closed'}`}>
        <div className="script-tab__history-head">
          <span className="section-title">剧本版本</span>
          <button className="btn-icon" onClick={() => void newScript()} title="新建草稿">＋</button>
        </div>
        <ul className="script-list">
          {scripts.map((s) => (
            <li
              key={s.id}
              className={`script-list__item${activeScript?.id === s.id ? ' script-list__item--active' : ''}`}
              onClick={() => selectScript(s)}
            >
              <div className="script-list__body">
                <span className="script-list__title">{s.title}</span>
                <time className="script-list__date">{new Date(s.created_at).toLocaleString('zh-CN')}</time>
              </div>
              <div className="script-list__actions" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="script-list__action"
                  title="重命名"
                  aria-label="重命名"
                  onClick={(e) => openRename(s, e)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="script-list__action script-list__action--danger"
                  title="删除"
                  aria-label="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(s);
                  }}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
          {scripts.length === 0 && <li className="script-list__empty">暂无草稿</li>}
        </ul>
      </aside>

      {/* ── 主编辑区 ── */}
      <div className="script-tab__main">
        {/* 工具栏 */}
        <div className="script-tab__toolbar">
          <button className="btn-icon" onClick={() => setSidebarOpen((v) => !v)} title="切换历史面板">☰</button>
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)} className="toolbar-select">
            {presets.length === 0 && <option value="">（无预设）</option>}
            {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <input
            type="password"
            className="toolbar-key"
            autoComplete="off"
            title="输入后自动保存到本机用户数据目录；生成时此处可留空，后端会使用已保存的 Key"
            placeholder={
              activePreset?.api_key_env
                ? `${activePreset.api_key_env}（可留空，已保存至后端）`
                : 'API Key（保存至本机后端）'
            }
            value={llmKeys[presetId] ?? ''}
            onChange={(e) => {
              const next = { ...llmKeys, [presetId]: e.target.value };
              setLlmKeys(next);
              localStorage.setItem(LLM_KEYS_STORAGE_KEY, JSON.stringify(next));
              if (llmKeysSaveTimerRef.current) clearTimeout(llmKeysSaveTimerRef.current);
              llmKeysSaveTimerRef.current = setTimeout(() => void persistLlmKeysToBackend(next), 600);
            }}
          />
          <button className="btn-primary" onClick={() => void runJob()}>生成</button>
          <button className="btn-ghost" onClick={stopJob}>中止</button>
          <button className="btn-ghost" onClick={() => void exportFountain()} disabled={!activeScript}>Fountain</button>
          {saving && <span className="toolbar-saving">保存中…</span>}
          {status && <span className="toolbar-status">{status}{phase ? ` · ${phase}` : ''}</span>}
        </div>

        {jobType === 'short_drama' ? (
          <div className="script-tab__drama-types">
            <span className="script-tab__drama-types-label">短剧类型（可多选，将写入各阶段提示词）</span>
            <div className="script-tab__drama-types-chips" role="group" aria-label="短剧类型">
              {SHORT_DRAMA_TYPE_OPTIONS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`script-tab__drama-chip${shortDramaTypes.has(t) ? ' script-tab__drama-chip--on' : ''}`}
                  aria-pressed={shortDramaTypes.has(t)}
                  onClick={() => toggleShortDramaType(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* 生成参数 */}
        <div className="script-tab__params">
          {jobType !== 'novel_adapt' ? (
            <textarea
              className="script-tab__logline"
              rows={2}
              placeholder="一句话梗概 / 创意"
              value={logline}
              onChange={(e) => setLogline(e.target.value)}
            />
          ) : (
            <div className="script-tab__novel-row">
              <div className="script-tab__novel-toolbar">
                <input
                  ref={novelFileRef}
                  type="file"
                  accept=".txt,text/plain"
                  style={{ display: 'none' }}
                  onChange={onImportTxt}
                />
                <button type="button" className="btn-file" onClick={() => novelFileRef.current?.click()}>导入 .txt</button>
                <button type="button" className="btn-file" onClick={openLibrary}>从下载库选书</button>
              </div>
              <textarea
                rows={3}
                placeholder="小说节选（粘贴、导入 .txt，或从下载库插入章节）"
                value={novelExcerpt}
                onChange={(e) => setNovelExcerpt(e.target.value)}
              />
            </div>
          )}
          <textarea
            className="script-tab__notes"
            rows={2}
            placeholder="补充约束（口吻、篇幅…）"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {error && <div className="error">{error}</div>}

        {/* 编辑器 */}
        <div className="script-sheet">
          <textarea
            className="editor"
            value={editor}
            onChange={(e) => handleEditorChange(e.target.value)}
            placeholder="剧本内容将在这里流式生成，也可直接编辑…"
            spellCheck={false}
          />
        </div>
      </div>

      {showLibrary ? (
        <div className="modal-overlay" onClick={closeLibrary}>
          <div className="modal script-library-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">从小说下载库插入节选</h2>
            <div className="script-library__head">
              <input
                type="search"
                className="script-library__search"
                placeholder="搜索书名、作者…"
                value={libSearch}
                onChange={(e) => setLibSearch(e.target.value)}
              />
              <button type="button" className="btn-ghost" onClick={() => void loadLibraryNovels()} disabled={libLoading}>
                {libLoading ? '加载中…' : '刷新书架'}
              </button>
              <button type="button" className="btn-ghost" onClick={closeLibrary}>关闭</button>
            </div>
            {libError ? <div className="error" style={{ marginBottom: 8 }}>{libError}</div> : null}
            <div className="script-library__grid">
              <div className="script-library__col">
                <div className="script-library__col-head">书架（{filteredLibNovels.length}/{libNovels.length}）</div>
                <div className="script-library__scroll">
                  {libLoading && libNovels.length === 0 ? (
                    <div className="download-placeholder" style={{ border: 'none' }}>加载中…</div>
                  ) : filteredLibNovels.length === 0 ? (
                    <div className="download-placeholder" style={{ border: 'none' }}>
                      <p>暂无小说</p>
                      <p className="download-placeholder__sub">请先在首页「小说下载」添加链接并下载。</p>
                    </div>
                  ) : (
                    filteredLibNovels.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        className={`script-library__item${libActiveNovel?.id === n.id ? ' script-library__item--active' : ''}`}
                        onClick={() => selectLibNovel(n)}
                      >
                        <div className="script-library__item-title">{n.title}</div>
                        <div className="script-library__item-meta">
                          {n.author ? `${n.author} · ` : ''}
                          已下 {n.downloaded_chapters}/{n.total_chapters} 章 · 约 {Math.round((n.char_count || 0) / 1000)}k 字
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
              <div className="script-library__col">
                <div className="script-library__col-head">
                  {libActiveNovel ? `章节 · ${libActiveNovel.title}` : '请先选择左侧书籍'}
                </div>
                <div className="script-library__scroll">
                  {!libActiveNovel ? (
                    <div className="download-placeholder" style={{ border: 'none' }}>点击左侧书名查看章节</div>
                  ) : libChaptersLoading ? (
                    <div className="download-placeholder" style={{ border: 'none' }}>加载章节…</div>
                  ) : libChapters.length === 0 ? (
                    <div className="download-placeholder" style={{ border: 'none' }}>本书暂无章节记录</div>
                  ) : (
                    libChapters.map((ch) => {
                      const ok = Boolean(ch.downloaded);
                      return (
                        <div key={ch.id} className="script-library__ch-row">
                          <input
                            type="checkbox"
                            checked={libSelectedIds.has(ch.id)}
                            onChange={() => toggleChapterSelected(ch.id)}
                            title="多选后合并插入"
                          />
                          <div className="script-library__ch-info">
                            <div className="script-library__ch-title">{ch.title}</div>
                            <div className={`script-library__ch-badge${ok ? ' script-library__ch-badge--ok' : ''}`}>
                              {ok ? '已下载正文' : '未下载 · 需先在「小说下载」拉取'}
                            </div>
                          </div>
                          <div className="script-library__ch-actions">
                            <button
                              type="button"
                              className="btn-ghost"
                              disabled={libBusy}
                              onClick={() => void insertSingleChapter(ch.id)}
                            >
                              插入
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
            <p className="script-library__hint">
              插入的内容会追加到上方「小说节选」文本框（带 <code>## 章节名</code> 标题）。可多次插入；节选过长时请自行删改以控制模型上下文。
            </p>
            <div className="script-library__foot">
              <button
                type="button"
                className="btn-primary"
                disabled={!libActiveNovel || libSelectedIds.size === 0 || libBusy}
                onClick={() => void insertSelectedChapters()}
              >
                {libBusy ? '插入中…' : `合并插入选中章节（${libSelectedIds.size}）`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {renameTarget ? (
        <div className="modal-overlay" onClick={() => !renameBusy && setRenameTarget(null)}>
          <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">重命名草稿</h2>
            <input
              type="text"
              className="toolbar-key"
              style={{ width: '100%', marginBottom: 12 }}
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitRename();
                if (e.key === 'Escape') setRenameTarget(null);
              }}
            />
            <div className="modal__actions">
              <button type="button" className="btn-ghost" disabled={renameBusy} onClick={() => setRenameTarget(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={renameBusy || !renameValue.trim()}
                onClick={() => void submitRename()}
              >
                {renameBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="modal-overlay" onClick={() => !deleteBusy && setDeleteTarget(null)}>
          <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">删除草稿？</h2>
            <p className="modal__body-text">
              确定删除「{deleteTarget.title}」吗？剧本正文将一并删除，且不可恢复。
            </p>
            <div className="modal__actions">
              <button type="button" className="btn-ghost" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>
                取消
              </button>
              <button type="button" className="btn-danger" disabled={deleteBusy} onClick={() => void performDeleteScript()}>
                {deleteBusy ? '删除中…' : '删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
