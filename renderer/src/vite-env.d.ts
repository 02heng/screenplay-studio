/// <reference types="vite/client" />

export type JobType = 'feature' | 'short_drama' | 'novel_adapt';

interface ScreenplayBridge {
  getBackendUrl: () => Promise<string>;
  getPaths: () => Promise<{ userData: string; downloads: string }>;
  saveTextFile: (payload: {
    content: string;
    defaultFileName?: string;
    extension?: string;
  }) => Promise<{ ok: boolean; filePath?: string }>;
  /** Open a native file picker; returns chosen path or null */
  openFile: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | null>;
  /** Read file content as base64 string */
  readFileAsBase64: (filePath: string) => Promise<string | null>;
  /** Scan a project asset directory for files */
  scanProjectDir: (projectId: number, subDir?: string) => Promise<string[]>;
}

declare global {
  interface Window {
    screenplay?: ScreenplayBridge;
  }
}
