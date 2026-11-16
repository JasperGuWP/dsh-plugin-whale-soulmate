// Companion art + desktop-pet sprite routes. Binary responses; MIME is sniffed
// from the bytes so a stale extension never mislabels the served image.

import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  BUNDLED_SPRITE_CHIBI,
  DEFAULT_SPRITE_URL,
  DEFAULT_SPRITE_MALE_URL,
  PET_SKINS,
  PET_FRAME_ID,
  PET_VIDEO_NAME,
  PET_VIDEO_MIME,
} from '../assets.mjs';
import { jsonOut, readJsonBody, spriteMimeOf } from '../http-plumbing.mjs';
import { loadConfig } from '../state.mjs';
import { videoNameOf } from '../video-cues.mjs';

export function assetRoutes({ home, evolvePersona, skins = PET_SKINS }) {
  // Retired skins fold into the default shipped skin so stale saved configs keep
  // working; anything else still fails loud (traversal-proof whitelist).
  const retired = new Set(['classic', 'underwater', 'winterboy']);
  const skinId = (id) => (skins[id] || !retired.has(id) ? id : 'winterboy-chibi');
  const skinDir = (id) => skins[skinId(id)];
  return [
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/notify-icon'],
      // Toast face: match the corner pet — skin idle when pet layer on, else sticker file.
      handler: async () => {
        const conf = await loadConfig(home).catch(() => null);
        const petOn = conf?.pet?.enabled !== false;
        const skin = String(conf?.pet?.skin || 'winterboy-chibi');
        const dir = skinDir(skin);
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
          buf = await readFile(BUNDLED_SPRITE_CHIBI);
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
      // look is the bundled Q版 idle frame (same art as the desktop pet).
      handler: async () => {
        let buf;
        try {
          await access(home.spriteExtPath);
          buf = await readFile(home.spritePath);
        } catch (err) {
          if (err?.code !== 'ENOENT') throw err;
          buf = await readFile(BUNDLED_SPRITE_CHIBI);
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
      // The male default is the same bundled Q版 idle frame — no full-body JPG.
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
      paths: ['/dsh-soulmate/api/pet/manifest'],
      // Sprite-pack manifest: pet.json verbatim plus stable frame URLs for the client engine.
      handler: async ({ query }) => {
        const skin = skinId(String(query.get('skin') || 'winterboy-chibi'));
        const dir = skins[skin];
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
        const dir = skinDir(String(query.get('skin') || ''));
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
        const dir = skinDir(String(query.get('skin') || 'winterboy-chibi'));
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
  ];
}
