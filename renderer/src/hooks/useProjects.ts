import { useCallback, useEffect, useState } from 'react';
import { apiFetch, getBackendBase } from './useBackend';

export type ProjectType = 'feature' | 'short_drama' | 'novel_adapt';

export interface Project {
  id: number;
  name: string;
  type: ProjectType;
  description: string;
  cover_image: string | null;
  created_at: string;
  updated_at: string;
}

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const base = await getBackendBase();
      const data = await apiFetch<{ projects: Project[] }>(base, '/api/projects');
      setProjects(data.projects);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createProject = useCallback(
    async (name: string, type: ProjectType, description = '') => {
      const base = await getBackendBase();
      const proj = await apiFetch<Project>(base, '/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name, type, description }),
      });
      setProjects((prev) => [proj, ...prev]);
      return proj;
    },
    []
  );

  const deleteProject = useCallback(async (id: number) => {
    const base = await getBackendBase();
    await apiFetch(base, `/api/projects/${id}`, { method: 'DELETE' });
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return { projects, loading, error, reload, createProject, deleteProject };
}
