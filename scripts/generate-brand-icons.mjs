/**
 * 从内嵌 SVG（与 UI 完全一致）生成 build/icon.ico 与 build/icon.png。
 * （安装包图标、exe、任务栏、Electron BrowserWindow）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const buildDir = path.join(root, 'build');

/** 与用户提供的米色 SS 方块标一致 — 不写 XML 声明，避免 BOM/编码问题 */
const BRAND_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="48" fill="#cfc0a8"/><text x="256" y="316" text-anchor="middle" font-family="Georgia,Times New Roman,serif" font-size="220" font-weight="700" fill="#3d2f25">SS</text></svg>`,
  'utf8',
);

async function main() {
  mkdirSync(buildDir, { recursive: true });

  /** @type {Buffer[]} */
  const png_bufs = [];
  /** NSIS/installer 对 ICO 分辨率有限制，512 常会报 invalid icon file size */
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  for (const s of sizes) {
    const buf = await sharp(BRAND_SVG).resize(s, s).png().toBuffer();
    png_bufs.push(buf);
  }

  writeFileSync(path.join(buildDir, 'icon.ico'), await pngToIco(png_bufs));
  await sharp(BRAND_SVG).resize(512, 512).png().toFile(path.join(buildDir, 'icon.png'));

  await sharp(BRAND_SVG).resize(512, 512).png().toFile(path.join(root, 'renderer', 'public', 'logo.png'));
  console.log('[icons] build/icon.ico build/icon.png renderer/public/logo.png');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
