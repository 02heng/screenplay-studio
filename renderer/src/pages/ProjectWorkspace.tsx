import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppDialog } from '../context/AppDialogContext';
import { apiFetch, getBackendBase } from '../hooks/useBackend';
import type { Project } from '../hooks/useProjects';
import AssetsTab from '../tabs/AssetsTab';
import CharactersTab from '../tabs/CharactersTab';
import EditScriptTab from '../tabs/EditScriptTab';
import EpisodesTab from '../tabs/EpisodesTab';
import ScriptTab from '../tabs/ScriptTab';
import StoryboardTab from '../tabs/StoryboardTab';
import TimelineTab from '../tabs/TimelineTab';

type TabId =
  | 'script'
  | 'episodes'
  | 'characters'
  | 'storyboard'
  | 'edit'
  | 'timeline'
  | 'assets';

const TABS: { id: TabId; label: string }[] = [
  { id: 'script', label: '剧本' },
  { id: 'episodes', label: '集数' },
  { id: 'characters', label: '角色' },
  { id: 'storyboard', label: '分镜' },
  { id: 'edit', label: '剪辑脚本' },
  { id: 'timeline', label: '时间线' },
  { id: 'assets', label: '素材库' },
];

export default function ProjectWorkspace() {
  const { projectId } = useParams<{ projectId: string }>();
  const { alert: appAlert } = useAppDialog();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('script');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const importFileRef = useRef<HTMLInputElement>(null);
  const [snapshotModalOpen, setSnapshotModalOpen] = useState(false);
  const [snapshotLabelDraft, setSnapshotLabelDraft] = useState('');
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotModalErr, setSnapshotModalErr] = useState('');

  const pid = Number(projectId);

  const handleExportZip = async () => {
    const base = await getBackendBase();
    const url = `${base}/api/projects/${pid}/export-zip`;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const openSnapshotModal = () => {
    setSnapshotLabelDraft('');
    setSnapshotModalErr('');
    setSnapshotModalOpen(true);
  };

  const confirmCreateSnapshot = async () => {
    setSnapshotBusy(true);
    setSnapshotModalErr('');
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ id: number; label: string; created_at: string }>(
        base,
        `/api/projects/${pid}/snapshots`,
        {
          method: 'POST',
          body: JSON.stringify({ label: snapshotLabelDraft.trim() }),
        },
      );
      setSnapshotModalOpen(false);
      await appAlert({ title: '快照已保存', message: `已保存版本快照：${data.label}` });
    } catch (err) {
      setSnapshotModalErr(String((err as Error).message));
    } finally {
      setSnapshotBusy(false);
    }
  };

  const handleListSnapshots = async () => {
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ snapshots: { id: number; label: string; created_at: string }[] }>(
        base,
        `/api/projects/${pid}/snapshots`,
      );
      if (data.snapshots.length === 0) {
        await appAlert({ title: '版本快照', message: '该项目暂无版本快照。' });
        return;
      }
      const lines = data.snapshots
        .map((s) => `• [${s.id}] ${s.label}  (${new Date(s.created_at).toLocaleString()})`)
        .join('\n');
      await appAlert({ title: '历史版本快照', message: `历史版本快照：\n\n${lines}` });
    } catch (err) {
      await appAlert({ title: '获取失败', message: `获取快照列表失败：${String((err as Error).message)}` });
    }
  };

  const handleImportZip = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    try {
      const base = await getBackendBase();
      const res = await fetch(`${base}/api/import-zip`, { method: 'POST', body: fd });
      const data = await res.json() as { title: string; project_id: number };
      await appAlert({ title: '导入成功', message: `项目已导入：${data.title}（ID ${data.project_id}）` });
      window.location.reload();
    } catch (err) {
      await appAlert({ title: '导入失败', message: String((err as Error).message) });
    }
    // reset input so same file can be re-selected
    if (importFileRef.current) importFileRef.current.value = '';
  };

  useEffect(() => {
    if (!pid) return;
    setLoading(true);
    getBackendBase()
      .then((base) => apiFetch<Project>(base, `/api/projects/${pid}`))
      .then((p) => {
        setProject(p);
        setLoading(false);
      })
      .catch((e) => {
        setError(String((e as Error).message));
        setLoading(false);
      });
  }, [pid]);

  if (loading) return <div className="ws-loading">加载项目中…</div>;
  if (error || !project)
    return (
      <div className="ws-loading">
        <p>无法加载项目：{error}</p>
        <button className="btn-ghost" onClick={() => navigate('/')}>返回主页</button>
      </div>
    );

  return (
    <div className="ws-root">
      {/* ── 顶栏 ── */}
      <header className="ws-topbar">
        <button className="ws-back" onClick={() => navigate('/')} title="返回项目列表">
          ‹ 项目
        </button>
        <div className="ws-topbar__title">
          <span className="ws-topbar__name">{project.name}</span>
          <span className="ws-topbar__type">{project.type}</span>
        </div>
        <div className="ws-topbar__spacer" />
        <div className="ws-topbar__actions">
          <button className="btn-ghost btn-sm" onClick={() => void handleExportZip()} title="将项目数据导出为 ZIP 备份">
            📦 导出备份
          </button>
          <button
            className="btn-ghost btn-sm"
            onClick={() => importFileRef.current?.click()}
            title="从 ZIP 文件导入项目"
          >
            📂 导入项目
          </button>
          <button
            className="btn-ghost btn-sm"
            onClick={openSnapshotModal}
            title="保存当前项目状态为版本快照"
          >
            📸 创建快照
          </button>
          <button
            className="btn-ghost btn-sm"
            onClick={() => void handleListSnapshots()}
            title="查看历史版本快照列表"
          >
            🕐 历史版本
          </button>
          <input
            ref={importFileRef}
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={(e) => void handleImportZip(e)}
          />
        </div>
      </header>

      {/* ── Tab 导航 ── */}
      <nav className="ws-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`ws-tab${activeTab === t.id ? ' ws-tab--active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* ── Tab 内容（全部挂载，避免切换标签丢失剧本编辑状态）── */}
      <div className="ws-content">
        <div className="ws-panel" hidden={activeTab !== 'script'}>
          <ScriptTab projectId={pid} projectType={project.type} />
        </div>
        <div className="ws-panel" hidden={activeTab !== 'episodes'}>
          <EpisodesTab projectId={pid} />
        </div>
        <div className="ws-panel" hidden={activeTab !== 'characters'}>
          <CharactersTab projectId={pid} projectType={project?.type ?? 'feature'} />
        </div>
        <div className="ws-panel" hidden={activeTab !== 'storyboard'}>
          <StoryboardTab projectId={pid} />
        </div>
        <div className="ws-panel" hidden={activeTab !== 'edit'}>
          <EditScriptTab projectId={pid} />
        </div>
        <div className="ws-panel" hidden={activeTab !== 'timeline'}>
          <TimelineTab projectId={pid} />
        </div>
        <div className="ws-panel" hidden={activeTab !== 'assets'}>
          <AssetsTab projectId={pid} />
        </div>
      </div>

      {snapshotModalOpen ? (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={() => !snapshotBusy && setSnapshotModalOpen(false)}
        >
          <div
            className="modal modal--sm"
            role="dialog"
            aria-labelledby="snapshot-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="snapshot-modal-title" className="modal__title">创建版本快照</h2>
            <p className="modal__body-text" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
              将当前剧本、集数、角色、分镜、剪辑与时间线等写入数据库。留空标签将使用时间戳。
            </p>
            <label className="field-label" htmlFor="snapshot-label-input">版本标签（可选）</label>
            <input
              id="snapshot-label-input"
              type="text"
              autoFocus
              placeholder="例如：第一稿、导演反馈前"
              value={snapshotLabelDraft}
              onChange={(e) => setSnapshotLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !snapshotBusy) void confirmCreateSnapshot();
              }}
            />
            {snapshotModalErr ? <div className="error" style={{ marginTop: 10 }}>{snapshotModalErr}</div> : null}
            <div className="modal__actions">
              <button type="button" className="btn-ghost" disabled={snapshotBusy} onClick={() => setSnapshotModalOpen(false)}>
                取消
              </button>
              <button type="button" className="btn-primary" disabled={snapshotBusy} onClick={() => void confirmCreateSnapshot()}>
                {snapshotBusy ? '保存中…' : '保存快照'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
