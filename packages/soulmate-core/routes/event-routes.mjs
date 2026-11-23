// Lightweight activity-feed poll for the browser half (OS toasts, widget flashes).
// The neural-graph route already carries events, but it rebuilds the whole graph —
// too heavy for a 5s notification poll. This one is a pure in-memory slice.

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

import { jsonOut } from '../http-plumbing.mjs';

/**
 * Focus the desktop Harness window via the OS protocol handler.
 * Renderer `window.open('dsh://open')` is denied by Electron's setWindowOpenHandler
 * (only http/https); `window.focus()` also cannot restore a minimized window on Windows.
 * Spawning `dsh://open` through the shell hits second-instance / open-url → focusPrimaryWindow.
 */
export function focusDshViaProtocol() {
  try {
    if (process.platform === 'win32') {
      execFile('cmd.exe', ['/c', 'start', '', 'dsh://open'], { windowsHide: true }, () => {});
      return true;
    }
    if (process.platform === 'darwin') {
      execFile('open', ['dsh://open'], () => {});
      return true;
    }
    execFile('xdg-open', ['dsh://open'], () => {});
    return true;
  } catch (_) {
    return false;
  }
}

// Toast 点击焦点的进程内重试：Windows 前台锁会让第一次 show/focus 只闪任务栏，
// ~0.9s / ~2.2s 再补两次，把人真正带到窗口前。同时只保留一组挂起重试（连点不堆积）。
const focusRetryTimers = new Set();

function scheduleFocusRetries(focusImpl) {
  for (const t of focusRetryTimers) clearTimeout(t);
  focusRetryTimers.clear();
  for (const delay of [900, 2200]) {
    const t = setTimeout(() => {
      focusRetryTimers.delete(t);
      try { focusImpl(); } catch (_) { /* best-effort */ }
    }, delay);
    t.unref?.();
    focusRetryTimers.add(t);
  }
}

/**
 * AttachWindow 策略（仅当宿主运行在 Electron 主进程内才可用）：
 * 直接枚举本应用窗口 restore/show/focus，比协议 handler 少一次进程跳转；
 * 跳过最小化到托盘前主动 hide 的窗口以外的一切可见性判断——hide 的窗口 show 出来正是用户要的。
 * 返回聚焦到的窗口数；非 Electron / 无窗口返回 0，调用方回落协议。
 */
export function focusHarnessWindowsDirect() {
  try {
    if (!process.versions?.electron) return 0;
    // ESM 里没有全局 require；node 半侧运行在 Electron 主进程时 createRequire 能拿到内置 electron。
    const electron = createRequire(import.meta.url)('electron');
    const BrowserWindow = electron?.BrowserWindow;
    if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return 0;
    let n = 0;
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w || w.isDestroyed()) continue;
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
        n += 1;
      } catch (_) { /* next window */ }
    }
    return n;
  } catch (_) {
    return 0;
  }
}

/** 测试缝：允许注入聚焦实现，验证重试与回落。 */
export function focusHarnessForToast({ directImpl = focusHarnessWindowsDirect, protocolImpl = focusDshViaProtocol } = {}) {
  let via = 'protocol';
  let windows = 0;
  try {
    windows = directImpl();
    if (windows > 0) via = 'electron';
  } catch (_) { /* fall through */ }
  // 无论 direct 是否成功都补一发协议：direct 只覆盖本进程窗口，协议还能唤起未进入工作区等状态。
  const protocol = protocolImpl();
  scheduleFocusRetries(() => {
    try { directImpl(); } catch (_) { /* ignore */ }
    try { protocolImpl(); } catch (_) { /* ignore */ }
  });
  return { via, windows, protocol };
}

/** 测试用：清掉挂起的重试定时器。 */
export function clearFocusRetryTimers() {
  for (const t of focusRetryTimers) clearTimeout(t);
  focusRetryTimers.clear();
}

export function eventRoutes({ events, eventSeq, pushEvent }) {
  return [
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/events'],
      handler: async ({ query }) => {
        const since = Number(query.get('since')) || 0;
        return jsonOut(200, {
          ok: true,
          events: events.filter((e) => e.seq > since),
          eventSeq: eventSeq(),
        });
      },
    },
    {
      // Manual OS-toast probe (panel / agent). Emits a proactive activity event.
      method: 'POST',
      paths: ['/dsh-soulmate/api/notify/ping'],
      handler: async ({ body }) => {
        const text = String(body?.text || '系统通知测一下——右下角应该会出现这一条。').trim();
        const seq = typeof pushEvent === 'function'
          ? pushEvent('proactive', { kind: 'ping', text, dateKey: '' })
          : 0;
        return jsonOut(200, { ok: true, seq, eventSeq: eventSeq() });
      },
    },
    {
      // Toast click → bring Harness to foreground (node can spawn the protocol; renderer cannot).
      method: 'POST',
      paths: ['/dsh-soulmate/api/notify/focus'],
      handler: async ({ body }) => {
        const sessionId = String(body?.sessionId || '').trim();
        const focus = focusHarnessForToast();
        return jsonOut(200, { ok: true, focused: focus.protocol || focus.windows > 0, via: focus.via, windows: focus.windows, sessionId });
      },
    },
  ];
}
