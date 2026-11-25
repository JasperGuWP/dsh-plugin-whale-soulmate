// 插件自更新:三渠道检查——本地打包源目录 / npm registry / GitHub Releases,取最高版本;
// 面板一键下载(远程包先校验 integrity/大小)→ pnpm add → 按需重启桌面端。
// 只在「装在 profile 里」的副本上生效:repo 源码副本(packageRoot 不含 node_modules)不自我安装。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { appendJsonl } from '../state.mjs';
import { probeRemoteChannels, downloadUpdateTgz } from './update-channels.mjs';

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
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const inProfile = packageRoot.replace(/\\/g, '/').includes('/node_modules/');
  // Test guard: only an INJECTED fetch may hit the network from a source checkout —
  // the repo's own integration boots must never probe npm/GitHub for real.
  const allowRemote = !!deps.fetchImpl || inProfile;
  const profileDir = join(packageRoot, '..', '..');
  let timer = null;
  let disposed = false;
  let busy = false;
  const state = {
    current: '', latest: '', available: false, tgz: '', phase: 'idle', error: '',
    channel: '', remoteUrl: '', integrity: '', bytes: 0, channels: {}, channelErrors: {},
  };

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
    const sourceDir = String(u.sourceDir || '').trim();
    const wantNpm = u.checkNpm !== false;
    const wantGithub = u.checkGithub !== false;
    if (!inProfile || u.enabled === false || (!sourceDir && !wantNpm && !wantGithub)) {
      state.available = false;
      state.latest = '';
      state.tgz = '';
      state.channel = '';
      return;
    }
    // Local tarballs (dev/release machine) + remote channels; highest version wins.
    const candidates = [];
    if (sourceDir) {
      const { best, tgz } = await scanSource(sourceDir);
      if (best) candidates.push({ channel: 'local', version: best, tgz });
    }
    state.channels = {};
    state.channelErrors = {};
    if (candidates.length) state.channels.local = candidates[0].version;
    if (allowRemote && (wantNpm || wantGithub)) {
      const { candidates: remote, errors } = await probeRemoteChannels(fetchImpl, { npm: wantNpm, github: wantGithub });
      for (const r of remote) {
        candidates.push(r);
        state.channels[r.channel] = r.version;
      }
      state.channelErrors = errors;
    }
    let best = null;
    for (const c of candidates) {
      if (!best || cmpVer(c.version, best.version) > 0) best = c;
    }
    state.latest = best ? best.version : '';
    state.channel = best ? best.channel : '';
    state.tgz = best?.tgz || '';
    state.remoteUrl = best?.url || '';
    state.integrity = best?.integrity || '';
    state.bytes = best?.bytes || 0;
    state.available = !!best && cmpVer(best.version, state.current) > 0;
    if (state.phase === 'installed' && !state.available) state.phase = 'idle';
  }

  /** 面板「更新」:远程包先下载+校验到缓存,再 pnpm add;跑完需重启才生效。 */
  async function install() {
    if (busy) return { ok: false, error: 'busy' };
    if (!inProfile) return { ok: false, error: 'dev copy: self-install disabled' };
    await check();
    if (!state.available) return { ok: false, error: 'no newer version on any channel' };
    const bins = deps.bins || runtimeBins();
    if (!existsSync(bins.node) || !existsSync(bins.pnpm)) return { ok: false, error: 'dsh runtime node/pnpm not found' };
    busy = true;
    state.phase = 'installing';
    state.error = '';
    let target = state.tgz;
    try {
      if (!target || !existsSync(target)) {
        if (!state.remoteUrl) { busy = false; state.phase = 'error'; state.error = 'no tarball on the winning channel'; return { ok: false, error: state.error }; }
        const cacheDir = deps.cacheDir || join(homedir(), '.dsh', 'soulmate', 'cache', 'updates');
        target = await downloadUpdateTgz(fetchImpl, {
          channel: state.channel, version: state.latest, url: state.remoteUrl,
          integrity: state.integrity, bytes: state.bytes,
        }, cacheDir);
      }
    } catch (err) {
      busy = false;
      state.phase = 'error';
      state.error = `下载更新失败：${err?.message || err}（网络受限时可配置代理或改用本地源目录）`;
      log(state.error);
      return { ok: false, error: state.error };
    }
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
    return { ok: true, version, needRestart: true, channel: state.channel };
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