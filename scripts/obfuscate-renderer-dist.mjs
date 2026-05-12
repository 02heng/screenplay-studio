/**
 * 打包前对「仅 renderer dist」做一次混淆处理（electron 主进程不混淆，以免 require/fs 运行时异常）。
 * 若未单独提供 AI-writer 工程中的插件，此方法与业界常用的 javascript-obfuscator CLI 等价。
 *
 * Usage: node scripts/obfuscate-renderer-dist.mjs
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import javascriptObfuscator from 'javascript-obfuscator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distAssets = path.join(__dirname, '..', 'renderer', 'dist', 'assets');

async function main() {
  let names;
  try {
    names = await readdir(distAssets);
  } catch {
    console.error('[obfuscate] renderer/dist/assets 不存在 — 请先执行 npm run build:renderer');
    process.exit(1);
  }

  const jsFiles = names.filter((n) => n.endsWith('.js'));
  if (jsFiles.length === 0) {
    console.warn('[obfuscate] 未找到 .js 条目，跳过');
    return;
  }

  const opts = {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,
    identifierNamesGenerator: 'hexadecimal',
    numbersToExpressions: false,
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: false,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayRotate: true,
    stringArrayShuffle: true,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
  };

  for (const f of jsFiles) {
    const p = path.join(distAssets, f);
    const { size } = await stat(p);
    if (size < 512) continue;
    const src = await readFile(p, 'utf8');
    const obf = javascriptObfuscator.obfuscate(src, opts);
    await writeFile(p, obf.getObfuscatedCode());
    console.log('[obfuscate]', f);
  }
}

main();
