/** 与 ScriptTab / SettingsTab 共享的 LLM 配置存储 */

export const LLM_KEYS_STORAGE_KEY = 'screenplay-studio-llm-keys-v1';
export const PRESET_ID_STORAGE_KEY = 'screenplay-studio-llm-preset-v1';

export type PresetSummary = {
  id: string;
  label: string;
  base_url: string;
  model: string;
  api_key_env?: string;
};

export function loadLlmKeys(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LLM_KEYS_STORAGE_KEY) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export function loadStoredPresetId(): string {
  try {
    return localStorage.getItem(PRESET_ID_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function saveStoredPresetId(id: string): void {
  try {
    if (id) localStorage.setItem(PRESET_ID_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}
