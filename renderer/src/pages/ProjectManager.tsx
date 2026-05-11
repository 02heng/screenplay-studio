import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type ProjectType, useProjects } from '../hooks/useProjects';
import DownloadTab from '../tabs/DownloadTab';
import SettingsTab from '../tabs/SettingsTab';

type PageTab = 'projects' | 'download' | 'settings';

const TYPE_LABELS: Record<ProjectType, string> = {
  feature: '院线长剧本',
  short_drama: '短剧',
  novel_adapt: '小说改编',
};

const TYPE_ICONS: Record<ProjectType, string> = {
  feature: '🎬',
  short_drama: '📱',
  novel_adapt: '📖',
};

export default function ProjectManager() {
  const navigate = useNavigate();
  const { projects, loading, error, reload, createProject, deleteProject } = useProjects();

  const [activeTab, setActiveTab] = useState<PageTab>('projects');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<ProjectType>('feature');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState('');

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const proj = await createProject(newName.trim(), newType, newDesc.trim());
      setShowCreate(false);
      setNewName('');
      setNewType('feature');
      setNewDesc('');
      navigate(`/project/${proj.id}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="pm-root">
      {/* ── 顶栏 ── */}
      <header className="pm-header">
        <div className="pm-header__inner">
          <div className="pm-header__brand">
            <span className="pm-logo">SS</span>
            <div>
              <h1 className="pm-title">Screenplay Studio</h1>
              <p className="pm-subtitle">电影 · 短剧 · 完整制作流程</p>
            </div>
          </div>
          <div className="pm-header__actions">
            {activeTab === 'projects' && (
              <>
                <button className="btn-ghost" onClick={() => void reload()}>刷新</button>
                <button className="btn-primary" onClick={() => setShowCreate(true)}>+ 新建项目</button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ── 顶部导航 Tab ── */}
      <nav className="pm-tabs">
        <button
          className={`pm-tab${activeTab === 'projects' ? ' pm-tab--active' : ''}`}
          onClick={() => setActiveTab('projects')}
        >
          我的项目
        </button>
        <button
          className={`pm-tab${activeTab === 'download' ? ' pm-tab--active' : ''}`}
          onClick={() => setActiveTab('download')}
        >
          小说下载
        </button>
        <button
          className={`pm-tab${activeTab === 'settings' ? ' pm-tab--active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          设置
        </button>
      </nav>

      {activeTab === 'settings' && (
        <div className="pm-settings-wrap">
          <SettingsTab />
        </div>
      )}

      {/* ── 小说下载标签页 ── */}
      {activeTab === 'download' && (
        <div className="pm-download-wrap">
          <DownloadTab />
        </div>
      )}

      {/* ── 项目列表标签页 ── */}
      {activeTab === 'projects' && (
        <main className="pm-body">
          {error ? <div className="pm-error">{error}</div> : null}

          {loading && projects.length === 0 ? (
            <div className="pm-empty">加载中…</div>
          ) : projects.length === 0 ? (
            <div className="pm-empty">
              <div className="pm-empty__icon">🎬</div>
              <p>还没有项目，点击「新建项目」开始创作</p>
            </div>
          ) : (
            <div className="pm-grid">
              {projects.map((p) => (
                <div key={p.id} className="pm-card" onClick={() => navigate(`/project/${p.id}`)}>
                  <div className="pm-card__cover">
                    {p.cover_image ? (
                      <img src={`file://${p.cover_image}`} alt={p.name} />
                    ) : (
                      <span className="pm-card__cover-icon">{TYPE_ICONS[p.type as ProjectType] ?? '🎬'}</span>
                    )}
                  </div>
                  <div className="pm-card__body">
                    <div className="pm-card__type-badge">{TYPE_LABELS[p.type as ProjectType] ?? p.type}</div>
                    <h3 className="pm-card__name">{p.name}</h3>
                    {p.description ? <p className="pm-card__desc">{p.description}</p> : null}
                    <time className="pm-card__date">
                      {new Date(p.created_at).toLocaleDateString('zh-CN')}
                    </time>
                  </div>
                  <button
                    className="pm-card__delete"
                    title="删除项目"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDelete(p.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </main>
      )}

      {/* ── 新建项目弹窗 ── */}
      {showCreate ? (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">新建项目</h2>

            <label className="field-label" htmlFor="new-name">项目名称</label>
            <input
              id="new-name"
              type="text"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
              placeholder="我的电影项目"
            />

            <label className="field-label" htmlFor="new-type">类型</label>
            <select id="new-type" value={newType} onChange={(e) => setNewType(e.target.value as ProjectType)}>
              <option value="feature">院线长剧本</option>
              <option value="short_drama">短剧</option>
              <option value="novel_adapt">小说改编</option>
            </select>

            <label className="field-label" htmlFor="new-desc">简介（可选）</label>
            <textarea
              id="new-desc"
              rows={3}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="一两句话描述项目…"
            />

            <div className="modal__actions">
              <button className="btn-ghost" onClick={() => setShowCreate(false)}>取消</button>
              <button className="btn-primary" onClick={() => void handleCreate()} disabled={!newName.trim() || creating}>
                {creating ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── 确认删除弹窗 ── */}
      {confirmDelete !== null ? (
        <div
          className="modal-overlay"
          onClick={() => {
            setDeleteError('');
            setConfirmDelete(null);
          }}
        >
          <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">确认删除？</h2>
            <p className="modal__body-text">此操作不可恢复，项目及所有素材文件将被删除。</p>
            {deleteError ? <p className="pm-error pm-error--inline">{deleteError}</p> : null}
            <div className="modal__actions">
              <button className="btn-ghost" onClick={() => { setDeleteError(''); setConfirmDelete(null); }}>取消</button>
              <button
                className="btn-danger"
                onClick={async () => {
                  setDeleteError('');
                  try {
                    await deleteProject(confirmDelete);
                    setConfirmDelete(null);
                  } catch (e) {
                    setDeleteError(String((e as Error).message) || '删除失败');
                  }
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
