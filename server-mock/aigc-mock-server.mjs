// AIGC official-site reference server (mock) for Soulmate cloud sync.
// Pure Node (node:http + node:crypto), zero external dependencies.
//
// Contract: docs/specs/2026-11-06-dsh-plugins-soulmate-design.md  §7
// Tenant isolation: every authenticated request is bucketed STRICTLY by sha256(apiKey);
// two keys can never observe each other's persona / memory / events / capabilities.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEVICE_CODE_TTL_SEC = 300;
const BASE_PATH = '/api/v1/soulmate';

const toMs = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const list = (v) => (Array.isArray(v) ? v : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const xmlEscape = (s) =>
  str(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

const DEFAULT_CAPABILITIES = Object.freeze([
  Object.freeze({
    name: 'soulmate_cloud_draw_selfie',
    title: '生成伴侣今日纪念照',
    description:
      'Call AIGC cloud model to generate a commemorative illustration/selfie of Soulmate in a scene and hang it on the 3D room photo wall.',
    parameters: {
      scene: { type: 'string', required: true, description: 'Scene description' },
      style: { type: 'string', description: 'Visual style' },
    },
  }),
  Object.freeze({
    name: 'soulmate_cloud_deep_research',
    title: 'AIGC 云端知识库深度检索',
    description: 'Query the AIGC cloud knowledge base for a topic and return a researched summary.',
    parameters: {
      query: { type: 'string', required: true, description: 'Topic to research' },
    },
  }),
]);

function newTenantStore() {
  return {
    persona: null, // { value, stamp }
    state: null,
    appearance: null,
    wikiMap: new Map(), // slug -> { value, stamp }
    factMap: new Map(), // id -> { value, stamp }
    episodeMap: new Map(), // `${date}-${kind}` -> { value, stamp }
    tombstones: new Map(), // `${kind}:${id}` -> { value, stamp }
    opsMap: new Map(), // `${kind}:${id}:${at}` -> { value, stamp }
    events: [],
    capabilities: structuredClone(DEFAULT_CAPABILITIES),
    lastStamp: 0,
  };
}

function snapshotStore(store) {
  const dump = (map) => [...map.values()].map((e) => structuredClone(e.value));
  return {
    persona: store.persona ? structuredClone(store.persona.value) : null,
    state: store.state ? structuredClone(store.state.value) : null,
    appearance: store.appearance ? structuredClone(store.appearance.value) : null,
    wikiMap: dump(store.wikiMap),
    factMap: dump(store.factMap),
    episodeMap: dump(store.episodeMap),
    tombstones: dump(store.tombstones),
    opsMap: dump(store.opsMap),
    events: structuredClone(store.events),
    capabilities: structuredClone(store.capabilities),
  };
}

function maskUserId(userId) {
  const s = str(userId);
  return s.length <= 8 ? `${s.slice(0, 2)}****` : `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function bearerKey(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : '';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(isObject(parsed) ? parsed : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function startMockAigcServer(port = 0) {
  const tenants = new Map(); // sha256(apiKey) -> store
  const identities = new Map(); // sha256(apiKey) -> { userId, nickname } (survives data wipe)
  const pendingDevices = new Map(); // deviceCode -> { userCode, expiresAt, approved: null | { apiKey, user } }
  let eventSeq = 0; // global, so event ids never repeat even after a wipe
  let baseUrl = '';

  const tenantOf = (apiKey) => {
    const id = sha256(apiKey);
    let store = tenants.get(id);
    if (!store) {
      store = newTenantStore();
      tenants.set(id, store);
    }
    return store;
  };

  const userOf = (apiKey) => {
    const id = sha256(apiKey);
    const meta = identities.get(id) ?? {};
    const userId = str(meta.userId) || `u_${id.slice(0, 12)}`;
    return {
      userId,
      maskedId: str(meta.maskedId) || maskUserId(userId),
      nickname: str(meta.nickname) || 'Soulmate User',
      tier: 'pro',
    };
  };

  // Strictly increasing per-tenant stamps; `nextCursor` is always >= every issued stamp and
  // every later stamp is > nextCursor, so a client using `stamp > sinceCursor` never misses data.
  const stampOf = (store) => {
    store.lastStamp = Math.max(Date.now(), store.lastStamp + 1);
    return store.lastStamp;
  };
  const cursorOf = (store) => {
    store.lastStamp = Math.max(Date.now(), store.lastStamp);
    return store.lastStamp;
  };

  // ---- LWW merge helpers -------------------------------------------------
  const mergeTombstones = (store, incoming, touched) => {
    for (const t of list(incoming)) {
      if (!isObject(t) || !str(t.kind) || !str(t.id) || !toMs(t.deletedAt)) continue;
      const key = `${t.kind}:${t.id}`;
      const prev = store.tombstones.get(key);
      if (prev && toMs(prev.value.deletedAt) >= toMs(t.deletedAt)) continue;
      store.tombstones.set(key, {
        value: { kind: str(t.kind), id: str(t.id), deletedAt: t.deletedAt },
        stamp: stampOf(store),
      });
      touched.add(`tombstone:${key}`);
      const map = { fact: store.factMap, wiki: store.wikiMap, episode: store.episodeMap }[t.kind];
      const existing = map?.get(str(t.id));
      if (existing && toMs(existing.value.updatedAt) <= toMs(t.deletedAt)) map.delete(str(t.id));
    }
  };

  const mergeUpserts = (store, map, kind, items, keyOf, touched) => {
    let accepted = 0;
    for (const item of list(items)) {
      if (!isObject(item)) continue;
      const key = keyOf(item);
      if (!key || !toMs(item.updatedAt)) continue;
      const tomb = store.tombstones.get(`${kind}:${key}`);
      if (tomb && toMs(tomb.value.deletedAt) >= toMs(item.updatedAt)) continue;
      const prev = map.get(key);
      if (prev && toMs(prev.value.updatedAt) >= toMs(item.updatedAt)) continue;
      map.set(key, { value: structuredClone(item), stamp: stampOf(store) });
      touched.add(`${kind}:${key}`);
      accepted++;
    }
    return accepted;
  };

  const mergeSingleton = (store, field, incoming, touched) => {
    if (!isObject(incoming) || !toMs(incoming.updatedAt)) return;
    const prev = store[field];
    if (prev && toMs(prev.value.updatedAt) >= toMs(incoming.updatedAt)) return;
    store[field] = { value: structuredClone(incoming), stamp: stampOf(store) };
    touched.add(`singleton:${field}`);
  };

  const collect = (map, since, kind, touched) =>
    [...map.entries()]
      .filter(([key, e]) => e.stamp > since && !touched.has(`${kind}:${key}`))
      .map(([, e]) => structuredClone(e.value));

  // ---- capability executors ----------------------------------------------
  const executors = {
    soulmate_cloud_draw_selfie(args) {
      const scene = str(args.scene).trim();
      const style = str(args.style).trim() || 'dreamy watercolor';
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">` +
        `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0" stop-color="#0b1026"/><stop offset="1" stop-color="#4facfe"/></linearGradient></defs>` +
        `<rect width="512" height="512" fill="url(#g)"/>` +
        `<circle cx="256" cy="220" r="86" fill="#00f2fe" opacity="0.85"/>` +
        `<circle cx="228" cy="206" r="9" fill="#0b1026"/><circle cx="284" cy="206" r="9" fill="#0b1026"/>` +
        `<path d="M226 246 Q256 270 286 246" stroke="#0b1026" stroke-width="6" fill="none" stroke-linecap="round"/>` +
        `<text x="256" y="400" font-size="22" fill="#ffffff" text-anchor="middle" font-family="sans-serif">${xmlEscape(scene)}</text>` +
        `<text x="256" y="436" font-size="14" fill="#b721ff" text-anchor="middle" font-family="sans-serif">${xmlEscape(style)}</text>` +
        `</svg>`;
      return {
        memento: {
          id: `mem_${randomBytes(6).toString('hex')}`,
          title: scene,
          imageUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
          createdAt: new Date().toISOString(),
        },
        message: `纪念照已生成：${scene}（风格：${style}），已可挂到 3D 家园照片墙。`,
      };
    },
    soulmate_cloud_deep_research(args) {
      const query = str(args.query).trim();
      return {
        result: {
          query,
          summary: `[mock] AIGC 云端知识库关于「${query}」的研究摘要。`,
          sources: [
            { title: `${query} — overview`, url: `${baseUrl}/kb/${encodeURIComponent(query)}` },
          ],
        },
        message: `已完成「${query}」的云端检索。`,
      };
    },
  };

  // ---- request handling -------------------------------------------------
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (method === 'GET' && path === '/verify') {
      const code = escapeHtml(url.searchParams.get('code') ?? '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Soulmate</title><h1>Authorize Soulmate</h1><p>Code: <b>${code}</b></p>`);
      return;
    }
    if (!path.startsWith(`${BASE_PATH}/`)) return sendJson(res, 404, { ok: false, error: 'Not found' });
    const route = path.slice(BASE_PATH.length);

    // ---- unauthenticated: device flow ----
    if (method === 'POST' && route === '/auth/device-code') {
      const deviceCode = randomBytes(16).toString('hex');
      const raw = randomBytes(4).toString('hex').toUpperCase();
      const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      pendingDevices.set(deviceCode, {
        userCode,
        expiresAt: Date.now() + DEVICE_CODE_TTL_SEC * 1000,
        approved: null,
      });
      return sendJson(res, 200, {
        ok: true,
        deviceCode,
        userCode,
        verificationUrl: `${baseUrl}/verify?code=${userCode}`,
        expiresIn: DEVICE_CODE_TTL_SEC,
      });
    }
    if (method === 'POST' && route === '/auth/device-token') {
      const body = await readJsonBody(req);
      const entry = pendingDevices.get(str(body.deviceCode));
      if (!entry || entry.expiresAt < Date.now()) {
        if (entry) pendingDevices.delete(str(body.deviceCode));
        return sendJson(res, 400, { ok: false, error: 'Unknown or expired deviceCode' });
      }
      if (!entry.approved) return sendJson(res, 200, { ok: false, pending: true });
      return sendJson(res, 200, { ok: true, apiKey: entry.approved.apiKey, user: entry.approved.user });
    }

    // ---- authenticated ----
    const apiKey = bearerKey(req);
    if (!apiKey) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });

    if (method === 'GET' && route === '/me') {
      return sendJson(res, 200, {
        ok: true,
        user: userOf(apiKey),
        quota: { memoryLimit: 10000, aigcCredits: 500 },
        serverTime: new Date().toISOString(),
      });
    }

    if (method === 'POST' && route === '/sync') {
      const body = await readJsonBody(req);
      const store = tenantOf(apiKey);
      const since = Number(body.sinceCursor) || 0;
      const touched = new Set(); // what this very request wrote: never echoed back

      mergeTombstones(store, body.tombstones, touched);
      mergeSingleton(store, 'persona', body.persona, touched);
      mergeSingleton(store, 'state', body.state, touched);
      mergeSingleton(store, 'appearance', body.appearance, touched);
      mergeUpserts(store, store.wikiMap, 'wiki', body.wikiUpserts, (i) => str(i.slug), touched);
      mergeUpserts(store, store.factMap, 'fact', body.factUpserts, (i) => str(i.id), touched);
      mergeUpserts(
        store,
        store.episodeMap,
        'episode',
        body.episodeUpserts,
        (i) => (str(i.date) && str(i.kind) ? `${str(i.date)}-${str(i.kind)}` : ''),
        touched
      );
      mergeUpserts(store, store.opsMap, 'ops', body.ops, (i) => `${i?.kind}:${i?.id ?? i?.keepId}:${i?.at}`, touched);

      const single = (field) =>
        store[field] && store[field].stamp > since && !touched.has(`singleton:${field}`)
          ? structuredClone(store[field].value)
          : null;

      return sendJson(res, 200, {
        ok: true,
        nextCursor: cursorOf(store),
        remotePersona: single('persona'),
        remoteState: single('state'),
        remoteAppearance: single('appearance'),
        remoteWikiUpserts: collect(store.wikiMap, since, 'wiki', touched),
        remoteFactUpserts: collect(store.factMap, since, 'fact', touched),
        remoteEpisodeUpserts: collect(store.episodeMap, since, 'episode', touched),
        remoteOps: collect(store.opsMap, since, 'ops', touched),
        remoteTombstones: [...store.tombstones.entries()]
          .filter(([key, e]) => e.stamp > since && !touched.has(`tombstone:${key}`))
          .map(([, e]) => structuredClone(e.value)),
      });
    }

    if (method === 'GET' && route === '/capabilities') {
      return sendJson(res, 200, { ok: true, capabilities: structuredClone(tenantOf(apiKey).capabilities) });
    }

    const invokeMatch = method === 'POST' ? /^\/capabilities\/([^/]+)\/invoke$/.exec(route) : null;
    if (invokeMatch) {
      const name = decodeURIComponent(invokeMatch[1]);
      const cap = tenantOf(apiKey).capabilities.find((c) => c.name === name);
      const exec = executors[name];
      if (!cap || !exec) return sendJson(res, 404, { ok: false, error: `Unknown capability: ${name}` });
      const body = await readJsonBody(req);
      const args = isObject(body.args) ? body.args : body;
      for (const [param, def] of Object.entries(cap.parameters ?? {})) {
        if (def.required && !str(args[param]).trim()) {
          return sendJson(res, 400, { ok: false, error: `Missing required parameter: ${param}` });
        }
      }
      return sendJson(res, 200, { ok: true, capability: name, ...exec(args) });
    }

    if (method === 'GET' && route === '/events') {
      const afterId = Number(url.searchParams.get('afterId')) || 0;
      return sendJson(res, 200, { ok: true, events: tenantOf(apiKey).events.filter((e) => e.id > afterId) });
    }

    if (method === 'DELETE' && route === '/me/data') {
      tenants.delete(sha256(apiKey));
      return sendJson(res, 200, { ok: true, wipedAt: new Date().toISOString() });
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      sendJson(res, Number(err?.status) || 500, { ok: false, error: err?.message || 'Internal error' });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  baseUrl = `http://127.0.0.1:${actualPort}`;

  return {
    port: actualPort,
    baseUrl,

    /** Simulate the user clicking "authorize" on the website. */
    approveDeviceCode(deviceCode, apiKey, userMeta = {}) {
      const entry = pendingDevices.get(str(deviceCode));
      if (!entry || entry.expiresAt < Date.now() || !str(apiKey)) return false;
      const key = str(apiKey);
      const meta = isObject(userMeta) ? userMeta : {};
      identities.set(sha256(key), {
        userId: str(meta.userId),
        maskedId: str(meta.maskedId),
        nickname: str(meta.nickname),
      });
      entry.approved = { apiKey: key, user: userOf(key) };
      return true;
    },

    /** Queue a server-originated event (announcement, quota notice, ...) for one tenant. */
    pushServerEvent(apiKey, event = {}) {
      const store = tenantOf(str(apiKey));
      const record = { id: ++eventSeq, createdAt: new Date().toISOString(), ...(isObject(event) ? event : { message: str(event) }) };
      record.id = eventSeq;
      store.events.push(record);
      return record;
    },

    /** Test/debug helper: deep copy of one tenant's isolated store (undefined when never created / wiped). */
    inspectTenant(apiKey) {
      const store = tenants.get(sha256(str(apiKey)));
      return store ? snapshotStore(store) : undefined;
    },

    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function escapeHtml(s) {
  return xmlEscape(s);
}
