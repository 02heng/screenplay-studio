import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import vitePluginBundleObfuscator from 'vite-plugin-bundle-obfuscator';

/**
 * 打包混淆：参考社区常用方案 github.com/z0ffy/vite-plugin-bundle-obfuscator
 * 在 Rollup 输出最终 chunk 上混淆（优于仅对离散文件处理后处理）。
 */
function bundleObfuscator(mode: string) {
  if (mode !== 'production') return null;
  return vitePluginBundleObfuscator({
    apply: 'build',
    enable: true,
    autoExcludeNodeModules: true,
    threadPool: true,
    log: false,
    options: {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.4,
      deadCodeInjection: false,
      debugProtection: false,
      disableConsoleOutput: true,
      identifierNamesGenerator: 'hexadecimal',
      renameGlobals: false,
      // Electron + React：selfDefending / debugProtection 易导致运行期异常，保持关闭
      selfDefending: false,
      simplify: true,
      splitStrings: false,
      stringArray: true,
      stringArrayEncoding: ['base64'],
      stringArrayRotate: true,
      stringArrayShuffle: true,
      unicodeEscapeSequence: false,
    },
  });
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), bundleObfuscator(mode)].filter(Boolean),
  root: path.resolve(__dirname, 'renderer'),
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: path.resolve(__dirname, 'renderer/dist'),
    emptyOutDir: true,
    minify: mode === 'production' ? 'esbuild' : undefined,
    sourcemap: mode !== 'production',
  },
}));
