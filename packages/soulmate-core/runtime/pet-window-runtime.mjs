// 桌面独立窗口形态的 node 侧生命周期:loopback 小服务(页 + client.js + 复用路由表)
// + Electron helper 子进程。配置 pet.windowEnabled 为开关,与页内 pet.enabled 互不影响。
// 服务只绑 127.0.0.1 且不经 dsh web 的 token 鉴权——窗口页与 API 同源,fetch 直接可用。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../state.mjs';
import { runRoute, jsonOut, writeOut } from '../http-plumbing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(HERE, '..', '..', '..');
const POLL_MS = 2000;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>桌面小伙伴</title>
<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}</style></head><body>
<script>
window.__smPetWindow = 1;
window.__hostModules = { react: { createElement: () => ({}), useState: (i) => [typeof i === 'function' ? i() : i, () => {}], useRef: (i) => ({ current: i }), useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f() } };
window.__ModuleLoader__ = { load(def) { window.__bundle = def; } };
</script><script src="/client.js"></script><script>
window.__bundle.factory((id) => window.__hostModules[id] || {}).apply({ inject: () => {}, get: () => undefined, effect: (fn) => { try { fn(); } catch (e) {} } });
</script></body></html>`;

function defaultElectronPath() {
  return join(homedir(), '.dsh', 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron');
}

/**
 * deps: home / routes / ready / warn / packageRoot? / spawnImpl? / electronPath? / pollMs?
 * 返回 { begin, sync, dispose, port, alive }。begin 起轮询;dispose 可逆收掉一切。
 */
export function createPetWindowRuntime(deps) {
  const { home, routes, ready, warn } = deps;
  const packageRoot = deps.packageRoot || DEFAULT_ROOT;
  const spawnImpl = deps.spawnImpl || spawn;
  const pollMs = Number(deps.pollMs) || POLL_MS;
  let server = null;
  let child = null;
  let timer = null;
  let disposed = false;
  let wantOn = false;
  let missingWarned = false;
  let cooldownUntil = 0;
  let lastElectronPath = '';
  let lastElectronExists = null;

  const log = (msg) => { if (typeof warn === 'function') warn(`[pet-window] ${msg}`); };

  async function handler(req, res) {
    let pathname = '/';
    try { pathname = new URL(req.url || '/', 'http://soulmate.local').pathname; } catch { pathname = '/'; }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (pathname === '/client.js') {
      try {
        const src = await readFile(join(packageRoot, 'client.js'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(src);
      } catch {
        writeOut(res, jsonOut(500, { ok: false, error: 'client.js unreadable' }));
      }
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();
    const route = (routes || []).find((r) => r.method === method && r.paths.includes(pathname));
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

  async function start() {
    if (disposed || child) return;
    const conf = await loadConfig(home);
    const exe = String(deps.electronPath || conf?.pet?.windowElectronPath || '').trim() || defaultElectronPath();
    lastElectronPath = exe;
    lastElectronExists = existsSync(exe);
    if (!lastElectronExists) {
      if (!missingWarned) {
        missingWarned = true;
        log(`Electron 运行时不存在(${exe})——桌面窗口形态不可用;可在 pet.windowElectronPath 指定,或安装桌面端。页内形象不受影响。`);
      }
      return;
    }
    let port;
    try { port = await listen(); } catch (err) { log(`loopback 服务启动失败: ${err && err.message}`); server = null; return; }
    const env = { ...process.env, SOULMATE_PET_WINDOW_URL: `http://127.0.0.1:${port}/` };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawnImpl(exe, [join(packageRoot, 'runtime', 'pet-window', 'main.cjs')], { env, stdio: 'ignore', windowsHide: true });
    child.once('exit', () => {
      child = null;
      // 启动即退(页面加载失败等)时冷却 5s,避免轮询变成崩溃循环
      cooldownUntil = Date.now() + 5000;
    });
    child.once('error', (err) => { log(`helper 启动失败: ${err && err.message}`); child = null; });
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

  /** 配置 → 进程状态对齐;轮询与手动都走这里,幂等。 */
  async function sync() {
    if (disposed) return;
    let conf = null;
    try { conf = await loadConfig(home); } catch { return; }
    const want = !!conf?.pet?.windowEnabled;
    if (want === wantOn && (want ? !!child : !child)) return;
    wantOn = want;
    if (want) {
      if (Date.now() < cooldownUntil) return;
      await start();
    } else stop();
  }

  function begin() {
    if (disposed || timer) return;
    sync();
    timer = setInterval(() => { sync(); }, pollMs);
    timer.unref?.();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (timer) { clearInterval(timer); timer = null; }
    stop();
  }

  return {
    begin, sync, dispose,
    port: () => (server ? server.address().port : null),
    alive: () => !!child,
    /** Panel status: is the window form wanted/running, and is an Electron runtime on disk? */
    status: () => ({
      enabled: wantOn,
      running: !!child,
      port: server ? server.address().port : null,
      electronPath: lastElectronPath || defaultElectronPath(),
      electronExists: lastElectronExists === null ? existsSync(lastElectronPath || defaultElectronPath()) : lastElectronExists,
    }),
  };
}