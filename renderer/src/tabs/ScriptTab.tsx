import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { marked } from 'marked';
import { apiFetch, getBackendBase } from '../hooks/useBackend';
import {
  EV_RELOAD_CHARACTERS,
  EV_RELOAD_EDIT,
  EV_RELOAD_EPISODES,
  EV_RELOAD_STORYBOARD,
  importCharactersFromPhase,
  importEditScriptFromPhase,
  importEpisodesFromPhase,
  importScriptSnippetToEpisodes,
  importStoryboardFromPhase,
} from '../lib/pipelineImport';
import { detectChapters, extractChapterText, type DetectedChapter } from '../lib/chapterDetect';
import { useLlmSettings } from '../context/LlmSettingsContext';
import {
  SHORT_DRAMA_TYPES_STORAGE_KEY,
  TAG_SECTIONS,
  buildShortDramaTypesPayload,
  getPrimaryOptions,
  getSecondaryOptions,
  loadShortDramaMeta,
  loadShortDramaTagSet,
  saveShortDramaMeta,
  type ShortDramaAudience,
  type ShortDramaMeta,
} from '../lib/shortDramaTaxonomy';

marked.setOptions({ gfm: true, breaks: true });

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 沉浸页：Markdown 预览与原文编辑区分割条 */
const SCRIPT_RAW_PANE_MIN = 80;
const SCRIPT_MD_PANE_MIN = 100;
const SCRIPT_SPLITTER_H = 8;

/** 结构化阶段：侧栏会解析导入；流水线正文区仍展示完整 JSON 便于核对 */
const PHASE_SYNC_PAGES: Record<string, string> = {
  characters: '角色',
  storyboard: '分镜',
  edit_script: '剪辑脚本',
  episode_skeleton: '集数',
  adapt_outline: '集数',
};

type JobType = 'feature' | 'short_drama' | 'novel_adapt';
interface ScriptRecord { id: number; title: string; content: string; stage: string; created_at: string }

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

/** 合并输入框：首行 → 梗概，换行后为补充约束（与后端 logline / notes 兼容） */
function splitIdeaBlock(text: string): { logline: string; notes: string } {
  const raw = text.replace(/\r\n/g, '\n');
  const i = raw.indexOf('\n');
  if (i === -1) return { logline: raw.trim(), notes: '' };
  return { logline: raw.slice(0, i).trim(), notes: raw.slice(i + 1).trim() };
}

interface Props {
  projectId: number;
  projectType: string;
}

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
  const { llmPresetId, llmKeys, llmPresets } = useLlmSettings();
  const [scripts, setScripts] = useState<ScriptRecord[]>([]);
  const [activeScript, setActiveScript] = useState<ScriptRecord | null>(null);
  const [editor, setEditor] = useState('');
  const [ideaBlock, setIdeaBlock] = useState('');
  const [novelExcerpt, setNovelExcerpt] = useState('');
  /** 仅小说改编：改编补充约束 */
  const [novelAdaptNotes, setNovelAdaptNotes] = useState('');
  const [status, setStatus] = useState('就绪');
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [dramaMeta, setDramaMeta] = useState<ShortDramaMeta>(() => loadShortDramaMeta());
  const [tagFilter, setTagFilter] = useState('');
  const [shortDramaTypes, setShortDramaTypes] = useState<Set<string>>(() => loadShortDramaTagSet());
  /** 短剧：目标集数（可选），留空则由模型自拟 */
  const [targetEpisodesDraft, setTargetEpisodesDraft] = useState('');
  /** 增量生成：本次写第几集到第几集 */
  const [epRangeStart, setEpRangeStart] = useState('');
  const [epRangeEnd, setEpRangeEnd] = useState('');
  const [saving, setSaving] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  /** 沉浸模式：隐藏侧栏与生成参数区，剧本编辑区占满主区域 */
  const [editorImmersive, setEditorImmersive] = useState(false);
  /** SSE 任务进行中（与退出沉浸无关；用于提示后台仍在生成） */
  const [jobStreaming, setJobStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const novelFileRef = useRef<HTMLInputElement | null>(null);
  const autoSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 服务端 persist_verify 已成功入库的阶段，flush 时跳过前端重复写入 */
  const serverPersistedPhasesRef = useRef<Set<string>>(new Set());

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

  const [txtChapters, setTxtChapters] = useState<DetectedChapter[]>([]);
  const [txtFullText, setTxtFullText] = useState('');
  const [txtFileName, setTxtFileName] = useState('');
  const [showTxtChapters, setShowTxtChapters] = useState(false);
  const [txtSelectedIdxs, setTxtSelectedIdxs] = useState<Set<number>>(() => new Set());
  const [txtChapterSearch, setTxtChapterSearch] = useState('');

  const [renameTarget, setRenameTarget] = useState<ScriptRecord | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScriptRecord | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // 流水线类型与项目类型一致，不在界面中允许切换，避免误操作
  const jobType: JobType =
    projectType === 'novel_adapt' || projectType === 'short_drama' || projectType === 'feature'
      ? (projectType as JobType)
      : 'short_drama';

  const primaryOptions = useMemo(() => [...getPrimaryOptions(dramaMeta.audience)], [dramaMeta.audience]);
  const secondaryOptions = useMemo(() => getSecondaryOptions(dramaMeta.primary), [dramaMeta.primary]);

  /** 结束集 < 目标集数时提示：本批只会生成该范围，避免误以为「目标3」就会跑满三集 */
  const episodeRangeVsTargetHint = useMemo(() => {
    const t = parseInt(targetEpisodesDraft.trim(), 10);
    const rs = parseInt(epRangeStart.trim(), 10);
    const re = parseInt(epRangeEnd.trim(), 10);
    if (!Number.isFinite(t) || t < 1 || t > 120) return null;
    if (!Number.isFinite(rs) || !Number.isFinite(re)) return null;
    if (re >= t) return null;
    return { t, rs, re, span: re - rs + 1 };
  }, [targetEpisodesDraft, epRangeStart, epRangeEnd]);

  useEffect(() => {
    saveShortDramaMeta(dramaMeta);
  }, [dramaMeta]);

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

  useEffect(() => { void loadScripts(); }, [loadScripts]);

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

  /** 「续写」等场景必须传入覆盖值：setState 后立刻 runJob 时，闭包里的 epRangeStart 仍为旧状态，会导致 episode_range 未下发、分镜不导入。 */
  const runJob = async (episodeRangeOverride?: { start: number; end: number }) => {
    if (!llmPresetId) { setError('请先在首页「设置」中配置模型预设与 API Key'); return; }

    const { logline, notes: notesFromIdea } = splitIdeaBlock(ideaBlock);
    const notesForJob =
      jobType === 'novel_adapt' ? novelAdaptNotes.trim() : notesFromIdea;

    if (jobType !== 'novel_adapt' && !logline) { setError('请填写梗概（第一行）'); return; }
    if (jobType === 'novel_adapt' && !novelExcerpt.trim()) { setError('请粘贴小说节选'); return; }

    let targetEpisodesPayload: number | undefined;
    const te = targetEpisodesDraft.trim();
    if (te !== '') {
      const n = parseInt(te, 10);
      if (!Number.isFinite(n) || n < 1 || n > 120) {
        setError('可选集数须为 1～120 的整数，或留空交由模型规划');
        return;
      }
      targetEpisodesPayload = n;
    }

    let rangeStart: number | undefined;
    let rangeEnd: number | undefined;
    if (episodeRangeOverride != null) {
      rangeStart = episodeRangeOverride.start;
      rangeEnd = episodeRangeOverride.end;
      if (!Number.isFinite(rangeStart) || rangeStart < 1) {
        setError('起始集数须为正整数'); return;
      }
      if (!Number.isFinite(rangeEnd) || rangeEnd < 1) {
        setError('结束集数须为正整数'); return;
      }
      if (rangeEnd < rangeStart) {
        setError('结束集数不能小于起始集数'); return;
      }
    } else {
      if (epRangeStart.trim()) {
        rangeStart = parseInt(epRangeStart.trim(), 10);
        if (!Number.isFinite(rangeStart) || rangeStart < 1) {
          setError('起始集数须为正整数'); return;
        }
      }
      if (epRangeEnd.trim()) {
        rangeEnd = parseInt(epRangeEnd.trim(), 10);
        if (!Number.isFinite(rangeEnd) || rangeEnd < 1) {
          setError('结束集数须为正整数'); return;
        }
      }
      if (rangeStart && rangeEnd && rangeEnd < rangeStart) {
        setError('结束集数不能小于起始集数'); return;
      }
    }

    const base = await getBackendBase();
    let targetScriptId = activeScript?.id;
    if (!targetScriptId) {
      const titleSeed = jobType === 'novel_adapt' ? novelExcerpt.trim().slice(0, 24) : logline;
      const s = await apiFetch<ScriptRecord>(base, `/api/projects/${projectId}/scripts`, {
        method: 'POST',
        body: JSON.stringify({ title: (titleSeed || '新剧本').trim() || '新剧本', content: '' }),
      });
      setScripts((prev) => [s, ...prev]);
      setActiveScript(s);
      targetScriptId = s.id;
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setJobStreaming(true);
    setEditorImmersive(true);
    setSidebarOpen(false);
    setEditor('');
    setPhase('');
    setStatus('生成中…');
    setError('');
    serverPersistedPhasesRef.current.clear();

    const shouldImportSides = jobType === 'short_drama' || jobType === 'novel_adapt';

    // Detect continue (append) mode: range start > 1 means we are adding to existing data
    const isContinueMode = rangeStart !== undefined && rangeStart > 1;

    let fullText = '';

    /** 小说改编逐集 SSE：当前流水线集号，用于分镜 CUT-xxx 等无 EP 时的导入归入 */
    let latestPipelineEpisode: number | undefined;

    /** 服务端已写入 DB 或跳过前端导入时，仍需通知侧栏 Tab 重新拉取 API */
    const dispatchSidebarReloadForPhase = (pid: string) => {
      switch (pid) {
        case 'characters':
          window.dispatchEvent(new Event(EV_RELOAD_CHARACTERS));
          break;
        case 'storyboard':
          window.dispatchEvent(new Event(EV_RELOAD_STORYBOARD));
          break;
        case 'edit_script':
          window.dispatchEvent(new Event(EV_RELOAD_EDIT));
          break;
        case 'novel_screenplay':
        case 'script_snippet':
        case 'episode_scripts':
          window.dispatchEvent(new Event(EV_RELOAD_EPISODES));
          break;
        default:
          break;
      }
    };

    const flushCompletedPhase = async (phaseId: string | null, raw: string) => {
      if (!phaseId || !targetScriptId) return;
      try {
        await saveContent(fullText, targetScriptId);
      } catch {
        /* 保存失败仍尝试侧栏导入 */
      }
      if (!shouldImportSides || !raw.trim()) return;
      const SERVER_DB_PHASES = new Set([
        'characters',
        'novel_screenplay',
        'script_snippet',
        'episode_scripts',
        'storyboard',
        'edit_script',
      ]);
      if (SERVER_DB_PHASES.has(phaseId) && serverPersistedPhasesRef.current.has(phaseId)) {
        serverPersistedPhasesRef.current.delete(phaseId);
        setEditor((p) => p + `\n✓「${phaseId}」服务端已校验并写入数据库，跳过前端重复导入（已刷新侧栏）\n`);
        dispatchSidebarReloadForPhase(phaseId);
        return;
      }
      try {
        if (phaseId === 'characters') {
          const n = await importCharactersFromPhase(projectId, raw, {
            upsertExisting: isContinueMode,
          });
          window.dispatchEvent(new Event(EV_RELOAD_CHARACTERS));
          setEditor(
            (p) =>
              p +
              `\n✓ 已同步 ${n} 条角色到角色库${isContinueMode ? '（续写：含新增与同名更新）' : ''}\n`,
          );
        } else if (phaseId === 'storyboard') {
          const sbHint =
            jobType === 'novel_adapt' &&
            latestPipelineEpisode != null &&
            latestPipelineEpisode >= 1
              ? { defaultEpisodeNumber: latestPipelineEpisode }
              : undefined;
          const n = await importStoryboardFromPhase(projectId, raw, isContinueMode, sbHint);
          window.dispatchEvent(new Event(EV_RELOAD_STORYBOARD));
          setEditor((p) => p + `\n✓ 已导入 ${n} 个镜头到分镜库${isContinueMode ? '（续写·追加）' : ''}\n`);
        } else if (phaseId === 'edit_script') {
          const n = await importEditScriptFromPhase(projectId, raw, isContinueMode);
          window.dispatchEvent(new Event(EV_RELOAD_EDIT));
          setEditor((p) => p + `\n✓ 已导入 ${n} 条剪辑单到剪辑脚本${isContinueMode ? '（续写·末尾追加）' : '（已尽量按 EP/「第N集」只替换涉及的集）'}\n`);
        } else if (phaseId === 'episode_skeleton' || phaseId === 'adapt_outline') {
          const n = await importEpisodesFromPhase(projectId, raw);
          window.dispatchEvent(new Event(EV_RELOAD_EPISODES));
          setEditor((p) => p + `\n✓ 已导入 ${n} 集集数规划\n`);
        } else if (phaseId === 'script_snippet' || phaseId === 'episode_scripts' || phaseId === 'novel_screenplay') {
          const n = await importScriptSnippetToEpisodes(
            projectId,
            raw,
            rangeStart !== undefined
              ? { rangeStart, rangeEnd: rangeEnd ?? rangeStart }
              : undefined,
          );
          if (n > 0) {
            window.dispatchEvent(new Event(EV_RELOAD_EPISODES));
            setEditor((p) => p + `\n✓ 已将 ${n} 集剧本正文写入集数库\n`);
          }
        }
      } catch (importErr) {
        console.error(`[pipelineImport] phase=${phaseId}`, importErr);
        setEditor((p) => p + `\n⚠ 「${phaseId}」自动导入失败：${String((importErr as Error).message).slice(0, 120)}（请手动导入）\n`);
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
          preset_id: llmPresetId,
          logline,
          novel_excerpt: novelExcerpt,
          notes: notesForJob,
          short_drama_types:
            jobType === 'short_drama' ? buildShortDramaTypesPayload(dramaMeta, shortDramaTypes) : [],
          ...(targetEpisodesPayload !== undefined
            ? { target_episodes: targetEpisodesPayload }
            : {}),
          ...(rangeStart !== undefined ? { episode_range_start: rangeStart } : {}),
          ...(rangeEnd !== undefined ? { episode_range_end: rangeEnd } : {}),
          project_id: projectId,
          llm_api_key: (llmKeys[llmPresetId] ?? '').trim(),
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

          if (obj.type === 'agent_start') {
            const agentLabel = String(obj.label || obj.agent || '');
            const header = `\n\n══════ 🎬 ${agentLabel} 开始工作 ══════\n`;
            fullText += header;
            setEditor((p) => p + header);
            setStatus(`${agentLabel} 工作中…`);
          }

          if (obj.type === 'agent_done') {
            const agentLabel = String(obj.label || obj.agent || '');
            const footer = `\n══════ ✓ ${agentLabel} 完成 ══════\n`;
            fullText += footer;
            setEditor((p) => p + footer);
          }

          if (obj.type === 'episode_block') {
            const ep = Number(obj.episode) || 0;
            const hi = Number(obj.episode_end) || ep;
            if (ep > 0) latestPipelineEpisode = ep;
            const line = `\n\n████████ 第 ${ep}/${hi} 集 · 本集：剧本→导演→分镜→导演→剪辑→导演 ████████\n`;
            fullText += line;
            setEditor((p) => p + line);
            setStatus(`逐集流水线：${ep}/${hi}…`);
          }

          if (obj.type === 'director_review_start') {
            const retryHint = Number(obj.retry_round) > 0 ? `（第${obj.retry_round}轮重审）` : '';
            const header = `\n  ┄┄ 导演审查「${String(obj.phase_id || '')}」${retryHint} ┄┄\n`;
            fullText += header;
            setEditor((p) => p + header);
          }

          if (obj.type === 'director_review') {
            const verdict = String(obj.verdict || '');
            const score = Number(obj.score) || 0;
            const fb = String(obj.feedback || '');
            const icon = verdict === 'PASS' ? '✅' : '🔄';
            const scoreBar = '★'.repeat(Math.min(score, 10)) + '☆'.repeat(Math.max(0, 10 - score));
            const line = `  ${icon} 导演评审：${verdict} ${scoreBar}（${score}/10）${fb ? '\n  ' + fb.slice(0, 300) : ''}\n`;
            fullText += line;
            setEditor((p) => p + line);
          }

          if (obj.type === 'persist_verify') {
            const pid = String(obj.phase_id || '');
            const ok = obj.ok === true;
            const applied = obj.applied === true;
            const detail = String(obj.detail || '').slice(0, 280);
            const icon = ok && applied ? '✓' : '⚠';
            const tail = applied ? '（已写入数据库，侧栏将同步可见）' : '';
            const line = `\n  ${icon} 入库校验「${pid}」${tail}${detail ? '：' + detail : ''}\n`;
            fullText += line;
            setEditor((p) => p + line);
            if (applied && pid) {
              serverPersistedPhasesRef.current.add(pid);
              dispatchSidebarReloadForPhase(pid);
            }
          }

          if (obj.type === 'character_export_verify') {
            const pid = String(obj.phase_id || 'characters');
            const ok = obj.ok === true;
            const detail = String(obj.detail || '').slice(0, 240);
            const line = `\n  ${ok ? '✓' : '⚠'} 角色 JSON 校验「${pid}」${detail ? '：' + detail : ''}\n`;
            fullText += line;
            setEditor((p) => p + line);
          }

          if (obj.type === 'pulse') {
            const ch = Number(obj.chars) || 0;
            const kb = ch >= 1000 ? `${(ch / 1000).toFixed(1)}k` : `${ch}`;
            const rr = Number(obj.retry_round) || 0;
            const mr = Number(obj.max_retry) || 1;
            const pid = String(obj.phase_id || '');
            if (rr > 0) {
              setStatus(`重写中（${rr}/${mr}）· ${pid} · 已输出约 ${kb} 字…`);
            } else {
              setStatus(`生成中· ${pid} · 已输出约 ${kb} 字…`);
            }
          }

          if (obj.type === 'storyboard_overcap_regen') {
            const n = Number(obj.shots_before_cap) || 0;
            const maxS = Number(obj.max_shots) || 45;
            const attempt = Number(obj.attempt) || 1;
            const line = `\n  ⚠ 分镜条数超限（${n} 条 > 上限 ${maxS}），已截断上一轮；正自动第 ${attempt} 次重生成「storyboard」…\n`;
            fullText += line;
            setEditor((p) => p + line);
            setStatus(`分镜条数超限，重生成中（第 ${attempt} 次）…`);
          }

          if (obj.type === 'retry') {
            const round = Number(obj.retry_round) || 1;
            const maxR = Number(obj.max_retry) || 1;
            const reason = String(obj.reason || '').slice(0, 120);
            const persistFmt = obj.persist_format === true;
            const characterJson = obj.character_json === true;
            const label = persistFmt ? '入库/格式自愈' : characterJson ? '角色 JSON 自愈' : '导演要求重写';
            const line = `\n  🔁 ${label}「${String(obj.phase_id || '')}」（${round}/${maxR}）${reason ? '：' + reason : ''}\n`;
            fullText += line;
            setEditor((p) => p + line);
            setStatus(`重写中（${round}/${maxR}）…`);
          }

          if (obj.type === 'phase_complete') {
            const pct = Number(obj.progress_pct) || 0;
            const score = Number(obj.score) || 0;
            const scoreHint = score > 0 ? ` | 评分 ${score}/10` : '';
            setStatus(`进度 ${pct}%${scoreHint}`);
          }

          if (obj.type === 'phase') {
            const newId = String(obj.phase_id || '');
            const agentLabel = obj.agent ? ` [${String(obj.agent)}]` : '';
            const pct = Number(obj.progress_pct) || 0;
            if (streamPhaseId) await flushCompletedPhase(streamPhaseId, phaseAccum);
            streamPhaseId = newId || null;
            phaseAccum = '';
            setPhase(newId);
            const pctHint = pct > 0 ? ` (${pct}%)` : '';
            const header = `\n\n===== 阶段：${newId}${agentLabel}${pctHint} =====\n`;
            fullText += header;
            const syncPage = newId ? PHASE_SYNC_PAGES[newId] : undefined;
            const syncNote = syncPage ? `（侧栏「${syncPage}」会尝试同步；以下为该阶段完整输出。）\n` : '';
            setEditor((p) => p + header + syncNote);
          }
          if (obj.type === 'delta' && obj.text) {
            const chunk = String(obj.text);
            /* 多智能体编排：每阶段是一次完整快照（导演重试会再发一整段）；追加会把两段 JSON 粘死导致导入解析失败 */
            phaseAccum = chunk;
            fullText += chunk;
            setEditor((p) => p + chunk);
          }
          if (obj.type === 'done') {
            const elapsed = Number(obj.elapsed_sec) || 0;
            const timeHint = elapsed > 0 ? `（耗时 ${elapsed}s）` : '';
            const memHint = obj.memory_saved ? ' | 已同步记忆' : '';
            setStatus(`完成 ${timeHint}${memHint}`);
            /* 兜底：任意阶段若漏发 reload，收尾统一刷新侧栏 Tab */
            if (shouldImportSides && projectId) {
              window.dispatchEvent(new Event(EV_RELOAD_CHARACTERS));
              window.dispatchEvent(new Event(EV_RELOAD_STORYBOARD));
              window.dispatchEvent(new Event(EV_RELOAD_EDIT));
              window.dispatchEvent(new Event(EV_RELOAD_EPISODES));
            }
          }
          if (obj.type === 'meta') {
            const pipelineLabel = obj.pipeline === 'multi_agent' ? '多智能体' : '线性';
            const qg = obj.quality_gate_threshold ? `，质量门控 ≥${obj.quality_gate_threshold}/10` : '';
            const continueHint = obj.continue_mode ? ' | 续写模式' : '';
            const rangeHint = Array.isArray(obj.episode_range) && obj.episode_range[0]
              ? ` | 第${obj.episode_range[0]}–${obj.episode_range[1] || '?'}集`
              : '';
            const memHint = obj.has_memory ? ' | 已加载记忆' : '';
            const episodicHint = obj.novel_episodic ? ' | 小说改编·逐集衔接' : '';
            const planHint = Array.isArray(obj.episode_plan) && obj.episode_plan.length >= 2
              ? ` | 规划集 ${obj.episode_plan[0]}–${obj.episode_plan[1]}`
              : '';
            const persistBrief =
              obj.server_db_write_enabled === false && obj.post_pass_persist_verify
                ? ' | ⚠未绑定项目：仅审稿，不入库'
                : obj.director_quality_gate_enabled && obj.server_db_write_enabled && obj.post_pass_persist_verify
                  ? ' | 每阶段：导演审稿→persist_verify→侧栏刷新'
                  : '';
            const novelContinueZh = typeof obj.novel_continue_same_gates_zh === 'string'
              ? `\n　${obj.novel_continue_same_gates_zh}`
              : '';
            setEditor((p) => p + novelContinueZh);
            setStatus(`${pipelineLabel}流水线启动（共 ${Number(obj.phases_total) || '?'} 段${qg}${continueHint}${rangeHint}${memHint}${episodicHint}${planHint}${persistBrief}）`);
          }
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
    } finally {
      setJobStreaming(false);
    }
  };

  const stopJob = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setJobStreaming(false);
    setStatus('已中止');
  };

  const continueGeneration = async () => {
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{
        episodes: Array<{ ep_number: number; status: string; script_content?: string }>;
      }>(base, `/api/projects/${projectId}/episodes`);
      const eps = data.episodes || [];
      const sorted = [...eps].sort((a, b) => a.ep_number - b.ep_number);

      const epLooksIncomplete = (e: (typeof sorted)[0]): boolean => {
        const body = (e.script_content || '').trim();
        const okStatus = e.status === 'scripted' || e.status === 'done';
        return !okStatus || body.length < 40;
      };

      const gap = sorted.find(epLooksIncomplete);
      if (!gap) {
        setError(sorted.length ? `所有 ${sorted.length} 集均已写稿，无需续写` : '暂无集数，请先在大纲阶段生成集数');
        return;
      }

      const nextStart = gap.ep_number;
      const batchSize = 3;
      const maxEp = sorted.length ? Math.max(...sorted.map((e) => e.ep_number)) : nextStart;
      const nextEnd = Math.min(nextStart + batchSize - 1, maxEp);

      setEpRangeStart(String(nextStart));
      setEpRangeEnd(String(nextEnd));
      setStatus(`续写模式：第 ${nextStart}–${nextEnd} 集（从首个缺稿集起）`);

      void runJob({ start: nextStart, end: nextEnd });
    } catch (e) {
      setError(`获取集数失败：${String((e as Error).message)}`);
    }
  };

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
    reader.onload = () => {
      const raw = String(reader.result ?? '');
      const chapters = detectChapters(raw);
      if (chapters.length >= 2) {
        setTxtFullText(raw);
        setTxtFileName(file.name);
        setTxtChapters(chapters);
        setTxtSelectedIdxs(new Set());
        setTxtChapterSearch('');
        setShowTxtChapters(true);
      } else {
        setNovelExcerpt(raw);
      }
    };
    reader.readAsText(file, 'UTF-8');
    e.target.value = '';
  };

  const toggleTxtChapter = (idx: number) => {
    setTxtSelectedIdxs((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const selectAllTxtChapters = () => {
    const visible = filteredTxtChapters.map((c) => c.index);
    setTxtSelectedIdxs((prev) => {
      const allSelected = visible.every((i) => prev.has(i));
      const next = new Set(prev);
      if (allSelected) {
        visible.forEach((i) => next.delete(i));
      } else {
        visible.forEach((i) => next.add(i));
      }
      return next;
    });
  };

  const selectTxtRange = (from: number, to: number) => {
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    setTxtSelectedIdxs((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(i);
      return next;
    });
  };

  const insertTxtSelectedChapters = () => {
    if (txtSelectedIdxs.size === 0) return;
    const sorted = [...txtSelectedIdxs].sort((a, b) => a - b);
    let combined = '';
    for (const idx of sorted) {
      const ch = txtChapters[idx];
      if (!ch) continue;
      const body = extractChapterText(txtFullText, ch);
      combined += `\n\n## ${ch.title}\n\n${body}\n`;
    }
    if (combined.trim()) {
      setNovelExcerpt((prev) => {
        const p = prev.trim();
        return p ? p + combined : combined.trim();
      });
    }
    setShowTxtChapters(false);
  };

  const insertAllTxtChapters = () => {
    setNovelExcerpt(txtFullText);
    setShowTxtChapters(false);
  };

  const filteredTxtChapters = useMemo(() => {
    const q = txtChapterSearch.trim().toLowerCase();
    if (!q) return txtChapters;
    return txtChapters.filter((c) => c.title.toLowerCase().includes(q));
  }, [txtChapters, txtChapterSearch]);

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

  const llmPresetLabel = llmPresets.find((p) => p.id === llmPresetId)?.label;

  const editorHtml = useMemo(() => {
    const raw = editor || '';
    if (!raw.trim()) return '';
    try {
      return marked.parse(raw, { async: false }) as string;
    } catch {
      return `<pre class="script-md__fallback">${escapeHtml(raw)}</pre>`;
    }
  }, [editor]);

  const streamMdRef = useRef<HTMLDivElement | null>(null);
  const splitHostRef = useRef<HTMLDivElement | null>(null);
  const [copyFlash, setCopyFlash] = useState(false);
  /** 原文编辑区展开时，与上方预览之间的可拖动分割 */
  const [rawEditorOpen, setRawEditorOpen] = useState(false);
  const [rawPaneHeight, setRawPaneHeight] = useState(220);

  useEffect(() => {
    if (!editorImmersive || status !== '生成中…') return;
    const el = streamMdRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [editor, editorImmersive, status]);

  const copyEditor = async () => {
    try {
      await navigator.clipboard.writeText(editor);
      setCopyFlash(true);
      window.setTimeout(() => setCopyFlash(false), 1600);
    } catch {
      setError('复制失败，请检查系统剪贴板权限。');
    }
  };

  const onRawSplitMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const host = splitHostRef.current;
      if (!host) return;
      const startY = e.clientY;
      const startH = rawPaneHeight;

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientY - startY;
        const next = Math.round(startH + delta);
        const maxRaw = Math.max(
          SCRIPT_RAW_PANE_MIN,
          host.clientHeight - SCRIPT_MD_PANE_MIN - SCRIPT_SPLITTER_H
        );
        setRawPaneHeight(Math.min(maxRaw, Math.max(SCRIPT_RAW_PANE_MIN, next)));
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [rawPaneHeight]
  );

  useLayoutEffect(() => {
    if (!rawEditorOpen || !editorImmersive) return;
    const el = splitHostRef.current;
    if (!el) return;
    const maxRaw = Math.max(
      SCRIPT_RAW_PANE_MIN,
      el.clientHeight - SCRIPT_MD_PANE_MIN - SCRIPT_SPLITTER_H
    );
    setRawPaneHeight((h) =>
      Math.min(Math.max(SCRIPT_RAW_PANE_MIN, h), maxRaw)
    );
  }, [rawEditorOpen, editorImmersive]);

  return (
    <div className={`script-tab${editorImmersive ? ' script-tab--immersive' : ''}`}>
      {/* ── 左侧历史列表 ── */}
      <aside className={`script-tab__history${sidebarOpen && !editorImmersive ? '' : ' script-tab__history--closed'}`}>
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
          <button
            className="btn-icon"
            onClick={() => {
              if (editorImmersive) {
                setEditorImmersive(false);
                setSidebarOpen(true);
                return;
              }
              setSidebarOpen((v) => !v);
            }}
            title={
              editorImmersive
                ? '退出沉浸并展开版本列表（不会中止生成）'
                : '切换版本列表'
            }
          >
            ☰
          </button>
          <span className="script-tab__toolbar-spacer" aria-hidden />
          {llmPresetId ? (
            <span className="toolbar-llm-hint" title="在首页「设置」中可更换模型与 Key">
              {llmPresetLabel || llmPresetId}
            </span>
          ) : (
            <span className="toolbar-llm-hint toolbar-llm-hint--warn">请先到首页「设置」配置模型</span>
          )}
        </div>

        {!editorImmersive ? (
          <div className="script-tab__body-scroll">
        {jobType === 'short_drama' ? (
          <div className="drama-taxonomy">
            <div className="drama-taxonomy__row">
              <span className="drama-taxonomy__label">目标读者</span>
              <div className="drama-taxonomy__radios">
                <label
                  className={`drama-radio${dramaMeta.audience === 'male' ? ' drama-radio--on' : ''}`}
                >
                  <input
                    type="radio"
                    name="drama-audience"
                    checked={dramaMeta.audience === 'male'}
                    onChange={() => {
                      const audience: ShortDramaAudience = 'male';
                      const p = getPrimaryOptions(audience)[0] ?? '都市';
                      const s = getSecondaryOptions(p)[0] ?? '不限';
                      setDramaMeta({ audience, primary: p, secondary: s });
                    }}
                  />
                  <span className="drama-radio__main">男生</span>
                  <span className="drama-radio__sub">以男生受众为主的作品</span>
                </label>
                <label
                  className={`drama-radio${dramaMeta.audience === 'female' ? ' drama-radio--on' : ''}`}
                >
                  <input
                    type="radio"
                    name="drama-audience"
                    checked={dramaMeta.audience === 'female'}
                    onChange={() => {
                      const audience: ShortDramaAudience = 'female';
                      const p = getPrimaryOptions(audience)[0] ?? '现代言情';
                      const s = getSecondaryOptions(p)[0] ?? '不限';
                      setDramaMeta({ audience, primary: p, secondary: s });
                    }}
                  />
                  <span className="drama-radio__main">女生</span>
                  <span className="drama-radio__sub">以女生受众为主的作品</span>
                </label>
              </div>
            </div>
            <div className="drama-taxonomy__row drama-taxonomy__row--types">
              <span className="drama-taxonomy__label">剧本类型</span>
              <div className="drama-taxonomy__selects">
                <select
                  className="toolbar-select drama-taxonomy__select"
                  value={dramaMeta.primary}
                  onChange={(e) => {
                    const primary = e.target.value;
                    const secondary = getSecondaryOptions(primary)[0] ?? '不限';
                    setDramaMeta((m) => ({ ...m, primary, secondary }));
                  }}
                >
                  {primaryOptions.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <select
                  className="toolbar-select drama-taxonomy__select"
                  value={dramaMeta.secondary}
                  onChange={(e) => setDramaMeta((m) => ({ ...m, secondary: e.target.value }))}
                >
                  {secondaryOptions.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="drama-taxonomy__tags-bar">
              <span className="drama-taxonomy__label">剧本标签</span>
              <input
                type="search"
                className="drama-taxonomy__filter"
                placeholder="在当前分类中筛选标签…"
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
              />
            </div>
            <p className="drama-taxonomy__hint">以下为可多选标签，将与会话类型一并写入各阶段提示词（drama_types）。</p>
            {TAG_SECTIONS.map((section) => {
              const q = tagFilter.trim().toLowerCase();
              const tags = q.length
                ? section.tags.filter((t) => t.toLowerCase().includes(q))
                : section.tags;
              return (
                <details key={section.id} className="drama-taxonomy__section" open={section.id === 'style'}>
                  <summary className="drama-taxonomy__summary">
                    {section.label}
                    <span className="drama-taxonomy__count">{tags.length}</span>
                  </summary>
                  <div className="drama-taxonomy__chips" role="group" aria-label={section.label}>
                    {tags.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className={`drama-chip${shortDramaTypes.has(t) ? ' drama-chip--on' : ''}`}
                        aria-pressed={shortDramaTypes.has(t)}
                        onClick={() => toggleShortDramaType(t)}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        ) : null}

        {/* 生成参数 */}
        <div className="script-tab__params">
          {jobType !== 'novel_adapt' ? (
            <textarea
              className="script-tab__idea-block"
              rows={5}
              placeholder={'第一行：一句话梗概 / 创意（必填）\n从第二行起：补充约束（口吻、篇幅、禁忌等，可选）'}
              value={ideaBlock}
              onChange={(e) => setIdeaBlock(e.target.value)}
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
                {novelExcerpt.trim() && (
                  <span className="novel-char-count">
                    已载入 {Math.round(novelExcerpt.replace(/\s/g, '').length / 1000)}k 字
                  </span>
                )}
              </div>
              <textarea
                className="script-tab__idea-block"
                rows={6}
                placeholder="小说节选（粘贴、导入 .txt，或从下载库插入章节）"
                value={novelExcerpt}
                onChange={(e) => setNovelExcerpt(e.target.value)}
              />
              <textarea
                className="script-tab__novel-notes"
                rows={3}
                placeholder="改编补充约束（默认：人物设定/经历/外形须忠实原著，仅剧情为拍摄做取舍；可写目标集数、口吻等，若需合并人物或改人设请在此明确说明）"
                value={novelAdaptNotes}
                onChange={(e) => setNovelAdaptNotes(e.target.value)}
              />
            </div>
          )}
        </div>

        {/* 集数与生成范围（短剧 + 小说改编共用） */}
        {(jobType === 'short_drama' || jobType === 'novel_adapt') && (
          <div className="episode-controls">
            <div className="episode-controls__row">
              <span className="episode-controls__label">目标集数</span>
              <div className="episode-controls__field">
                <input
                  type="number"
                  className="episode-controls__input"
                  min={1}
                  max={120}
                  step={1}
                  placeholder="留空自拟"
                  inputMode="numeric"
                  value={targetEpisodesDraft}
                  onChange={(e) => setTargetEpisodesDraft(e.target.value)}
                  aria-label="目标集数（可选）"
                />
                <span className="episode-controls__hint">
                  填写则硬约束总集数（1–120）；留空由模型自行规划。
                </span>
              </div>
            </div>
            <div className="episode-controls__row">
              <span className="episode-controls__label">本次生成范围</span>
              <div className="episode-controls__field">
                <div className="episode-controls__range">
                  <span className="episode-controls__range-text">第</span>
                  <input
                    type="number"
                    className="episode-controls__input episode-controls__input--sm"
                    min={1}
                    max={120}
                    step={1}
                    placeholder="1"
                    inputMode="numeric"
                    value={epRangeStart}
                    onChange={(e) => setEpRangeStart(e.target.value)}
                    aria-label="起始集数"
                  />
                  <span className="episode-controls__range-text">集 ~</span>
                  <input
                    type="number"
                    className="episode-controls__input episode-controls__input--sm"
                    min={1}
                    max={120}
                    step={1}
                    placeholder="3"
                    inputMode="numeric"
                    value={epRangeEnd}
                    onChange={(e) => setEpRangeEnd(e.target.value)}
                    aria-label="结束集数"
                  />
                  <span className="episode-controls__range-text">集</span>
                </div>
                <span className="episode-controls__hint">
                  两格都留空则从第 1 集写到目标集数（或与大纲一致）。填写起止则只处理该区间——与「目标集数」同时填写时，若结束集小于目标，本批不会生成后面集的正文/分镜。
                </span>
                {episodeRangeVsTargetHint ? (
                  <div className="episode-controls__warn" role="status">
                    目标集数为 {episodeRangeVsTargetHint.t}，但本次范围到第 {episodeRangeVsTargetHint.re} 集为止——本任务只会生成第 {episodeRangeVsTargetHint.rs}–{episodeRangeVsTargetHint.re} 集（共 {episodeRangeVsTargetHint.span} 集）。若要一次生成全部 {episodeRangeVsTargetHint.t} 集，请将结束集改为 {episodeRangeVsTargetHint.t}，或清空「本次生成范围」两格。
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}
          </div>
        ) : null}

        {error && <div className="error">{error}</div>}

        {jobStreaming && !editorImmersive ? (
          <div className="script-tab__stream-banner" role="status">
            生成仍在进行：流式正文仍在写入当前剧本草稿；点击「⛶ 沉浸」可恢复全屏输出。
            退出沉浸或切换视图<strong>不会</strong>自动中止任务；若要停止请点「中止」。
          </div>
        ) : null}

        <div className="script-tab__action-bar">
          <button
            type="button"
            className={`btn-ghost btn-sm${editorImmersive ? ' btn-active' : ''}`}
            onClick={() => {
              setEditorImmersive((v) => {
                const next = !v;
                if (next) setSidebarOpen(false);
                else setSidebarOpen(true);
                return next;
              });
            }}
            title={
              editorImmersive
                ? '退出沉浸：恢复参数区与侧栏（不会中止生成；需停止请点「中止」）'
                : '沉浸：全屏查看生成输出（Markdown）'
            }
          >
            {editorImmersive ? '退出沉浸' : '⛶ 沉浸'}
          </button>
          <button className="btn-primary" onClick={() => void runJob()}>生成</button>
          <button className="btn-primary" style={{ background: '#2563eb' }} onClick={() => void continueGeneration()}>续写</button>
          <button className="btn-ghost" onClick={stopJob}>中止</button>
          <button className="btn-ghost" onClick={() => void exportFountain()} disabled={!activeScript}>Fountain</button>
          {saving && <span className="toolbar-saving">保存中…</span>}
          {status && <span className="toolbar-status">{status}{phase ? ` · ${phase}` : ''}</span>}
        </div>

        {editorImmersive ? (
          <div className="script-sheet script-sheet--stream">
            <div className="script-sheet__stream-head">
              <span className="script-sheet__stream-title">输出</span>
              <button
                type="button"
                className="btn-ghost btn-sm script-sheet__copy"
                onClick={() => void copyEditor()}
                disabled={!editor.trim()}
              >
                {copyFlash ? '已复制' : '复制'}
              </button>
            </div>
            <div className="script-sheet__split" ref={splitHostRef}>
              <div className="script-sheet__md" ref={streamMdRef}>
                {editor.trim() ? (
                  <div className="script-md" dangerouslySetInnerHTML={{ __html: editorHtml }} />
                ) : (
                  <p className="script-sheet__md-empty">流式正文将在此以 Markdown 呈现…</p>
                )}
              </div>
              {rawEditorOpen ? (
                <div
                  className="script-sheet__splitter"
                  onMouseDown={onRawSplitMouseDown}
                  role="separator"
                  aria-orientation="horizontal"
                  aria-valuemin={SCRIPT_RAW_PANE_MIN}
                  aria-valuenow={rawPaneHeight}
                  title="拖动调整原文编辑区高度"
                />
              ) : null}
              <details
                className="script-sheet__raw"
                open={rawEditorOpen}
                onToggle={(e) => setRawEditorOpen(e.currentTarget.open)}
                style={rawEditorOpen ? { height: rawPaneHeight } : undefined}
              >
                <summary className="script-sheet__raw-summary">编辑 Markdown 原文</summary>
                <textarea
                  className="editor script-sheet__raw-editor"
                  value={editor}
                  onChange={(e) => handleEditorChange(e.target.value)}
                  placeholder="在此修改正文，将同步保存到当前剧本版本…"
                  spellCheck={false}
                />
              </details>
            </div>
          </div>
        ) : null}
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

      {showTxtChapters ? (
        <div className="modal-overlay" onClick={() => setShowTxtChapters(false)}>
          <div className="modal script-library-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">章节识别 · {txtFileName}</h2>
            <p className="txt-chapters__summary">
              共识别 <strong>{txtChapters.length}</strong> 个章节，约
              {' '}{Math.round(txtFullText.replace(/\s/g, '').length / 10000)}万字。
              勾选后插入节选框，或直接导入全文。
            </p>
            <div className="script-library__head">
              <input
                type="search"
                className="script-library__search"
                placeholder="搜索章节标题…"
                value={txtChapterSearch}
                onChange={(e) => setTxtChapterSearch(e.target.value)}
              />
              <button type="button" className="btn-ghost" onClick={selectAllTxtChapters}>
                {filteredTxtChapters.length > 0 && filteredTxtChapters.every((c) => txtSelectedIdxs.has(c.index))
                  ? '取消全选'
                  : '全选当前'}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setShowTxtChapters(false)}>关闭</button>
            </div>
            <div className="txt-chapters__range-bar">
              <span className="txt-chapters__range-label">快速选择：</span>
              <button type="button" className="btn-ghost btn-sm" onClick={() => selectTxtRange(0, Math.min(4, txtChapters.length - 1))}>前5章</button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => selectTxtRange(0, Math.min(9, txtChapters.length - 1))}>前10章</button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => selectTxtRange(0, Math.min(19, txtChapters.length - 1))}>前20章</button>
              {txtChapters.length > 20 && (
                <button type="button" className="btn-ghost btn-sm" onClick={() => selectTxtRange(0, Math.min(49, txtChapters.length - 1))}>前50章</button>
              )}
            </div>
            <div className="txt-chapters__list">
              {filteredTxtChapters.map((ch) => (
                <label
                  key={ch.index}
                  className={`txt-chapters__item${txtSelectedIdxs.has(ch.index) ? ' txt-chapters__item--on' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={txtSelectedIdxs.has(ch.index)}
                    onChange={() => toggleTxtChapter(ch.index)}
                  />
                  <div className="txt-chapters__item-body">
                    <div className="txt-chapters__item-title">
                      <span className="txt-chapters__item-idx">{ch.index + 1}.</span>
                      {ch.title}
                    </div>
                    <div className="txt-chapters__item-meta">
                      {Math.round(ch.charCount / 1000)}k字
                      {ch.preview ? ` · ${ch.preview}` : ''}
                    </div>
                  </div>
                </label>
              ))}
              {filteredTxtChapters.length === 0 && (
                <div className="download-placeholder" style={{ border: 'none' }}>无匹配章节</div>
              )}
            </div>
            <div className="script-library__foot">
              <button
                type="button"
                className="btn-ghost"
                onClick={insertAllTxtChapters}
              >
                导入全文（不按章分割）
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={txtSelectedIdxs.size === 0}
                onClick={insertTxtSelectedChapters}
              >
                插入选中章节（{txtSelectedIdxs.size}）
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
