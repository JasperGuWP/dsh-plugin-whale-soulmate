// Companion art + desktop-pet sprite routes. Binary responses; MIME is sniffed
// from the bytes so a stale extension never mislabels the served image.

import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  BUNDLED_SPRITE_CHIBI,
  BUNDLED_SPRITE_HANFU,
  DEFAULT_SPRITE_URL,
  DEFAULT_SPRITE_MALE_URL,
  PET_PACK_BASE_URL,
  PET_SKINS,
  PET_ASSETS_ROOT,
  PET_DOWNLOADABLE_SKINS,
  PET_SKIN_ID,
  PET_FRAME_ID,
  PET_VIDEO_NAME,
  PET_VIDEO_MIME,
} from '../assets.mjs';
import { jsonOut, readJsonBody, spriteMimeOf } from '../http-plumbing.mjs';
import { loadConfig } from '../state.mjs';
import { videoNameOf } from '../video-cues.mjs';

const MAX_PACK_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 192 * 1024 * 1024;
const MAX_PACK_FILES = 400;
const PACK_DOWNLOAD_TIMEOUT_MS = 45_000;

class PackInstallError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');

function tarField(header, start, length) {
  return header.toString('utf8', start, start + length).replace(/\0.*$/s, '').trimEnd();
}

function tarOctal(header, start, length) {
  const raw = tarField(header, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new PackInstallError(400, '皮肤包包含非法 tar 头');
  return Number.parseInt(raw, 8);
}

/** Minimal USTAR reader: only regular files and directories are accepted. */
function readTar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarField(header, 0, 100);
    const prefix = tarField(header, 345, 155);
    const fullName = prefix ? prefix + '/' + name : name;
    const size = tarOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new PackInstallError(400, '皮肤包 tar 数据不完整');
    if (type === '0' || type === '\0') {
      entries.push({ name: fullName, type: 'file', data: buffer.subarray(dataStart, dataEnd) });
    } else if (type === '5') {
      entries.push({ name: fullName, type: 'dir' });
    } else if (type !== 'x' && type !== 'g' && type !== 'L' && type !== 'K') {
      throw new PackInstallError(400, '皮肤包只允许普通文件和目录');
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function safeEntryPath(name) {
  const raw = String(name || '').replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new PackInstallError(400, '皮肤包包含绝对路径');
  }
  const parts = raw.split('/');
  if (parts.some((part) => part === '..')) throw new PackInstallError(400, '皮肤包包含路径穿越');
  const clean = normalize(raw).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean === '.') throw new PackInstallError(400, '皮肤包包含空路径');
  return clean;
}

async function extractPackArchive(archive, root) {
  let tar;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw new PackInstallError(413, '皮肤包解压后过大');
    throw new PackInstallError(400, '皮肤包不是有效的 tar.gz');
  }
  const entries = readTar(tar);
  if (!entries.length || entries.length > MAX_PACK_FILES) {
    throw new PackInstallError(400, '皮肤包文件数量异常');
  }
  const seen = new Set();
  let unpacked = 0;
  for (const entry of entries) {
    const clean = safeEntryPath(entry.name);
    if (seen.has(clean)) throw new PackInstallError(400, '皮肤包包含重复路径');
    seen.add(clean);
    const dest = resolve(root, clean);
    const rel = relative(root, dest);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new PackInstallError(400, '皮肤包路径越界');
    }
    if (entry.type === 'dir') {
      await mkdir(dest, { recursive: true });
      continue;
    }
    unpacked += entry.data.length;
    if (unpacked > MAX_UNPACKED_BYTES) throw new PackInstallError(413, '皮肤包解压后过大');
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, entry.data, { flag: 'wx' });
  }
}

async function downloadPack(spec, fetchImpl) {
  if (!spec || !spec.filename || !spec.sha256 || !spec.bytes) {
    throw new PackInstallError(503, '皮肤包发布信息尚未就绪');
  }
  let url;
  try {
    url = new URL(spec.url || spec.filename, PET_PACK_BASE_URL);
  } catch {
    throw new PackInstallError(400, '皮肤包下载地址无效');
  }
  if (url.protocol !== 'https:') throw new PackInstallError(400, '皮肤包只允许 HTTPS 下载');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PACK_DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(url.href, { signal: controller.signal, redirect: 'follow' });
    if (!response || !response.ok) {
      throw new PackInstallError(502, '皮肤包下载失败：HTTP ' + (response?.status || '未知'));
    }
    const declared = Number(response.headers?.get?.('content-length') || 0);
    if (declared > MAX_PACK_BYTES) throw new PackInstallError(413, '皮肤包超过下载上限');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_PACK_BYTES) throw new PackInstallError(413, '皮肤包超过下载上限');
    if (bytes.length !== Number(spec.bytes)) throw new PackInstallError(400, '皮肤包大小校验失败');
    if (sha256Of(bytes) !== String(spec.sha256).toLowerCase()) {
      throw new PackInstallError(400, '皮肤包 SHA-256 校验失败');
    }
    return bytes;
  } catch (err) {
    if (err instanceof PackInstallError) throw err;
    throw new PackInstallError(502, '皮肤包下载失败：' + (err?.name === 'AbortError' ? '超时' : '网络不可用'));
  } finally {
    clearTimeout(timer);
  }
}

export function assetRoutes({
  home,
  evolvePersona,
  skins = PET_SKINS,
  skinsRoot = PET_ASSETS_ROOT,
  downloads = PET_DOWNLOADABLE_SKINS,
  fetchImpl = globalThis.fetch,
  packRoot,
}) {
  // Retired skins fold into the default shipped skin so stale saved configs keep
  // working; anything else still fails loud (traversal-proof whitelist).
  const retired = new Set(['classic', 'underwater', 'winterboy', 'maid']);
  const skinId = (id) => (skins[id] || !retired.has(id) ? id : 'winterboy-chibi');
  const cacheRoot = packRoot || (home?.rootDir ? join(home.rootDir, 'cache', 'pet-skins') : join(skinsRoot, '.pet-skins-cache'));
  const installs = new Map();

  const cachedSkinDir = async (id) => {
    if (!PET_SKIN_ID.test(id)) return undefined;
    const dir = join(cacheRoot, 'pet-' + id);
    try {
      await access(join(dir, 'pet.json'));
      const spec = downloads[id];
      if (!spec) return dir;
      // Release assets are immutable. Keep the verified archive digest beside the
      // extracted pack so an old cache cannot silently survive a skin-pack update.
      const installed = JSON.parse(await readFile(join(dir, '.pack.json'), 'utf8'));
      if (installed.sha256 !== spec.sha256 || Number(installed.bytes) !== Number(spec.bytes)) {
        return undefined;
      }
      return dir;
    } catch {
      return undefined;
    }
  };

  // Bundled/injected map first; otherwise discover pet-<id>/pet.json on disk at
  // request time, so a freshly copied skin folder works without a restart.
  const skinDir = async (id) => {
    const key = skinId(id);
    if (skins[key]) return skins[key];
    if (!PET_SKIN_ID.test(key)) return undefined;
    // Optional packs are only visible after their verified archive is installed.
    // The source folders may remain in the development checkout for release builds.
    if (downloads[key]) return cachedSkinDir(key);
    const dir = join(skinsRoot, 'pet-' + key);
    try { await access(join(dir, 'pet.json')); return dir; } catch { return undefined; }
  };

  const installSkin = async (id) => {
    const key = String(id || '').trim();
    if (!PET_SKIN_ID.test(key) || !downloads[key]) {
      throw new PackInstallError(400, 'unknown downloadable pet skin');
    }
    const existing = await cachedSkinDir(key);
    if (existing) return { id: key, label: downloads[key].label };
    if (installs.has(key)) return installs.get(key);
    const job = (async () => {
      const spec = downloads[key];
      if (typeof fetchImpl !== 'function') throw new PackInstallError(502, '当前运行时不支持皮肤包下载');
      const archive = await downloadPack(spec, fetchImpl);
      await mkdir(cacheRoot, { recursive: true });
      const temp = await mkdtemp(join(cacheRoot, '.install-'));
      try {
        await extractPackArchive(archive, temp);
        const packDir = join(temp, 'pet-' + key);
        try {
          const manifest = JSON.parse(await readFile(join(packDir, 'pet.json'), 'utf8'));
          if (!manifest || typeof manifest !== 'object') throw new Error('empty manifest');
        } catch {
          throw new PackInstallError(400, '皮肤包缺少有效的 pet.json');
        }
        await writeFile(join(packDir, '.pack.json'), JSON.stringify({
          filename: spec.filename,
          bytes: Number(spec.bytes),
          sha256: String(spec.sha256).toLowerCase(),
        }) + '\n');
        const target = join(cacheRoot, 'pet-' + key);
        try {
          await rename(packDir, target);
        } catch (err) {
          // A concurrent installer may have won the race. Re-check instead of
          // deleting a valid cache directory.
          const valid = await cachedSkinDir(key);
          if (!valid) {
            // Older releases did not write .pack.json. Once the replacement is
            // fully verified, swap out that stale directory and retry atomically.
            await rm(target, { recursive: true, force: true });
            await rename(packDir, target);
          }
        }
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
      return { id: key, label: spec.label };
    })();
    installs.set(key, job);
    try {
      return await job;
    } finally {
      installs.delete(key);
    }
  };

  return [
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/notify-icon'],
      // Toast face: match the corner pet — skin idle when pet layer on, else sticker file.
      handler: async () => {
        const conf = await loadConfig(home).catch(() => null);
        const petOn = conf?.pet?.enabled !== false;
        const skin = String(conf?.pet?.skin || (conf?.persona?.gender === 'male' ? 'winterboy-chibi' : 'hanfu'));
        const dir = await skinDir(skin);
        if (petOn && dir) {
          try {
            const buf = await readFile(join(dir, 'pet-idle-01.png'));
            return {
              status: 200,
              headers: {
                'content-type': 'image/png',
                'cache-control': 'no-cache',
                'x-content-type-options': 'nosniff',
              },
              body: buf,
            };
          } catch {
            /* fall through to sticker */
          }
        }
        let buf;
        try {
          await access(home.spriteExtPath);
          buf = await readFile(home.spritePath);
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
          buf = await readFile(conf?.persona?.gender === 'male' ? BUNDLED_SPRITE_CHIBI : BUNDLED_SPRITE_HANFU);
        }
        return {
          status: 200,
          headers: {
            'content-type': spriteMimeOf(buf),
            'cache-control': 'no-cache',
            'x-content-type-options': 'nosniff',
          },
          body: buf,
        };
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/sprite'],
      // Serve the user-uploaded sticker only when sprite.ext exists; the default
      // look is the bundled hanfu girl drag pose (female / unspecified gender).
      handler: async () => {
        let buf;
        try {
          await access(home.spriteExtPath);
          buf = await readFile(home.spritePath);
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
          buf = await readFile(BUNDLED_SPRITE_HANFU);
        }
        // Keep headers Latin-1 only: non-ASCII Content-Disposition (e.g. 小鲸.png)
        // makes some host writeHead paths fail and the browser gets an empty 400.
        return {
          status: 200,
          headers: {
            'content-type': spriteMimeOf(buf),
            'cache-control': 'no-cache',
            'x-content-type-options': 'nosniff',
          },
          body: buf,
        };
      },
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/sprite'],
      // Overwrite 小鲸.png from a data URL; the route URL stays stable.
      handler: async (req) => {
        const body = await readJsonBody(req);
        const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
        const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
        if (!match) return jsonOut(400, { ok: false, error: '只接受 png / jpeg / webp / gif 的 data URL' });
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const buf = Buffer.from(match[2], 'base64');
        if (buf.length > 4 * 1024 * 1024) return jsonOut(413, { ok: false, error: '图片太大（上限 4MB）' });
        await mkdir(dirname(home.spritePath), { recursive: true });
        await writeFile(home.spritePath, buf);
        await writeFile(home.spriteExtPath, 'png');
        const url = DEFAULT_SPRITE_URL + '?v=' + Date.now();
        await evolvePersona({ mode: 'appearance', customSpriteUrl: url });
        return jsonOut(200, { ok: true, url, bytes: buf.length, ext, file: '小鲸.png' });
      },
    },
    {
      method: 'DELETE',
      paths: ['/dsh-soulmate/api/sprite'],
      // Drop the custom sticker: GET falls back to the bundled Q版 default.
      handler: async () => {
        await rm(home.spriteExtPath, { force: true });
        await rm(home.spritePath, { force: true });
        const url = DEFAULT_SPRITE_URL + '?v=' + Date.now();
        await evolvePersona({ mode: 'appearance', customSpriteUrl: url });
        return jsonOut(200, { ok: true, url, restored: 'Q版默认形象' });
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/sprite-male'],
      // The male default is the bundled Q版 winter-boy drag pose — no full-body JPG.
      handler: async () => {
        const buf = await readFile(BUNDLED_SPRITE_CHIBI);
        return {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'cache-control': 'no-cache',
            'x-content-type-options': 'nosniff',
          },
          body: buf,
        };
      },
    },
    {
      method: 'DELETE',
      paths: ['/dsh-soulmate/api/sprite-male'],
      handler: async () => {
        await rm(home.spriteMalePath, { force: true });
        const url = DEFAULT_SPRITE_MALE_URL + '?v=' + Date.now();
        await evolvePersona({ mode: 'appearance', customSpriteUrl: url });
        return jsonOut(200, { ok: true, url, restored: 'Q版默认形象' });
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/pet/skins'],
      // Skin catalog for the panel dropdowns. Bundled skins are always available;
      // optional packs appear as downloadable until their verified cache folder exists.
      handler: async () => {
        const entries = [];
        const seen = new Set();
        const push = async (id, dir, installed = true) => {
          if (seen.has(id)) return;
          let manifest;
          try { manifest = JSON.parse(await readFile(join(dir, 'pet.json'), 'utf8')); } catch { return; }
          seen.add(id);
          entries.push({
            id,
            label: String(manifest.displayName || id),
            preview: '/dsh-soulmate/api/pet/frame?id=pet-idle-01&skin=' + encodeURIComponent(id),
            installed,
            downloadable: Boolean(downloads[id]),
          });
        };
        for (const [id, dir] of Object.entries(skins)) await push(id, dir);
        for (const [id, spec] of Object.entries(downloads)) {
          const dir = await cachedSkinDir(id);
          if (dir) {
            await push(id, dir, true);
          } else if (!seen.has(id)) {
            seen.add(id);
            entries.push({
              id,
              label: spec.label || id,
              preview: '/dsh-soulmate/api/pet/frame?id=pet-idle-01&skin=' + encodeURIComponent(id),
              installed: false,
              downloadable: true,
            });
          }
        }
        try {
          const names = (await readdir(skinsRoot, { withFileTypes: true }))
            .filter((e) => e.isDirectory() && /^pet-[a-z0-9][a-z0-9-]*$/.test(e.name))
            .map((e) => e.name)
            .sort();
          for (const name of names) {
            const id = name.slice(4);
            // Development masters for downloadable packs are not installed skins.
            if (!downloads[id]) await push(id, join(skinsRoot, name));
          }
        } catch { /* assets root missing → bundled list only */ }
        return jsonOut(200, { ok: true, skins: entries });
      },
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/pet/skins/install'],
      // First use of an optional skin: download the GitHub Release archive,
      // verify size + SHA-256, extract safely, then atomically move it into cache.
      handler: async ({ body }) => {
        try {
          const result = await installSkin(body?.id);
          return jsonOut(200, { ok: true, ...result, installed: true });
        } catch (err) {
          const status = err instanceof PackInstallError ? err.status : 500;
          return jsonOut(status, { ok: false, error: err?.message || '皮肤安装失败' });
        }
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/pet/manifest'],
      // Sprite-pack manifest: pet.json verbatim plus stable frame URLs for the client engine.
      handler: async ({ query }) => {
        const skin = skinId(String(query.get('skin') || 'winterboy-chibi'));
        let dir = await skinDir(skin);
        // A saved optional skin may point at a cache from an older release. The
        // digest check deliberately treats it as absent; repair it in place rather
        // than leaving the pet layer broken until the user re-selects the skin.
        if (!dir && downloads[skin]) {
          try {
            await installSkin(skin);
            dir = await skinDir(skin);
          } catch (err) {
            const status = err instanceof PackInstallError ? err.status : 502;
            return jsonOut(status, { ok: false, error: err?.message || '皮肤包自动更新失败' });
          }
        }
        if (!dir) return jsonOut(400, { ok: false, error: 'unknown pet skin' });
        const manifest = JSON.parse(await readFile(join(dir, 'pet.json'), 'utf8'));
        const ids = new Set();
        for (const st of Object.values(manifest.states || {})) {
          for (const f of st.frames || []) ids.add(f);
          if (typeof st.blink === 'string') ids.add(st.blink); // wakeTo/releaseTo are state names, not frames
        }
        const frameUrls = {};
        for (const id of ids) frameUrls[id] = '/dsh-soulmate/api/pet/frame?id=' + encodeURIComponent(id) + '&skin=' + encodeURIComponent(skin);
        // Transparent-video pipeline: only SHIPPED files enter the manifest, so the
        // browser never requests a 404. No assets → both maps stay {} (dormant).
        const videoUrls = {};
        const videoMovUrls = {};
        for (const [name, st] of Object.entries(manifest.states || {})) {
          const base = videoNameOf(st);
          if (!base || !PET_VIDEO_NAME.test(base)) continue;
          const videoUrl = (ext) => '/dsh-soulmate/api/pet/video?name=' + encodeURIComponent(base) + '&skin=' + encodeURIComponent(skin) + '&ext=' + ext;
          // Cache-bust: /pet/video answers max-age=3600, so the URL must change when
          // the file changes — otherwise the webview keeps a stale clip for an hour.
          try { const s = await stat(join(dir, base + '.webm')); videoUrls[name] = videoUrl('webm') + '&v=' + s.mtimeMs.toString(36) + s.size.toString(36); } catch { /* not shipped */ }
          try { const s = await stat(join(dir, base + '.mov')); videoMovUrls[name] = videoUrl('mov') + '&v=' + s.mtimeMs.toString(36) + s.size.toString(36); } catch { /* not shipped */ }
        }
        return jsonOut(200, { ...manifest, ok: true, frameUrls, videoUrls, videoMovUrls });
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/pet/video'],
      // Serve one transparent pet video; triple whitelist (name/skin/ext) keeps the
      // path join traversal-proof, same shape as the frame route above.
      handler: async ({ query }) => {
        const name = String(query.get('name') || '');
        if (!PET_VIDEO_NAME.test(name)) return jsonOut(400, { ok: false, error: 'bad video name' });
        const dir = await skinDir(String(query.get('skin') || ''));
        if (!dir) return jsonOut(400, { ok: false, error: 'unknown pet skin' });
        const ext = String(query.get('ext') || '');
        if (ext !== 'webm' && ext !== 'mov') return jsonOut(400, { ok: false, error: 'bad video ext' });
        try {
          const buf = await readFile(join(dir, name + '.' + ext));
          return {
            status: 200,
            headers: { 'content-type': PET_VIDEO_MIME[ext], 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' },
            body: buf,
          };
        } catch (err) {
          if (err?.code === 'ENOENT') return jsonOut(404, { ok: false, error: 'video not found' });
          throw err;
        }
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/pet/frame'],
      // Serve one bundled sprite frame; id whitelist keeps this route traversal-proof.
      handler: async ({ query }) => {
        const id = String(query.get('id') || '');
        if (!PET_FRAME_ID.test(id)) return jsonOut(400, { ok: false, error: 'bad frame id' });
        const dir = await skinDir(String(query.get('skin') || 'winterboy-chibi'));
        if (!dir) return jsonOut(400, { ok: false, error: 'unknown pet skin' });
        try {
          const buf = await readFile(join(dir, id + '.png'));
          return {
            status: 200,
            headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' },
            body: buf,
          };
        } catch (err) {
          if (err?.code === 'ENOENT') return jsonOut(404, { ok: false, error: 'frame not found' });
          throw err;
        }
      },
    },
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/live-frame'],
      // Local ffmpeg stills for «真看抽帧». bvid whitelist + index only — no path traversal.
      handler: async ({ query }) => {
        const bvid = String(query.get('bvid') || '').trim();
        if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return jsonOut(400, { ok: false, error: 'bad bvid' });
        const i = Math.max(0, Math.floor(Number(query.get('i')) || 0));
        if (i > 240) return jsonOut(400, { ok: false, error: 'bad index' });
        const name = `frame_${String(i + 1).padStart(3, '0')}.jpg`;
        const file = join(home.rootDir, 'cache', 'live-frames', bvid, name);
        try {
          const buf = await readFile(file);
          return {
            status: 200,
            headers: {
              'content-type': 'image/jpeg',
              'cache-control': 'private, max-age=3600',
              'x-content-type-options': 'nosniff',
            },
            body: buf,
          };
        } catch (err) {
          if (err?.code === 'ENOENT') return jsonOut(404, { ok: false, error: 'frame not found' });
          throw err;
        }
      },
    },
  ];
}
