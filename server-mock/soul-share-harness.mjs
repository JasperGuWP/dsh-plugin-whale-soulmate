// Soul-share smoke harness: serves the REAL built client.js with the REAL
// soul-share routes over a temp home, plus enough React to mount the settings
// panel so the export → preview → import flow can be exercised in a browser.
// Throwaway verification tool (not shipped); run: node server-mock/soul-share-harness.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSoulmateHome, loadConfig } from '../packages/soulmate-core/state.mjs';
import { evolvePersona } from '../packages/soulmate-core/persona.mjs';
import { soulShareRoutes } from '../packages/soulmate-core/routes/soul-share-routes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4401;
const home = resolveSoulmateHome(await mkdtemp(join(tmpdir(), 'soul-share-smoke-')));
await evolvePersona(home, {
  mode: 'user_customize', gender: 'female', preset: 'rice-whale', name: '大海',
});

const summary = async () => ({
  ok: true, sessionId: 'smoke', displayName: '大海',
  config: await loadConfig(home),
  state: { mood: 'happy', energy: 80, affinity: 42, streakDays: 3 },
  petThinking: false, petSay: null,
});
const routes = soulShareRoutes({
  home,
  memory: { enrichSafe: async (_l, fn) => fn() },
  getSummary: summary,
  refreshPresence: () => {},
  warn: () => {},
});

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>soul-share smoke</title>
<style>html,body{margin:0;background:#f6f7f9;font:14px/1.6 system-ui}</style></head>
<body><div id="root" class="sm-panel" style="max-width:640px;margin:24px auto"></div>
<script src="https://unpkg.com/react@18/umd/react.development.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
<script>window.__hostModules = { react: window.React };
window.__ModuleLoader__ = { load(def) { window.__bundle = def; } };</script>
<script src="/client.js"></script>
<script>
(async () => {
  const mod = window.__bundle.factory((id) => window.__hostModules[id] || {});
  // Mount only the soul-share card: the full panel needs many host surfaces.
  const load = async (path) => {
    const src = await (await fetch(path)).text();
    const module_ = { exports: {} };
    const req = (id) => id === 'react' ? window.React
      : id === './util.mjs' ? { api: async (p, b) => (await (await fetch('/dsh-soulmate/api/' + p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json()), CSS_KEY: 'smoke' }
      : id === './panel-cards.mjs' ? cardsMod : {};
    new Function('require', 'module', 'exports', src)(req, module_, module_.exports);
    return module_.exports;
  };
  const cardsMod = await load('/panel-cards.mjs');
  const { injectStyles } = await load('/styles.mjs');
  injectStyles();
  const { SoulShareCard } = await load('/panel-soul-share.mjs');
  ReactDOM.createRoot(document.getElementById('root')).render(
    React.createElement(SoulShareCard, { onImported: () => console.log('imported') }));
  window.__smokeReady = true;
})();
</script></body></html>`;

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  try {
    if (u.pathname === '/') return send(200, 'text/html; charset=utf-8', HTML);
    if (u.pathname === '/client.js') return send(200, 'text/javascript', await readFile(join(ROOT, 'client.js'), 'utf8'));
    if (u.pathname === '/panel-soul-share.mjs') return send(200, 'text/javascript', await readFile(join(ROOT, 'browser/panel-soul-share.mjs'), 'utf8'));
    if (u.pathname === '/panel-cards.mjs') return send(200, 'text/javascript', await readFile(join(ROOT, 'browser/panel-cards.mjs'), 'utf8'));
    if (u.pathname === '/styles.mjs') return send(200, 'text/javascript', await readFile(join(ROOT, 'browser/styles.mjs'), 'utf8'));
    if (u.pathname === '/dsh-soulmate/api/state') return send(200, 'application/json', JSON.stringify(await summary()));
    const route = routes.find((r) => r.paths.includes(u.pathname) && r.method === req.method);
    if (route) {
      let body = {};
      if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      }
      const out = await route.handler({ query: u.searchParams, body });
      return send(out.status, 'application/json', out.body);
    }
    if (u.pathname.startsWith('/dsh-soulmate/api/')) return send(200, 'application/json', '{"ok":true}');
    return send(404, 'text/plain', 'not found');
  } catch (e) { return send(500, 'text/plain', String(e)); }
});
server.listen(PORT, '127.0.0.1', () => console.log('soul-share smoke at http://127.0.0.1:' + PORT));