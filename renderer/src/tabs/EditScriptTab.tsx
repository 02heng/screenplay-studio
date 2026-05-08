import { useCallback, useEffect, useState } from 'react';
import { apiFetch, getBackendBase } from '../hooks/useBackend';
import { EV_RELOAD_EDIT } from '../lib/pipelineImport';

interface EditShot {
  id: number;
  order_index: number;
  clip_path: string | null;
  in_point: number;
  out_point: number;
  timecode: string;
  note: string;
  storyboard_shot_id: number | null;
}

interface Props { projectId: number }

const FPS = 25;

function secToTC(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const f = Math.floor((sec % 1) * FPS);
  return [h, m, s, f].map((n) => String(n).padStart(2, '0')).join(':');
}

export default function EditScriptTab({ projectId }: Props) {
  const [shots, setShots] = useState<EditShot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Partial<EditShot>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ edit_shots: EditShot[] }>(base, `/api/projects/${projectId}/edit-shots`);
      setShots(data.edit_shots);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onReload = () => { void load(); };
    window.addEventListener(EV_RELOAD_EDIT, onReload);
    return () => window.removeEventListener(EV_RELOAD_EDIT, onReload);
  }, [load]);

  const addShot = async () => {
    const base = await getBackendBase();
    const idx = (shots[shots.length - 1]?.order_index ?? -1) + 1;
    const s = await apiFetch<EditShot>(base, `/api/projects/${projectId}/edit-shots`, {
      method: 'POST',
      body: JSON.stringify({ order_index: idx, timecode: secToTC(idx * 3), in_point: 0, out_point: 3 }),
    });
    setShots((prev) => [...prev, s]);
  };

  const saveShot = async () => {
    if (editingId === null) return;
    const base = await getBackendBase();
    const updated = await apiFetch<EditShot>(base, `/api/projects/${projectId}/edit-shots/${editingId}`, {
      method: 'PATCH',
      body: JSON.stringify(draft),
    });
    setShots((prev) => prev.map((s) => s.id === editingId ? updated : s));
    setEditingId(null);
  };

  const deleteShot = async (id: number) => {
    const base = await getBackendBase();
    await apiFetch(base, `/api/projects/${projectId}/edit-shots/${id}`, { method: 'DELETE' });
    setShots((prev) => prev.filter((s) => s.id !== id));
  };

  const exportCsv = async () => {
    const base = await getBackendBase();
    const res = await fetch(`${base}/api/projects/${projectId}/edit-shots/export/csv`);
    const text = await res.text();
    const blob = new Blob([text], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `edit_script_${projectId}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const openFileForShot = async (shotId: number) => {
    if (window.screenplay?.openFile) {
      const filePath = await window.screenplay.openFile([{ name: 'Video', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] }]);
      if (!filePath) return;
      const base = await getBackendBase();
      const updated = await apiFetch<EditShot>(base, `/api/projects/${projectId}/edit-shots/${shotId}`, {
        method: 'PATCH',
        body: JSON.stringify({ clip_path: filePath }),
      });
      setShots((prev) => prev.map((s) => s.id === shotId ? updated : s));
    }
  };

  const totalDuration = shots.reduce((acc, s) => acc + (s.out_point - s.in_point), 0);

  return (
    <div className="edit-tab">
      <div className="edit-tab__head">
        <h2 className="section-title">剪辑脚本</h2>
        <div className="edit-tab__head-actions">
          <span className="edit-tab__total">总时长：{secToTC(totalDuration)}</span>
          <button className="btn-ghost" onClick={() => void exportCsv()}>导出 CSV</button>
          <button className="btn-primary" onClick={() => void addShot()}>+ 添加镜头</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="tab-loading">加载中…</div>}

      <div className="edit-table-wrap">
        <table className="edit-table">
          <thead>
            <tr>
              <th>#</th>
              <th>时码</th>
              <th>素材文件</th>
              <th>入点 (s)</th>
              <th>出点 (s)</th>
              <th>时长 (s)</th>
              <th>备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {shots.map((s) => (
              <tr key={s.id}>
                <td className="edit-table__num">{s.order_index + 1}</td>
                <td className="edit-table__tc">{s.timecode}</td>
                <td className="edit-table__clip">
                  {s.clip_path ? (
                    <span className="edit-table__clip-name" title={s.clip_path}>
                      {s.clip_path.split(/[\\/]/).pop()}
                    </span>
                  ) : (
                    <button className="btn-ghost btn-sm" onClick={() => void openFileForShot(s.id)}>选择文件</button>
                  )}
                </td>
                <td>{s.in_point.toFixed(2)}</td>
                <td>{s.out_point.toFixed(2)}</td>
                <td>{(s.out_point - s.in_point).toFixed(2)}</td>
                <td className="edit-table__note">{s.note}</td>
                <td className="edit-table__actions">
                  <button className="btn-ghost btn-sm" onClick={() => { setEditingId(s.id); setDraft({ ...s }); }}>编辑</button>
                  <button className="btn-danger btn-sm" onClick={() => void deleteShot(s.id)}>×</button>
                </td>
              </tr>
            ))}
            {shots.length === 0 && !loading && (
              <tr><td colSpan={8} className="edit-table__empty">暂无镜头，点击「添加镜头」</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editingId !== null && (
        <div className="modal-overlay" onClick={() => setEditingId(null)}>
          <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">编辑镜头 #{(draft.order_index ?? 0) + 1}</h2>

            <div className="modal__grid2">
              <div>
                <label className="field-label">入点 (s)</label>
                <input type="number" step={0.1} min={0} value={draft.in_point ?? 0}
                  onChange={(e) => setDraft((d) => ({ ...d, in_point: Number(e.target.value) }))} />
              </div>
              <div>
                <label className="field-label">出点 (s)</label>
                <input type="number" step={0.1} min={0} value={draft.out_point ?? 0}
                  onChange={(e) => setDraft((d) => ({ ...d, out_point: Number(e.target.value) }))} />
              </div>
              <div>
                <label className="field-label">时码</label>
                <input type="text" value={draft.timecode ?? ''} placeholder="00:00:00:00"
                  onChange={(e) => setDraft((d) => ({ ...d, timecode: e.target.value }))} />
              </div>
            </div>

            <label className="field-label">备注</label>
            <textarea rows={3} value={draft.note ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
              placeholder="剪辑备注、指导说明…" />

            <div className="modal__actions">
              <button className="btn-ghost" onClick={() => setEditingId(null)}>取消</button>
              <button className="btn-primary" onClick={() => void saveShot()}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
