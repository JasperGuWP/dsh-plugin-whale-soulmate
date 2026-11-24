// 星空独立大窗:与桌宠窗同一条 loopback + Electron 管线,但是一扇正常带边框、可拉伸的窗。
// 打开是手动的(面板「放大」按钮 POST open),关掉窗口即结束,不像桌宠那样常驻轮询。
// 页面只跑星空渲染器(不加载整个面板 bundle),同源直连插件路由。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfigAuto } from '../state.mjs';
import { runRoute, jsonOut, writeOut } from '../http-plumbing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(HERE, '..', '..', '..');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>记忆星空</title>
<style>
html,body{margin:0;height:100%;background:#05070f;overflow:hidden}
canvas{display:block;width:100vw;height:100vh;cursor:grab}
#hud{position:fixed;left:14px;top:12px;color:rgba(196,210,240,.75);font:12px ui-monospace,Menlo,monospace;pointer-events:none}
#hint{position:fixed;right:14px;bottom:10px;color:rgba(150,170,220,.45);font:11px ui-monospace,Menlo,monospace;pointer-events:none}
</style></head><body>
<canvas id="sky"></canvas>
<div id="hud">记忆星空</div>
<div id="hint">拖动旋转 · 滚轮缩放 · 单击查看 · 双击飞近 · Esc 关闭</div>
<script src="/neuron.js"></script>
<script>
(function () {
  var canvas = document.getElementById('sky')
  var hud = document.getElementById('hud')
  var graph = null
  var since = 0
  var seeded = false
  function fit() {
    var dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(window.innerWidth * dpr)
    canvas.height = Math.round(window.innerHeight * dpr)
  }
  fit()
  window.addEventListener('resize', fit)
  function poll() {
    fetch('/dsh-soulmate/api/neural-graph?since=' + since).then(function (r) { return r.json() }).then(function (g) {
      if (g && g.ok !== false) {
        graph = g
        // First poll only seeds the cursor — replaying the whole activity feed as
        // soft birth/flash glows made every window open look fogged with light.
        if (seeded && Array.isArray(g.events) && g.events.length) window.__neuronFx.noteEvents(canvas, g.events, Date.now())
        if (g.eventSeq) since = g.eventSeq
        seeded = true
        var n = (g.nodes || []).length
        hud.textContent = '记忆星空 · ' + n + ' 颗星' + (window.__neuronFx.progressActive(canvas) ? ' · 正在整理记忆…' : '')
      }
    }).catch(function () {})
  }
  poll()
  setInterval(poll, 8000)
  function frame(t) {
    if (graph) window.__neuronFx.drawNeurons(canvas, graph, t)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (window.__neuronWindow && window.__neuronWindow.close) window.__neuronWindow.close()
      else window.close()
    }
  })
})()
</script></body></html>`;

function defaultElectronPath() {
  return join(homedir(), '.dsh', 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron');
}

/** deps: home / routes / ready / warn / packageRoot? / spawnImpl? / electronPath? */
export function createNeuronWindowRuntime(deps) {
  const { home, ready, warn } = deps;
  const packageRoot = deps.packageRoot || DEFAULT_ROOT;
  const spawnImpl = deps.spawnImpl || spawn;
  let server = null;
  let child = null;
  let disposed = false;
  let lastError = '';
  let routesRef = Array.isArray(deps.routes) ? deps.routes : [];

  const log = (msg) => { if (typeof warn === 'function') warn(`[neuron-window] ${msg}`); };

  async function handler(req, res) {
    let pathname = '/';
    try { pathname = new URL(req.url || '/', 'http://soulmate.local').pathname; } catch { pathname = '/'; }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (pathname === '/neuron.js') {
      try {
        const src = await readFile(join(packageRoot, 'runtime', 'neuron-window', 'neuron-bundle.js'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(src);
      } catch {
        writeOut(res, jsonOut(500, { ok: false, error: 'neuron-bundle.js unreadable — run build:client' }));
      }
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();
    const route = routesRef.find((r) => r.method === method && r.paths.includes(pathname));
    if (!route) {
      writeOut(res, jsonOut(404, { ok: false, error: `no soulmate route for ${method} ${pathname}` }));
      return;
    }
    await runRoute(route, req, res, { ready });
  }

  function listen() {
    return new Promise((resolve, reject) => {
      server = createServer((req, res) => { handler(req, res).catch(() => { try { res.destroy(); } catch { /* gone */ } }); });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
  }

  function stop() {
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
      child = null;
    }
    if (server) {
      try { server.close(); } catch { /* already closed */ }
      server = null;
    }
  }

  /** Manual open (panel 放大 button). Idempotent: an open window is reported, not duplicated. */
  async function open() {
    if (disposed) return { ok: false, error: 'disposed' };
    if (child) return { ok: true, already: true, port: server ? server.address().port : null };
    const conf = await loadConfig(home).catch(() => null);
    const exe = String(deps.electronPath || conf?.pet?.windowElectronPath || '').trim() || defaultElectronPath();
    if (!existsSync(exe)) {
      lastError = `Electron 运行时不存在(${exe})——可在 pet.windowElectronPath 指定,或安装桌面端`;
      return { ok: false, error: lastError };
    }
    let port;
    try { port = await listen(); } catch (err) {
      server = null;
      lastError = `loopback 服务启动失败: ${err && err.message}`;
      return { ok: false, error: lastError };
    }
    const env = { ...process.env, SOULMATE_NEURON_WINDOW_URL: `http://127.0.0.1:${port}/` };
    delete env.ELECTRON_RUN_AS_NODE;
    const bounds = conf?.extensions?.neuronWindowBounds;
    if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)) {
      env.SOULMATE_NEURON_BOUNDS = JSON.stringify(bounds);
    }
    child = spawnImpl(exe, [join(packageRoot, 'runtime', 'neuron-window', 'main.cjs')], { env, stdio: 'ignore', windowsHide: true });
    child.once('exit', () => { child = null; stop(); });
    child.once('error', (err) => { log(`helper 启动失败: ${err && err.message}`); child = null; stop(); });
    lastError = '';
    return { ok: true, port };
  }

  /** The window reports its bounds before closing so the next open lands where it was. */
  async function rememberBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') return { ok: false };
    const b = {
      x: Math.round(Number(bounds.x) || 0),
      y: Math.round(Number(bounds.y) || 0),
      width: Math.max(480, Math.round(Number(bounds.width) || 1100)),
      height: Math.max(360, Math.round(Number(bounds.height) || 760)),
    };
    await saveConfigAuto(home, { extensions: { neuronWindowBounds: b } }).catch(() => {});
    return { ok: true };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
  }

  return {
    open,
    close: stop,
    dispose,
    rememberBounds,
    /** Routes are built after this runtime (they reference it); attach once, before open. */
    setRoutes: (r) => { routesRef = Array.isArray(r) ? r : []; },
    status: () => ({
      running: !!child,
      port: server ? server.address().port : null,
      lastError,
    }),
  };
}