import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiFetch, getBackendBase } from '../hooks/useBackend';
import type { Project } from '../hooks/useProjects';
import AssetsTab from '../tabs/AssetsTab';
import CharactersTab from '../tabs/CharactersTab';
import EditScriptTab from '../tabs/EditScriptTab';
import ScriptTab from '../tabs/ScriptTab';
import StoryboardTab from '../tabs/StoryboardTab';

type TabId = 'script' | 'characters' | 'storyboard' | 'edit' | 'assets';

const TABS: { id: TabId; label: string }[] = [
  { id: 'script', label: '剧本' },
  { id: 'characters', label: '角色' },
  { id: 'storyboard', label: '分镜' },
  { id: 'edit', label: '剪辑脚本' },
  { id: 'assets', label: '素材库' },
];

export default function ProjectWorkspace() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('script');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const pid = Number(projectId);

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
        <div className="ws-panel" hidden={activeTab !== 'characters'}>
          <CharactersTab projectId={pid} />
        </div>
        <div className="ws-panel" hidden={activeTab !== 'storyboard'}>
          <StoryboardTab projectId={pid} />
        </div>
        <div className="ws-panel" hidden={activeTab !== 'edit'}>
          <EditScriptTab projectId={pid} />
        </div>
        <div className="ws-panel" hidden={activeTab !== 'assets'}>
          <AssetsTab projectId={pid} />
        </div>
      </div>
    </div>
  );
}
