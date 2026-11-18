// Build the optional desktop-pet release archives without adding npm dependencies.
// Optional WebM masters are transcoded to 640x360, while PNGs and pet.json stay as-is.
// Usage: node scripts/pack-pet-skins.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_TAG = process.env.PET_PACK_RELEASE_TAG || 'pet-packs-v2';
const OUTPUT = process.env.PET_PACK_OUT || join(ROOT, '..', 'output', RELEASE_TAG);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const execFileAsync = promisify(execFile);
const OPTIONAL = [
  ['blue-winter', '蓝色冬装'],
  ['butler-cool', '高冷眼镜执事'],
  ['maid-deepsea', '深海经典'],
  ['maid-soda', '海盐苏打'],
  ['maid-starnight', '午夜星空'],
];

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function makeTar(files) {
  const chunks = [];
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const data = file.data;
    chunks.push(tarHeader(file.name, data.length));
    chunks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function probeMedia(file) {
  try {
    return new Promise((resolve) => {
      execFile(FFMPEG, ['-hide_banner', '-i', file], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        const text = String(stderr || '') + String(stdout || '');
        const size = /Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(text);
        const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
        resolve(size && duration ? {
          width: Number(size[1]),
          height: Number(size[2]),
          duration: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
        } : null);
      });
    });
  } catch {
    return null;
  }
}

async function transcode(file, target) {
  const media = await probeMedia(file);
  if (!media) throw new Error('无法读取视频信息: ' + file);
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    // FFmpeg's native VP9 decoder flattens VP9 alpha. libvpx is required to
    // preserve the source alpha while decoding the master for re-encoding.
    '-c:v', 'libvpx-vp9',
    '-i', file,
    // Keep VP9 alpha as a real alpha plane. A plain yuv420p transcode flattens
    // transparent pixels to their source green and makes the pet look green.
    '-vf', 'scale=640:360:flags=lanczos,format=yuva420p',
    '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0',
    '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
    '-metadata:s:v:0', 'alpha_mode=1',
    '-deadline', 'good', '-cpu-used', '3', '-row-mt', '1',
    '-an', target,
  ], { maxBuffer: 16 * 1024 * 1024 });
  return { size: { width: 640, height: 360 }, duration: media.duration };
}

function analyzeAlpha(buf) {
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
  const pixels = buf.length / 4;
  return {
    transparentPct: pixels ? Math.round(transparent / pixels * 100) : 0,
    visibleGreenPct: visible ? Math.round(green / visible * 100) : 0,
  };
}

async function frameAt(file, seconds) {
  const { stdout } = await execFileAsync(FFMPEG, [
    '-v', 'error',
    '-c:v', 'libvpx-vp9',
    '-ss', String(seconds),
    '-i', file,
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return analyzeAlpha(stdout);
}

async function assertTransparent(file, duration) {
  const samples = [...new Set([
    0.15,
    duration * 0.5,
    Math.max(0.15, duration - 0.15),
  ].map((value) => value.toFixed(2)))];
  for (const seconds of samples) {
    const stats = await frameAt(file, seconds);
    if (stats.transparentPct < 10 || stats.visibleGreenPct >= 5) {
      throw new Error(
        '透明通道校验失败: ' + file
        + ' @' + seconds + 's'
        + ' transparent=' + stats.transparentPct + '%'
        + ' visible-green=' + stats.visibleGreenPct + '%',
      );
    }
  }
  return frameAt(file, samples[0]);
}

async function buildPack(id, label, stageRoot) {
  const source = join(ROOT, 'assets', 'pet-' + id);
  const stage = join(stageRoot, 'pet-' + id);
  await mkdir(stage, { recursive: true });
  const files = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const src = join(source, entry.name);
    const dst = join(stage, entry.name);
    if (entry.name.endsWith('.webm')) {
      const result = await transcode(src, dst);
      const stats = await assertTransparent(dst, result.duration);
      console.log(
        '  ' + id + '/' + entry.name
        + ' -> 640x360 transparent=' + stats.transparentPct
        + '% visible-green=' + stats.visibleGreenPct + '%',
      );
    } else {
      await cp(src, dst);
    }
    files.push({ name: 'pet-' + id + '/' + entry.name, data: await readFile(dst) });
  }
  const archive = gzipSync(makeTar(files), { level: 9 });
  const filename = 'pet-' + id + '.tar.gz';
  await writeFile(join(OUTPUT, filename), archive);
  return {
    id,
    label,
    filename,
    bytes: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex'),
  };
}

await mkdir(OUTPUT, { recursive: true });
const stageRoot = await mkdtemp(join(OUTPUT, '.stage-'));
try {
  const skins = [];
  for (const [id, label] of OPTIONAL) {
    console.log('Packing ' + id + '…');
    skins.push(await buildPack(id, label, stageRoot));
  }
  const manifest = { version: 1, releaseTag: RELEASE_TAG, skins };
  await writeFile(join(OUTPUT, 'pet-packs.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('Wrote ' + relative(ROOT, OUTPUT));
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}
