'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

function getElectronApp() {
  try {
    return require('electron').app;
  } catch {
    return null;
  }
}

const BACKEND_PORT = 18766;
const HEALTH_PATH = '/api/health';
const MIN_API_REVISION = 2;
const HEALTH_RETRIES_PYTHON = 60;
const HEALTH_DELAY_MS = 300;
const STDERR_TAIL_BYTES = 2000;

let backendProcess = null;

function getPythonCmd() {
  if (process.env.SCREENPLAY_PYTHON) {
    return { cmd: process.env.SCREENPLAY_PYTHON, argsPrefix: [] };
  }
  if (process.platform === 'win32') {
    return { cmd: 'py', argsPrefix: ['-3'] };
  }
  return { cmd: 'python3', argsPrefix: [] };
}

function pathsEqualForHealth(a, b) {
  if (!a || !b) return false;
  const x = path.normalize(String(a).trim());
  const y = path.normalize(String(b).trim());
  if (process.platform === 'win32') {
    return x.toLowerCase() === y.toLowerCase();
  }
  return x === y;
}

function waitForBackendReady(maxRetries, ctl = { cancelled: false }, expectedUserData) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryOnce = () => {
      if (ctl.cancelled) return;
      attempts += 1;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: BACKEND_PORT,
          path: HEALTH_PATH,
          method: 'GET',
          timeout: 2000
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let data = {};
            try {
              data = JSON.parse(text);
            } catch {
              data = {};
            }
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              const rev = Number(data.api_revision);
              if (
                rev >= MIN_API_REVISION &&
                data.pipeline_stream === true &&
                data.app === 'screenplay-studio'
              ) {
                const ud = data.user_data != null ? String(data.user_data) : '';
                if (expectedUserData && ud && !pathsEqualForHealth(ud, expectedUserData)) {
                  reject(
                    new Error(
                      `Port ${BACKEND_PORT} busy: another app holds /api/health. Stop other uvicorn on this port.`
                    )
                  );
                  return;
                }
                resolve();
                return;
              }
              ctl.cancelled = true;
              reject(
                new Error(
                  `端口 ${BACKEND_PORT} 上已有其它程序响应 /api/health（api_revision=${data.api_revision}），请关闭后重试。`
                )
              );
              return;
            }
            retry();
          });
        }
      );
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
      req.end();

      function retry() {
        if (ctl.cancelled) return;
        if (attempts >= maxRetries) {
          reject(
            new Error(
              '后端在超时时间内未就绪。请在后端目录执行 pip install -r requirements.txt（见 README）。'
            )
          );
          return;
        }
        setTimeout(tryOnce, HEALTH_DELAY_MS);
      }
    };
    tryOnce();
  });
}

/**
 * @param {{ userDataPath: string, projectRoot: string }} opts
 */
function startBackend({ userDataPath, projectRoot }) {
  return new Promise((resolve, reject) => {
    if (backendProcess && !backendProcess.killed) {
      resolve();
      return;
    }

    const backendDir = path.join(projectRoot, 'backend');
    const env = {
      ...process.env,
      SCREENPLAY_USER_DATA: userDataPath,
      SCREENPLAY_PROJECT_ROOT: projectRoot,
      SCREENPLAY_BACKEND_PORT: String(BACKEND_PORT),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8'
    };

    try {
      const runtimeTemp = path.join(userDataPath, '.runtime-temp');
      fs.mkdirSync(runtimeTemp, { recursive: true });
      env.TEMP = runtimeTemp;
      env.TMP = runtimeTemp;
    } catch (e) {
      console.warn('[backend] Could not set TEMP:', e.message || e);
    }

    try {
      const { cmd, argsPrefix } = getPythonCmd();
      const args = [
        ...argsPrefix,
        '-m',
        'uvicorn',
        'app.main:app',
        '--host',
        '127.0.0.1',
        '--port',
        String(BACKEND_PORT)
      ];
      backendProcess = spawn(cmd, args, {
        cwd: backendDir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      reject(e);
      return;
    }

    const ctl = { cancelled: false };
    const stderrChunks = [];

    backendProcess.stdout.on('data', (d) => {
      const s = String(d).trimEnd();
      if (s) console.log('[backend out]', s);
    });
    backendProcess.stderr.on('data', (d) => {
      const s = String(d).trimEnd();
      if (s) console.log('[backend err]', s);
      stderrChunks.push(Buffer.from(d));

      let total = 0;
      for (let i = stderrChunks.length - 1; i >= 0; i--) total += stderrChunks[i].length;
      while (total > STDERR_TAIL_BYTES * 4 && stderrChunks.length > 1) {
        total -= stderrChunks.shift().length;
      }
    });

    let settled = false;
    function resolveReady() {
      if (settled) return;
      settled = true;
      ctl.cancelled = true;
      console.log('[backend] ready on port', BACKEND_PORT);
      resolve();
    }

    function rejectReady(err) {
      if (settled) return;
      settled = true;
      ctl.cancelled = true;
      const tail =
        stderrChunks.length > 0
          ? '\n———— stderr tail ————\n' +
            Buffer.concat(stderrChunks).subarray(-STDERR_TAIL_BYTES).toString('utf8')
          : '';
      stopBackend();
      reject(new Error(`${err.message || err}${tail}`));
    }

    backendProcess.once('error', (err) => {
      rejectReady(new Error(`spawn failed: ${err.message || err}`));
    });

    backendProcess.once('exit', (code, signal) => {
      console.log('[backend] exit', code, signal || '');
      if (!settled) {
        rejectReady(
          new Error(signal ? `进程被终止（signal ${signal}）` : `进程退出（code ${code ?? 'null'}）`)
        );
      }
      backendProcess = null;
    });

    waitForBackendReady(HEALTH_RETRIES_PYTHON, ctl, userDataPath)
      .then(() => resolveReady())
      .catch((err) => rejectReady(err));
  });
}

function stopBackend() {
  if (!backendProcess || backendProcess.killed) {
    backendProcess = null;
    return;
  }
  try {
    backendProcess.kill();
  } catch (e) {
    console.error('[backend] stop error:', e);
  }
  backendProcess = null;
}

function getBackendBaseUrl() {
  return `http://127.0.0.1:${BACKEND_PORT}`;
}

module.exports = {
  startBackend,
  stopBackend,
  getBackendBaseUrl,
  BACKEND_PORT
};
