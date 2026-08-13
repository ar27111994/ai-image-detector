/**
 * Generates the extension icons (16/32/48/128) from an inline SVG.
 * Usage: node tools/generate-icons.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ICON_SIZES = [16, 32, 48, 128];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'extension', 'icons');

// Shield + neural-node motif on a deep indigo gradient.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4f46e5"/>
      <stop offset="1" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#bg)"/>
  <path d="M64 22 L98 36 V62 C98 84 83 100 64 106 C45 100 30 84 30 62 V36 Z"
        fill="rgba(255,255,255,0.14)" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
  <g fill="#fff">
    <circle cx="64" cy="52" r="7"/>
    <circle cx="48" cy="70" r="5.5"/>
    <circle cx="80" cy="70" r="5.5"/>
    <circle cx="64" cy="86" r="5.5"/>
  </g>
  <g stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0.9">
    <line x1="64" y1="52" x2="48" y2="70"/>
    <line x1="64" y1="52" x2="80" y2="70"/>
    <line x1="48" y1="70" x2="64" y2="86"/>
    <line x1="80" y1="70" x2="64" y2="86"/>
  </g>
</svg>`;

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'icon.svg'), svg, 'utf8');

for (const size of ICON_SIZES) {
  const out = path.join(outDir, `icon-${size}.png`);
  await sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png().toFile(out);
  console.log(`wrote ${path.relative(repoRoot, out)}`);
}
