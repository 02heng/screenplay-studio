import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiFetch, getBackendBase } from '../hooks/useBackend';
import {
  LLM_KEYS_STORAGE_KEY,
  loadLlmKeys,
  loadStoredPresetId,
  saveStoredPresetId,
  type PresetSummary,
} from '../lib/llmSettings';

export type LlmSettingsContextValue = {
  llmPresets: PresetSummary[];
  refreshPresets: () => Promise<void>;
  llmPresetId: string;
  setLlmPresetId: (id: string) => void;
  llmKeys: Record<string, string>;
  setLlmKeys: React.Dispatch<React.SetStateAction<Record<string, string>>>;
};

const LlmSettingsContext = createContext<LlmSettingsContextValue | null>(null);

export function LlmSettingsProvider({ children }: { children: ReactNode }) {
  const [llmPresets, setLlmPresets] = useState<PresetSummary[]>([]);
  const [llmPresetId, setLlmPresetIdState] = useState(() => loadStoredPresetId());
  const [llmKeys, setLlmKeys] = useState<Record<string, string>>(loadLlmKeys);

  const refreshPresets = useCallback(async () => {
    const base = await getBackendBase();
    try {
      const data = await apiFetch<{ presets: PresetSummary[] }>(base, '/api/llm/presets');
      const list = data.presets || [];
      setLlmPresets(list);
      const stored = loadStoredPresetId();
      setLlmPresetIdState((cur) => {
        if (stored && list.some((p) => p.id === stored)) return stored;
        return cur || list[0]?.id || '';
      });
    } catch {
      setLlmPresets([]);
    }
  }, []);

  const setLlmPresetId = useCallback((id: string) => {
    setLlmPresetIdState(id);
    saveStoredPresetId(id);
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

  useEffect(() => {
    void refreshPresets();
  }, [refreshPresets]);

  const value = useMemo<LlmSettingsContextValue>(
    () => ({
      llmPresets,
      refreshPresets,
      llmPresetId,
      setLlmPresetId,
      llmKeys,
      setLlmKeys,
    }),
    [llmPresets, refreshPresets, llmPresetId, setLlmPresetId, llmKeys],
  );

  return <LlmSettingsContext.Provider value={value}>{children}</LlmSettingsContext.Provider>;
}

export function useLlmSettings(): LlmSettingsContextValue {
  const v = useContext(LlmSettingsContext);
  if (!v) throw new Error('useLlmSettings 需在 LlmSettingsProvider 内使用');
  return v;
}
