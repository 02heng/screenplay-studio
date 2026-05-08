'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenplay', {
  getBackendUrl: () => ipcRenderer.invoke('screenplay:get-backend-url'),
  getPaths: () => ipcRenderer.invoke('screenplay:get-paths'),
  saveTextFile: (payload) => ipcRenderer.invoke('screenplay:save-text-file', payload),

  // New IPC additions ──────────────────────────────────────────────────────────

  /** Open a native file-picker; returns the chosen file path string or null */
  openFile: (filters) => ipcRenderer.invoke('screenplay:open-file', filters),

  /** Read a local file and return its content as a base64 string */
  readFileAsBase64: (filePath) => ipcRenderer.invoke('screenplay:read-file-as-base64', filePath),

  /** Scan a project asset directory; returns an array of relative file paths */
  scanProjectDir: (projectId, subDir) => ipcRenderer.invoke('screenplay:scan-project-dir', projectId, subDir),
});
