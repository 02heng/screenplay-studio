'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { applyNonSystemDrivePaths } = require('./paths.cjs');
const { startBackend, stopBackend, getBackendBaseUrl } = require('./backend.cjs');

applyNonSystemDrivePaths(app);

/** 开发：仓库根；安装包：resources/（含 extraResources/backend） */
function getProjectRoot() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
}

const projectRoot = getProjectRoot();

let mainWindow = null;

function resolvePreferredDownloads(defaultBase) {
  try {
    if (typeof app.getPath === 'function') {
      const d = app.getPath('downloads');
      if (d && fs.existsSync(path.parse(d).root)) return d;
    }
  } catch {
    /* noop */
  }
  if (process.platform === 'win32') {
    try {
      const candidate = path.join('D:', 'Screenplay-Studio-data', 'Downloads');
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      /* noop */
    }
  }
  return defaultBase;
}

function safeFileName(name, fallback) {
  const s = String(name || fallback)
    .replace(/[<>:"/\\|?*\n\r\t]+/g, '_')
    .trim()
    .slice(0, 120);
  return s || fallback;
}

/** 未打包时探测本机 Vite（5173），便于只开 electron 也能连上已运行的 dev:renderer */
function isViteDevServerUp() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:5173/', { timeout: 400 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function createMainWindow() {
  const distPath = path.join(__dirname, '..', 'renderer', 'dist', 'index.html');
  const hasDist = fs.existsSync(distPath);

  let useViteDev = !app.isPackaged && process.env.NODE_ENV === 'development';
  if (!app.isPackaged && !useViteDev) {
    useViteDev = await isViteDevServerUp();
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      /** 仅本地 http://127.0.0.1:5173 开发服务器时开启隔离；静态页需 false 便于调后端 */
      webSecurity: Boolean(useViteDev)
    }
  });

  if (useViteDev) {
    await mainWindow.loadURL('http://127.0.0.1:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else if (app.isPackaged || hasDist) {
    await mainWindow.loadFile(distPath);
  } else {
    await mainWindow.loadURL('http://127.0.0.1:5173');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('screenplay:get-backend-url', () => getBackendBaseUrl());

ipcMain.handle('screenplay:get-paths', () => {
  return {
    userData: app.getPath('userData'),
    downloads: resolvePreferredDownloads(app.getPath('downloads'))
  };
});

// ── New IPC handlers ──────────────────────────────────────────────────────────

/** Open a native file-picker dialog; returns file path string or null */
ipcMain.handle('screenplay:open-file', async (event, filters) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
    title: '选择文件',
    filters: filters || [],
    properties: ['openFile'],
  });
  return canceled || filePaths.length === 0 ? null : filePaths[0];
});

/** Read a file and return base64-encoded content */
ipcMain.handle('screenplay:read-file-as-base64', async (_event, filePath) => {
  if (!filePath || typeof filePath !== 'string') return null;
  try {
    const buf = await fs.promises.readFile(filePath);
    return buf.toString('base64');
  } catch {
    return null;
  }
});

/** Scan a project asset directory; returns relative file paths */
ipcMain.handle('screenplay:scan-project-dir', async (_event, projectId, subDir) => {
  const projectsRoot = process.platform === 'win32'
    ? path.join('D:\\Screenplay-Studio-data\\Projects', String(projectId))
    : path.join(app.getPath('home'), '.screenplay-studio', '..', 'Projects', String(projectId));
  const target = subDir ? path.join(projectsRoot, subDir) : projectsRoot;
  try {
    const entries = await _scanDir(target, target);
    return entries;
  } catch {
    return [];
  }
});

async function _scanDir(dir, base) {
  let results = [];
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch { return results; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      results = results.concat(await _scanDir(full, base));
    } else {
      results.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle('screenplay:save-text-file', async (event, payload) => {
  const rawName = (payload && payload.defaultFileName) || 'screenplay.md';
  const content = (payload && payload.content) != null ? String(payload.content) : '';
  const ext = (payload && payload.extension) || '.md';
  const base = safeFileName(rawName.replace(/\.(md|txt|fountain)$/i, ''), 'screenplay');
  const withExt = base.toLowerCase().endsWith(ext.toLowerCase()) ? base : `${base}${ext}`;
  const win = BrowserWindow.fromWebContents(event.sender);
  const defaultDir = resolvePreferredDownloads(app.getPath('downloads'));
  const defaultPath = path.join(defaultDir, withExt);
  const { canceled, filePath } = await dialog.showSaveDialog(win || undefined, {
    title: '导出剧本',
    defaultPath,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Fountain', extensions: ['fountain'] },
      { name: '文本', extensions: ['txt'] }
    ]
  });
  if (canceled || !filePath) return { ok: false };
  await fs.promises.writeFile(filePath, content, 'utf8');
  return { ok: true, filePath };
});

app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  try {
    await startBackend({ userDataPath, projectRoot });
  } catch (e) {
    console.error('[Screenplay Studio] Backend failed to start:', e);
  }
  await createMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopBackend();
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackend();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createMainWindow();
  }
});
