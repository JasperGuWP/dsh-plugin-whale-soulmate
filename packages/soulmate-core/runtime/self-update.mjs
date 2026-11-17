// 插件自更新:定时对照「打包源目录」里的最新 tarball 与已安装版本,面板一键 pnpm add
// 安装新包,再按需重启桌面端。源目录为空 = 关闭检查(开发机/发布机才配)。
// 只在「装在 profile 里」的副本上生效:repo 源码副本(packageRoot 不含 node_modules)不自我安装。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { appendJsonl } from '../state.mjs';

const DEFAULT_INTERVAL_SEC = 300;

export function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map((n) => Number(n) || 0);
  const pb = String(b || '0').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function runtimeBins() {
  const base = join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies');
  return {
    node: join(base, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    pnpm: join(base, 'pnpm', 'bin', 'pnpm.cjs'),
  };
}

/**
 * deps: getConfig() → 用户配置 / packageRoot(本副本根) / warn / spawnImpl? / execPath?
 * 返回 { begin, dispose, status, install, restart }。
 */
export function createSelfUpdate(deps) {
  const { getConfig, packageRoot, warn } = deps;
  const spawnImpl = deps.spawnImpl || spawn;
  const execPath = deps.execPath || process.execPath;
  const inProfile = packageRoot.replace(/\\/g, '/').includes('/node_modules/');
  const profileDir = join(packageRoot, '..', '..');
  let timer = null;
  let disposed = false;
  let busy = false;
  const state = { current: '', latest: '', available: false, tgz: '', phase: 'idle', error: '' };

  const log = (m) => { if (typeof warn === 'function') warn(`[self-update] ${m}`); };

  async function readCurrent() {
    try {
      const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
      state.current = String(pkg.version || '');
    } catch { state.current = ''; }
  }

  /** 源目录里名字匹配的最大版本 tarball = 可安装的最新版本。 */
  async function scanSource(dir) {
    let best = '';
    let tgz = '';
    let names = [];
    try { names = await readdir(dir); } catch { return { best, tgz }; }
    for (const name of names) {
      const m = /^dsh-plugin-whale-soulmate-(\d+(?:\.\d+)*)\.tgz$/.exec(name);
      if (!m) continue;
      if (!best || cmpVer(m[1], best) > 0) { best = m[1]; tgz = join(dir, name); }
    }
    return { best, tgz };
  }

  async function check() {
    if (disposed) return;
    await readCurrent();
    const cfg = (await (getConfig && getConfig())) || {};
    const u = cfg.update || {};
    if (!inProfile || u.enabled === false || !String(u.sourceDir || '').trim()) {
      state.available = false;
      state.latest = '';
      state.tgz = '';
      return;
    }
    const { best, tgz } = await scanSource(String(u.sourceDir).trim());
    state.latest = best;
    state.tgz = tgz;
    state.available = !!best && cmpVer(best, state.current) > 0;
    if (state.phase === 'installed' && !state.available) state.phase = 'idle';
  }

  /** 面板「更新」:pnpm add <tgz> 到本 profile;跑完需重启才生效。 */
  async function install() {
    if (busy) return { ok: false, error: 'busy' };
    if (!inProfile) return { ok: false, error: 'dev copy: self-install disabled' };
    await check();
    if (!state.available || !state.tgz || !existsSync(state.tgz)) return { ok: false, error: 'no newer tarball in source dir' };
    const bins = deps.bins || runtimeBins();
    if (!existsSync(bins.node) || !existsSync(bins.pnpm)) return { ok: false, error: 'dsh runtime node/pnpm not found' };
    busy = true;
    state.phase = 'installing';
    state.error = '';
    const target = state.tgz;
    const version = state.latest;
    const code = await new Promise((resolve) => {
      const child = spawnImpl(bins.node, [bins.pnpm, 'add', target], { cwd: profileDir, stdio: 'ignore', windowsHide: true });
      child.once('exit', (c) => resolve(c == null ? 1 : c));
      child.once('error', () => resolve(1));
    });
    busy = false;
    if (code !== 0) {
      state.phase = 'error';
      state.error = `pnpm add exited ${code}`;
      log(state.error);
      return { ok: false, error: state.error };
    }
    state.phase = 'installed';
    state.current = version;
    state.available = false;
    return { ok: true, version, needRestart: true };
  }

  /** 面板「重启」:仅桌面端(exe 宿主)能自重启;web profile 返回手动重启提示。 */
  async function restart() {
    const name = basename(execPath);
    const logIt = (rec) => {
      if (deps.home && deps.home.proactiveLogPath) {
        appendJsonl(deps.home.proactiveLogPath, { at: new Date().toISOString(), kind: 'self-restart', ...rec }).catch(() => {});
      }
    };
    if (process.platform !== 'win32' || !/DeepSeek Harness/i.test(name)) {
      logIt({ ok: false, execPath, reason: 'not-desktop' });
      return { ok: false, error: 'not the desktop app: restart the host manually' };
    }
    const cmd = `Start-Sleep -Seconds 2; Stop-Process -Name '${name.replace(/\.exe$/i, '')}' -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; Start-Process -FilePath '${execPath}'`;
    const child = spawnImpl('powershell', ['-NoProfile', '-Command', cmd], { detached: true, stdio: 'ignore', windowsHide: true });
    if (child && typeof child.unref === 'function') child.unref();
    logIt({ ok: true, execPath, pid: child && child.pid });
    return { ok: true };
  }

  async function begin() {
    if (disposed || timer) return;
    await check();
    const cfg = (await (getConfig && getConfig())) || {};
    const sec = Number(cfg.update && cfg.update.intervalSec);
    timer = setInterval(() => { check(); }, (Number.isFinite(sec) && sec >= 30 ? sec : DEFAULT_INTERVAL_SEC) * 1000);
    timer.unref?.();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { begin, dispose, install, restart, status: () => ({ ...state, inProfile }) };
}