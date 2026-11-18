// Audit desktop-pet PNG/WebM assets for baked-in green backgrounds or lost alpha.
// Usage: node scripts/audit-pet-alpha.mjs [skin-id ...]
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = process.env.PET_ASSETS_ROOT
  ? resolve(process.env.PET_ASSETS_ROOT)
  : join(ROOT, 'assets');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const selected = new Set(process.argv.slice(2));

function durationOf(file) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const text = String(result.stderr || '') + String(result.stdout || '');
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
}

function frameAt(file, webm, seconds = 0) {
  const args = ['-v', 'error'];
  // FFmpeg's native VP9 decoder does not expose VP9 alpha; libvpx does.
  if (webm) args.push('-c:v', 'libvpx-vp9');
  if (webm) args.push('-ss', String(seconds));
  args.push('-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1');
  const result = spawnSync(FFMPEG, args, { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(String(result.stderr || 'ffmpeg failed').trim());
  return result.stdout;
}

function analyze(buf) {
  let visible = 0;
  let transparent = 0;
  let green = 0;
  for (let i = 0; i + 3 < buf.length; i += 4) {
    const r = buf[i];
    const g = buf[i + 1];
    const b = buf[i + 2];
    const a = buf[i + 3];
    if (a < 16) {
      transparent++;
      continue;
    }
    visible++;
    if (g >= 120 && g > r * 1.35 && g > b * 1.35) green++;
  }
  return {
    transparentPct: buf.length ? Math.round(transparent / (buf.length / 4) * 100) : 0,
    visibleGreenPct: visible ? Math.round(green / visible * 100) : 0,
  };
}

const entries = (await readdir(ASSETS, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('pet-'))
  .filter((entry) => !selected.size || selected.has(entry.name.slice(4)))
  .sort((a, b) => a.name.localeCompare(b.name));

let failures = 0;
for (const entry of entries) {
  const dir = join(ASSETS, entry.name);
  const files = (await readdir(dir))
    .filter((name) => name.endsWith('.png') || name.endsWith('.webm'))
    .sort();
  let worstGreen = null;
  let worstTransparent = null;
  let samples = 0;
  for (const name of files) {
    const webm = name.endsWith('.webm');
    const file = join(dir, name);
    const duration = webm ? durationOf(file) : 0;
    const times = webm
      ? [...new Set([0.15, duration * 0.5, Math.max(0.15, duration - 0.15)].map((value) => value.toFixed(2)))]
      : [0];
    for (const seconds of times) {
      const stats = analyze(frameAt(file, webm, seconds));
      samples++;
      if (!worstGreen || stats.visibleGreenPct > worstGreen.visibleGreenPct) {
        worstGreen = { name, seconds, ...stats };
      }
      if (!worstTransparent || stats.transparentPct < worstTransparent.transparentPct) {
        worstTransparent = { name, seconds, ...stats };
      }
    }
  }
  const bad = worstGreen && worstTransparent
    && (worstGreen.visibleGreenPct >= 5 || worstTransparent.transparentPct < 10);
  if (bad) failures++;
  console.log(
    (bad ? 'FAIL ' : 'OK   ')
    + entry.name.padEnd(24)
    + ' files='
    + String(files.length).padStart(2)
    + ' samples='
    + String(samples).padStart(2)
    + ' min-alpha='
    + String(worstTransparent?.transparentPct || 0).padStart(3)
    + '%('
    + String(worstTransparent?.name || '-').padEnd(20)
    + ') max-green='
    + String(worstGreen?.visibleGreenPct || 0).padStart(3)
    + '%('
    + String(worstGreen?.name || '-')
    + ')',
  );
}

process.exitCode = failures ? 1 : 0;
