'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 默认数据根：D:\Screenplay-Studio-data。可用 SCREENPLAY_DATA_ROOT 覆盖。
 */
function resolvePreferredDataRoot() {
  const envRoot = process.env.SCREENPLAY_DATA_ROOT;
  if (envRoot && envRoot.trim()) {
    return path.resolve(envRoot.trim());
  }

  if (process.platform !== 'win32') {
    return null;
  }

  const candidate = path.join('D:', 'Screenplay-Studio-data');
  try {
    fs.mkdirSync(candidate, { recursive: true });
    return candidate;
  } catch (e) {
    console.warn(
      '[Screenplay Studio] Cannot create D:\\Screenplay-Studio-data — set SCREENPLAY_DATA_ROOT or ensure D: is available:',
      e && e.message ? e.message : e
    );
    return null;
  }
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Redirect Electron paths to D: when possible.
 * @param {import('electron').App} app
 */
function applyNonSystemDrivePaths(app) {
  const root = resolvePreferredDataRoot();
  if (!root) {
    console.warn(
      '[Screenplay Studio] No D: data root and SCREENPLAY_DATA_ROOT unset — using default Electron paths (may be on C:).'
    );
    return;
  }

  try {
    ensureDirSync(root);
  } catch (e) {
    console.error('[Screenplay Studio] Cannot create data root:', root, e);
    return;
  }

  const userData = path.join(root, 'UserData');
  const cache = path.join(root, 'Cache');
  const downloads = path.join(root, 'Downloads');
  const logs = path.join(root, 'Logs');
  const temp = path.join(root, 'Temp');

  try {
    ensureDirSync(userData);
    ensureDirSync(cache);
    ensureDirSync(downloads);
    ensureDirSync(logs);
    ensureDirSync(temp);
  } catch (e) {
    console.error('[Screenplay Studio] Cannot create subfolders under', root, e);
    return;
  }

  app.setPath('userData', userData);
  app.setPath('cache', cache);
  app.setPath('downloads', downloads);
  app.setPath('logs', logs);

  console.log('[Screenplay Studio] Data root:', root);
}

module.exports = {
  resolvePreferredDataRoot,
  applyNonSystemDrivePaths
};
