import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppDialog } from '../context/AppDialogContext';
import { getBackendBase } from '../hooks/useBackend';

interface Asset { name: string; path: string; relative: string; size: number }

type Kind = 'images' | 'videos' | 'storyboard';

const KIND_LABELS: Record<Kind, string> = { images: '图片库', videos: '视频库', storyboard: '分镜板' };

interface Props { projectId: number }

export default function AssetsTab({ projectId }: Props) {
  const { confirm: appConfirm } = useAppDialog();
  const [kind, setKind] = useState<Kind>('images');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const base = await getBackendBase();
      const res = await fetch(`${base}/api/projects/${projectId}/assets?kind=${kind}`);
      const data = await res.json() as { assets: Asset[] };
      setAssets(data.assets);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }, [projectId, kind]);

  useEffect(() => { void load(); }, [load]);

  const uploadFile = async (file: File) => {
    const base = await getBackendBase();
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${base}/api/projects/${projectId}/assets/upload?kind=${kind}`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    await load();
  };

  const deleteAsset = async (relative: string) => {
    const fname = relative.split(/[/\\]/).pop() ?? relative;
    if (!(await appConfirm({
      title: '删除素材',
      message: `确定删除素材「${fname}」吗？磁盘上的项目文件将一并删除，且不可恢复。`,
      confirmLabel: '删除',
    }))) return;
    const base = await getBackendBase();
    await fetch(`${base}/api/projects/${projectId}/assets/file?relative=${encodeURIComponent(relative)}`, { method: 'DELETE' });
    setAssets((prev) => prev.filter((a) => a.relative !== relative));
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    for (const f of files) {
      try { await uploadFile(f); } catch (err) { setError(String((err as Error).message)); }
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    for (const f of files) {
      try { await uploadFile(f); } catch (err) { setError(String((err as Error).message)); }
    }
    e.target.value = '';
  };

  const fmtSize = (b: number) =>
    b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`;

  const assetUrl = async (relative: string) => {
    const base = await getBackendBase();
    return `${base}/api/projects/${projectId}/assets/file?relative=${encodeURIComponent(relative)}`;
  };

  const openAsset = async (relative: string) => {
    const url = await assetUrl(relative);
    window.open(url, '_blank');
  };

  return (
    <div className="assets-tab">
      {/* Kind tabs */}
      <div className="assets-tab__kinds">
        {(Object.keys(KIND_LABELS) as Kind[]).map((k) => (
          <button
            key={k}
            className={`assets-kind-btn${kind === k ? ' assets-kind-btn--active' : ''}`}
            onClick={() => setKind(k)}
          >
            {KIND_LABELS[k]}
          </button>
        ))}
        <div className="assets-tab__kinds-spacer" />
        <button className="btn-ghost" onClick={() => fileRef.current?.click()}>上传文件</button>
        <input ref={fileRef} type="file" style={{ display: 'none' }} multiple onChange={handleFileSelect}
          accept={kind === 'images' ? 'image/*' : kind === 'videos' ? 'video/*' : '*'} />
      </div>

      {error && <div className="error">{error}</div>}

      {/* 拖拽区 / 网格 */}
      <div
        className={`assets-drop${dragging ? ' assets-drop--over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => void handleDrop(e)}
      >
        {loading && <div className="tab-loading">加载中…</div>}

        {!loading && assets.length === 0 && (
          <div className="assets-empty">
            <div className="assets-empty__icon">📂</div>
            <p>将文件拖到此处上传，或点击「上传文件」</p>
          </div>
        )}

        {assets.length > 0 && (
          <div className={`assets-grid assets-grid--${kind}`}>
            {assets.map((a) => (
              <div key={a.relative} className="asset-card" onClick={() => void openAsset(a.relative)}>
                {kind === 'images' ? (
                  <AssetImage projectId={projectId} relative={a.relative} name={a.name} />
                ) : kind === 'videos' ? (
                  <div className="asset-card__video-thumb">▶</div>
                ) : (
                  <div className="asset-card__file-thumb">📄</div>
                )}
                <div className="asset-card__info">
                  <span className="asset-card__name">{a.name}</span>
                  <span className="asset-card__size">{fmtSize(a.size)}</span>
                </div>
                <button
                  className="asset-card__del"
                  onClick={(e) => { e.stopPropagation(); void deleteAsset(a.relative); }}
                  title="删除"
                >×</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AssetImage({ projectId, relative, name }: { projectId: number; relative: string; name: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    getBackendBase().then((base) => {
      setSrc(`${base}/api/projects/${projectId}/assets/file?relative=${encodeURIComponent(relative)}`);
    }).catch(() => {});
  }, [projectId, relative]);
  return src ? <img src={src} alt={name} className="asset-card__img" loading="lazy" /> : <div className="asset-card__img-ph" />;
}
