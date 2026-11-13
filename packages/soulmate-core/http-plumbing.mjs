// HTTP plumbing (works with registerRoute / register(prefix) / use / get+post).
// No plugin state: route tables are built elsewhere, mounted via mountHttp.

import { errMsg, isObject } from './small-utils.mjs';

export const jsonOut = (status, data) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  body: JSON.stringify(data),
});
export const statusOf = (result) => (result && result.ok === false ? (result.blockedReason ? 422 : 400) : 200);

/** Sniff the uploaded companion art so the served MIME never depends on a stale .ext. */
export function spriteMimeOf(buf) {
  if (!buf || buf.length < 12) return 'application/octet-stream';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

export async function readJsonBody(req, limit = 1_000_000) {
  if (req && req.body !== undefined && req.body !== null && typeof req.body !== 'string' && !Buffer.isBuffer(req.body)) {
    return isObject(req.body) ? req.body : {};
  }
  let raw = '';
  if (req && (typeof req.body === 'string' || Buffer.isBuffer(req.body))) {
    raw = req.body.toString('utf8');
  } else if (req && typeof req.on === 'function') {
    raw = await new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('request body too large'));
          return;
        }
        chunks.push(Buffer.from(c));
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  return isObject(parsed) ? parsed : {};
}

export function writeOut(res, out) {
  if (!res) return out;
  if (typeof res.writeHead === 'function') {
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  } else if (typeof res.status === 'function') {
    res.status(out.status);
    for (const [k, v] of Object.entries(out.headers)) (res.setHeader ?? res.set ?? (() => {})).call(res, k, v);
    (res.send ?? res.end).call(res, out.body);
  }
  return out;
}

/** One request → one route handler, with the same-origin / JSON guards every POST gets. */
export async function runRoute(route, req, res, { ready } = {}) {
  let out;
  try {
    if (ready) await ready;
    const headers = req?.headers ?? {};
    const url = new URL(req?.url ?? req?.originalUrl ?? route.paths[0], 'http://soulmate.local');
    if (route.method === 'POST' && !route.external) {
      if (headers.origin && headers.host) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(headers.origin).host === headers.host;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) {
          out = jsonOut(403, { ok: false, error: 'cross-origin request rejected' });
        }
      }
      if (!out && req?.headers && !/json/i.test(String(headers['content-type'] ?? ''))) {
        out = jsonOut(415, { ok: false, error: 'content-type must be application/json' });
      }
    }
    if (!out) {
      const body = route.method === 'POST' ? await readJsonBody(req) : {};
      out = await route.handler({ req, query: url.searchParams, body });
    }
  } catch (err) {
    out = jsonOut(err instanceof SyntaxError ? 400 : 500, { ok: false, error: err instanceof SyntaxError ? 'invalid JSON body' : errMsg(err) });
  }
  return writeOut(res, out);
}

/** Mount HTTP routes once webServer is ACTIVE, adapting to the four host registration styles. */
export function mountHttp(webServer, { routes, ready, warn }) {
  const run = (route, req, res) => runRoute(route, req, res, { ready });
  /** Prefix-style dispatcher for hosts without per-route registration. */
  const dispatch = async (req, res, next) => {
    const method = String(req?.method ?? 'GET').toUpperCase();
    let pathname = '/';
    try {
      pathname = new URL(req?.url ?? req?.originalUrl ?? '/', 'http://soulmate.local').pathname;
    } catch {
      pathname = '/';
    }
    // Collapse accidental `//` from client URL joins (e.g. API+'/sprite').
    if (pathname.includes('//')) pathname = pathname.replace(/\/{2,}/g, '/');
    const route = routes.find((r) => r.method === method && r.paths.includes(pathname));
    if (!route) {
      if (typeof next === 'function') return next();
      return writeOut(res, jsonOut(404, { ok: false, error: `no soulmate route for ${method} ${pathname}` }));
    }
    return run(route, req, res);
  };

  const disposers = [];
  const keep = (dispose) => {
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  if (typeof webServer.registerRoute === 'function') {
    for (const route of routes) {
      for (const path of route.paths) {
        keep(webServer.registerRoute(route.method, path, (req, res) => run(route, req, res)));
      }
    }
  } else if (typeof webServer.register === 'function') {
    for (const path of ['/dsh-soulmate']) {
      keep(webServer.register({ kind: 'prefix', path, handler: dispatch }));
    }
  } else if (typeof webServer.use === 'function') {
    keep(webServer.use(dispatch));
  } else if (typeof webServer.get === 'function') {
    for (const route of routes) {
      const verb = route.method.toLowerCase();
      if (typeof webServer[verb] !== 'function') continue;
      for (const path of route.paths) keep(webServer[verb](path, (req, res) => run(route, req, res)));
    }
  } else {
    warn('webServer has no register/registerRoute/use/get — HTTP routes not mounted');
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (err) {
        warn('route dispose failed', err);
      }
    }
  };
}
