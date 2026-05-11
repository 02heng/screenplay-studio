import { useEffect } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { AppDialogProvider } from './context/AppDialogContext';
import { LlmSettingsProvider } from './context/LlmSettingsContext';
import { getBackendBase } from './hooks/useBackend';
import ProjectManager from './pages/ProjectManager';
import ProjectWorkspace from './pages/ProjectWorkspace';

function useOrphanCleanup() {
  useEffect(() => {
    const key = '__orphan_cleanup_ts';
    const last = Number(localStorage.getItem(key) || 0);
    if (Date.now() - last < 60_000) return;
    localStorage.setItem(key, String(Date.now()));
    (async () => {
      try {
        const base = await getBackendBase();
        await fetch(`${base}/api/projects/cleanup-orphans`, { method: 'POST' });
      } catch { /* best-effort */ }
    })();
  }, []);
}

export default function App() {
  useOrphanCleanup();
  return (
    <AppDialogProvider>
      <LlmSettingsProvider>
        <HashRouter>
          <Routes>
            <Route path="/" element={<ProjectManager />} />
            <Route path="/project/:projectId" element={<ProjectWorkspace />} />
          </Routes>
        </HashRouter>
      </LlmSettingsProvider>
    </AppDialogProvider>
  );
}
