import { useEffect, useState } from 'react';
import { useLlmSettings } from '../context/LlmSettingsContext';
import { apiFetch, getBackendBase } from '../hooks/useBackend';
import { LLM_KEYS_STORAGE_KEY } from '../lib/llmSettings';

export default function SettingsTab() {
  const { llmPresets, llmPresetId, setLlmPresetId, llmKeys, setLlmKeys, refreshPresets } = useLlmSettings();

  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKeyEnv, setApiKeyEnv] = useState('');
  const [keyDraft, setKeyDraft] = useState('');

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const p = llmPresets.find((x) => x.id === llmPresetId);
    if (p) {
      setLabel(p.label);
      setBaseUrl(p.base_url);
      setModel(p.model);
      setApiKeyEnv(p.api_key_env || '');
    } else {
      setLabel('');
      setBaseUrl('');
      setModel('');
      setApiKeyEnv('');
    }
  }, [llmPresetId, llmPresets]);

  useEffect(() => {
    setKeyDraft(llmKeys[llmPresetId] ?? '');
  }, [llmPresetId, llmKeys]);

  const handleSave = async () => {
    if (!llmPresetId) {
      setMessage('请先选择预设');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const base = await getBackendBase();
      await apiFetch(base, '/api/settings/llm-preset', {
        method: 'PUT',
        body: JSON.stringify({
          preset_id: llmPresetId,
          label: label.trim(),
          base_url: baseUrl.trim(),
          model: model.trim(),
          api_key_env: apiKeyEnv.trim(),
        }),
      });
      const merged = await apiFetch<{ keys: Record<string, string> }>(base, '/api/settings/llm-keys', {
        method: 'PUT',
        body: JSON.stringify({ keys: { [llmPresetId]: keyDraft } }),
      });
      const nextKeys = merged.keys || { ...llmKeys, [llmPresetId]: keyDraft };
      setLlmKeys(nextKeys);
      localStorage.setItem(LLM_KEYS_STORAGE_KEY, JSON.stringify(nextKeys));
      await refreshPresets();
      setMessage('已保存到本机后端（UserData/providers.yaml 与 llm_keys.json）');
    } catch (e) {
      setMessage(String((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-tab settings-tab--global">
      <header className="settings-tab__head">
        <h1 className="settings-tab__title">大模型设置</h1>
        <p className="settings-tab__sub">
          修改连接地址、模型名、环境变量名与 API Key 后，点击「保存到后端」。配置写入本机用户数据目录，进入项目后生成剧本将使用此处设置。
        </p>
      </header>

      <section className="settings-tab__section">
        <h2 className="settings-tab__h">选择预设</h2>
        <div className="settings-tab__field">
          <label className="field-label" htmlFor="settings-preset">当前预设（对应 providers.yaml 中的 id）</label>
          <select
            id="settings-preset"
            className="toolbar-select settings-tab__select"
            value={llmPresetId}
            onChange={(e) => setLlmPresetId(e.target.value)}
          >
            {llmPresets.length === 0 && <option value="">（无预设：请检查 config/providers.yaml 或用户目录 providers.yaml）</option>}
            {llmPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} · {p.id}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="settings-tab__section">
        <h2 className="settings-tab__h">连接与模型</h2>
        <p className="settings-tab__hint">以下字段保存到用户数据目录下的 providers.yaml，改动后下次请求即生效。</p>
        <div className="settings-tab__field">
          <label className="field-label" htmlFor="settings-label">显示名称</label>
          <input
            id="settings-label"
            type="text"
            className="settings-tab__input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={!llmPresetId}
          />
        </div>
        <div className="settings-tab__field">
          <label className="field-label" htmlFor="settings-base">Base URL</label>
          <input
            id="settings-base"
            type="url"
            className="settings-tab__input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            disabled={!llmPresetId}
            placeholder="https://api.deepseek.com/v1"
          />
        </div>
        <div className="settings-tab__field">
          <label className="field-label" htmlFor="settings-model">Model</label>
          <input
            id="settings-model"
            type="text"
            className="settings-tab__input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={!llmPresetId}
            placeholder="deepseek-chat"
          />
        </div>
        <div className="settings-tab__field">
          <label className="field-label" htmlFor="settings-env">环境变量名（可选）</label>
          <input
            id="settings-env"
            type="text"
            className="settings-tab__input settings-tab__input--mono"
            value={apiKeyEnv}
            onChange={(e) => setApiKeyEnv(e.target.value)}
            disabled={!llmPresetId}
            placeholder="DEEPSEEK_API_KEY"
          />
          <p className="settings-tab__field-hint">若后端进程已配置该环境变量，可不填下方 UI 密钥；两处都填时优先使用下方保存的 Key。</p>
        </div>
      </section>

      <section className="settings-tab__section">
        <h2 className="settings-tab__h">API Key</h2>
        <div className="settings-tab__field">
          <label className="field-label" htmlFor="settings-key">密钥</label>
          <input
            id="settings-key"
            type="password"
            className="settings-tab__input"
            autoComplete="off"
            disabled={!llmPresetId}
            placeholder="保存至本机 llm_keys.json"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
          />
        </div>
      </section>

      <div className="settings-tab__actions">
        <button type="button" className="btn-primary" disabled={!llmPresetId || saving} onClick={() => void handleSave()}>
          {saving ? '保存中…' : '保存到后端'}
        </button>
      </div>
      {message ? <p className={`settings-tab__msg${message.includes('失败') || message.includes('未找到') ? ' settings-tab__msg--err' : ''}`}>{message}</p> : null}
    </div>
  );
}
