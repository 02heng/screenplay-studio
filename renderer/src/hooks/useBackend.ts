import { useEffect, useState } from 'react';

let _cached: string | null = null;

export async function getBackendBase(): Promise<string> {
  if (_cached) return _cached;
  if (typeof window !== 'undefined' && window.screenplay?.getBackendUrl) {
    _cached = await window.screenplay.getBackendUrl();
    return _cached!;
  }
  _cached = 'http://127.0.0.1:18766';
  return _cached;
}

export function useBackendBase(): string {
  const [base, setBase] = useState('http://127.0.0.1:18766');
  useEffect(() => {
    getBackendBase().then(setBase).catch(() => {});
  }, []);
  return base;
}

export async function apiFetch<T = unknown>(
  base: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  // 204 No Content、205 Reset Content 及部分 DELETE 无响应体 — 不能调 res.json()
  if (res.status === 204 || res.status === 205) {
    return undefined as T;
  }
  const text = await res.text();
  if (!text.trim()) {
    return undefined as T;
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    return JSON.parse(text) as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}
