/**
 * Optional «真看抽帧»: playurl → ffmpeg stills.
 * No bundled ffmpeg. Soft-fails when missing login / binary / stream.
 */
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

export const LIVE_FRAME_EVERY_SEC_PRESETS = Object.freeze([15, 20, 30, 45, 60, 90, 120]);
export const LIVE_FRAME_EVERY_SEC_MIN = 15;
export const LIVE_FRAME_EVERY_SEC_MAX = 120;
export const LIVE_FRAME_MAX_COUNT = 240;
export const LIVE_FRAME_DEFAULT_EVERY_SEC = 30;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 soulmate-bili-live/0.1';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function clampLiveFrameEverySec(raw) {
  const n = Math.round(num(raw, LIVE_FRAME_DEFAULT_EVERY_SEC));
  const clamped = clamp(n, LIVE_FRAME_EVERY_SEC_MIN, LIVE_FRAME_EVERY_SEC_MAX);
  // Snap to nearest preset when close; otherwise keep clamped integer.
  let best = LIVE_FRAME_EVERY_SEC_PRESETS[0];
  let bestDiff = Math.abs(best - clamped);
  for (const p of LIVE_FRAME_EVERY_SEC_PRESETS) {
    const d = Math.abs(p - clamped);
    if (d < bestDiff) {
      best = p;
      bestDiff = d;
    }
  }
  return bestDiff <= 5 ? best : clamped;
}

/** How many frames to request for a video of given duration. */
export function liveFrameBudget(durationSec, everySec) {
  const every = clampLiveFrameEverySec(everySec);
  const dur = Math.max(1, Math.floor(num(durationSec, 60)));
  const n = Math.ceil(dur / every);
  const truncated = n > LIVE_FRAME_MAX_COUNT;
  return {
    everySec: every,
    count: Math.min(LIVE_FRAME_MAX_COUNT, Math.max(1, n)),
    truncated,
  };
}

export function liveFramesDir(home, bvid) {
  const id = str(bvid).replace(/[^0-9A-Za-z]/g, '') || 'unknown';
  return join(home.rootDir, 'cache', 'live-frames', id);
}

export function liveFramePublicUrl(bvid, index) {
  const id = encodeURIComponent(str(bvid));
  const i = Math.max(0, Math.floor(num(index, 0)));
  return `/dsh-soulmate/api/live-frame?bvid=${id}&i=${i}`;
}

/**
 * Probe ffmpeg. options.ffmpegPath overrides PATH lookup.
 * Returns { ok, path?, version?, error? }.
 */
export async function probeFfmpeg(options = {}) {
  const bin = str(options.ffmpegPath).trim() || 'ffmpeg';
  try {
    const { stdout, stderr, code } = await runProcess(bin, ['-version'], {
      timeoutMs: 8_000,
      env: process.env,
    });
    if (code !== 0) return { ok: false, error: `ffmpeg exited ${code}`, path: bin };
    const text = `${stdout}\n${stderr}`;
    const m = text.match(/ffmpeg version\s+(\S+)/i);
    return { ok: true, path: bin, version: m ? m[1] : 'unknown' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), path: bin };
  }
}

/** Pick the smallest usable VIDEO URL from playurl payload. */
export function pickPlayurlAudio(data) {
  const audio = Array.isArray(data?.dash?.audio) ? data.dash.audio : [];
  const sorted = [...audio].sort((a, b) => num(a.bandwidth, 9e9) - num(b.bandwidth, 9e9));
  for (const a of sorted) {
    const url = str(a.baseUrl || a.base_url || (Array.isArray(a.backupUrl) ? a.backupUrl[0] : '') || (Array.isArray(a.backup_url) ? a.backup_url[0] : ''));
    if (url) return { url, bandwidth: num(a.bandwidth) };
  }
  return null;
}

/** Pick the smallest usable video URL from playurl payload. */
export function pickPlayurlStream(data) {
  const dash = data?.dash;
  if (dash && Array.isArray(dash.video) && dash.video.length) {
    const sorted = [...dash.video].sort((a, b) => num(a.bandwidth, 9e9) - num(b.bandwidth, 9e9));
    for (const v of sorted) {
      const url = str(v.baseUrl || v.base_url || (Array.isArray(v.backupUrl) ? v.backupUrl[0] : '') || (Array.isArray(v.backup_url) ? v.backup_url[0] : ''));
      if (url) return { url, quality: num(v.id, 0), bandwidth: num(v.bandwidth), kind: 'dash' };
    }
  }
  const durl = Array.isArray(data?.durl) ? data.durl : [];
  for (const d of durl) {
    const url = str(d.url || (Array.isArray(d.backup_url) ? d.backup_url[0] : ''));
    if (url) return { url, quality: num(data.quality), bandwidth: 0, kind: 'durl' };
  }
  return null;
}

/**
 * Fetch playurl + extract stills into cache. Soft-fail shape: { ok, reason?, frames?, ... }.
 * client must expose api(path, params, init) with WBI support.
 */
export async function extractLiveFrames({
  client,
  home,
  bvid,
  cid,
  durationSec,
  everySec,
  cookie = '',
  ffmpegPath,
  nowMs = Date.now(),
} = {}) {
  const id = str(bvid).trim();
  const oid = num(cid);
  if (!id || !oid) return { ok: false, reason: 'no-id' };
  if (!str(cookie).includes('SESSDATA=')) return { ok: false, reason: 'not-logged-in' };

  const probe = await probeFfmpeg({ ffmpegPath });
  if (!probe.ok) return { ok: false, reason: 'no-ffmpeg', error: probe.error };

  const budget = liveFrameBudget(durationSec, everySec);
  let play;
  try {
    play = await client.api('/x/player/playurl', {
      bvid: id,
      cid: oid,
      qn: 16,
      fnval: 16,
      fourk: 0,
    }, { wbi: true });
  } catch (err) {
    return { ok: false, reason: 'playurl-failed', error: err instanceof Error ? err.message : String(err) };
  }
  const stream = pickPlayurlStream(play);
  if (!stream?.url) return { ok: false, reason: 'no-stream' };

  const outDir = liveFramesDir(home, id);
  await rm(outDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(outDir, { recursive: true });

  const pattern = join(outDir, 'frame_%03d.jpg');
  const headerLines = [
    `Referer: https://www.bilibili.com/video/${id}`,
    `User-Agent: ${UA}`,
    cookie ? `Cookie: ${cookie}` : '',
  ].filter(Boolean).join('\r\n') + '\r\n';

  const timeoutMs = Math.min(600_000, 30_000 + budget.count * 3_000);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-user_agent', UA,
    '-headers', headerLines,
    '-i', stream.url,
    '-vf', `fps=1/${budget.everySec}`,
    '-frames:v', String(budget.count),
    '-q:v', '5',
    pattern,
  ];

  try {
    const run = await runProcess(probe.path, args, { timeoutMs, env: process.env });
    if (run.code !== 0) {
      return {
        ok: false,
        reason: 'ffmpeg-failed',
        error: (run.stderr || run.stdout || `exit ${run.code}`).slice(0, 400),
      };
    }
  } catch (err) {
    return { ok: false, reason: 'ffmpeg-failed', error: err instanceof Error ? err.message : String(err) };
  }

  const names = (await readdir(outDir)).filter((n) => /^frame_\d+\.jpe?g$/i.test(n)).sort();
  if (!names.length) return { ok: false, reason: 'no-output' };

  const frames = names.map((name, i) => {
    const timeSec = i * budget.everySec;
    return {
      index: i,
      file: name,
      path: join(outDir, name),
      url: liveFramePublicUrl(id, i),
      imageUrl: liveFramePublicUrl(id, i),
      timeSec,
      label: formatClock(timeSec),
      x: 0,
      y: 0,
      width: 640,
      height: 360,
      sheetWidth: 640,
      sheetHeight: 360,
      source: 'live-ffmpeg',
    };
  });

  // Tiny manifest for the asset route / debugging
  await writeFile(
    join(outDir, 'manifest.json'),
    JSON.stringify({
      bvid: id,
      cid: oid,
      everySec: budget.everySec,
      truncated: budget.truncated,
      at: new Date(nowMs).toISOString(),
      count: frames.length,
      files: names,
    }),
    'utf8',
  );

  return {
    ok: true,
    reason: 'ok',
    everySec: budget.everySec,
    truncated: budget.truncated,
    quality: stream.quality,
    frames,
    dir: outDir,
  };
}

function formatClock(sec) {
  const s = Math.max(0, Math.floor(num(sec)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function runProcess(command, args, { timeoutMs = 15_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Test helper: write fake jpeg-ish files as if ffmpeg ran. */
export async function writeFakeLiveFrames(home, bvid, count = 3) {
  const dir = liveFramesDir(home, bvid);
  await mkdir(dir, { recursive: true });
  const files = [];
  for (let i = 1; i <= count; i += 1) {
    const name = `frame_${String(i).padStart(3, '0')}.jpg`;
    // Minimal JPEG SOI/EOI so MIME sniffers stay happy enough.
    await writeFile(join(dir, name), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    files.push(name);
  }
  return { dir, files };
}

export async function ensureLiveFramesCacheRoot(home) {
  const root = join(home.rootDir, 'cache', 'live-frames');
  await mkdir(root, { recursive: true });
  return root;
}

/** Unique temp dir for one-off experiments (tests). */
export function scratchLiveDir() {
  return join(tmpdir(), `soulmate-live-${randomBytes(4).toString('hex')}`);
}

export async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
