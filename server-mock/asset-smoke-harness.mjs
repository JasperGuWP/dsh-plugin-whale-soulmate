// Throwaway smoke harness: serves the REAL built client.js plus the REAL plugin asset
// routes (manifest/frame/video) so both finalized skins can be verified in Chrome.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetRoutes } from '../packages/soulmate-core/routes/asset-routes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4399;
const routes = assetRoutes({ home: {}, evolvePersona: async () => {} });
const find = (m, p) => routes.find((r) => r.method === m && r.paths.includes(p)).handler;
const manifestH = find('GET', '/dsh-soulmate/api/pet/manifest');
const frameH = find('GET', '/dsh-soulmate/api/pet/frame');
const videoH = find('GET', '/dsh-soulmate/api/pet/video');

const snapshot = (skin) => ({
  ok: true, sessionId: 's1', displayName: '小鲸',
  config: { onboardingCompleted: true, pet: { enabled: true, sizePx: 148, sleepAfterIdleSec: 300, thinkQuietSec: 6, skin }, persona: { preset: 'rice-whale' }, appearance: {} },
  state: { mood: 'happy' }, petThinking: false, petSay: null,
});

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>pet asset smoke</title>
<style>html,body{margin:0;height:100%;background:linear-gradient(135deg,#0b1e3a,#123a5e 60%,#0a2540)}</style></head>
<body><script>
window.__hostModules = { react: { createElement: () => ({}), useState: (i) => [typeof i==='function'?i():i, () => {}], useRef: (i) => ({ current: i }), useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f() } };
window.__ModuleLoader__ = { load(def) { window.__bundle = def; } };
</script><script src="/client.js"></script><script>
(async () => {
  const mod = window.__bundle.factory((id) => window.__hostModules[id] || {});
  mod.apply({ inject: () => {}, get: () => undefined, effect: (fn) => { try { fn(); } catch (e) {} } });
  window.__smokeReady = true;
})();
</script></body></html>`;

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, ...extra }); res.end(body); };
  try {
    if (u.pathname === '/favicon.ico') return send(204, 'image/x-icon', '');
    if (u.pathname === '/' || u.pathname === '/index.html') return send(200, 'text/html; charset=utf-8', HTML);
    if (u.pathname === '/client.js') return send(200, 'text/javascript', await readFile(join(ROOT, 'client.js'), 'utf8'));
    if (u.pathname === '/dsh-soulmate/api/state') {
      const ref = new URL(req.headers.referer || 'http://x/', 'http://x');
      return send(200, 'application/json', JSON.stringify(snapshot(ref.searchParams.get('skin') || 'winterboy-chibi')));
    }
    if (u.pathname === '/dsh-soulmate/api/pet/manifest') { const o = await manifestH({ query: u.searchParams }); return send(o.status, 'application/json', o.body); }
    if (u.pathname === '/dsh-soulmate/api/pet/frame') { const o = await frameH({ query: u.searchParams }); return send(o.status, o.headers['content-type'], o.body, o.headers); }
    if (u.pathname === '/dsh-soulmate/api/pet/video') { const o = await videoH({ query: u.searchParams }); return send(o.status, o.headers['content-type'], o.body, o.headers); }
    if (u.pathname.startsWith('/dsh-soulmate/api/')) return send(200, 'application/json', '{"ok":true}');
    return send(404, 'text/plain', 'not found');
  } catch (e) { return send(500, 'text/plain', String(e)); }
});
server.listen(PORT, '127.0.0.1', () => console.log('asset smoke harness at http://127.0.0.1:' + PORT));
