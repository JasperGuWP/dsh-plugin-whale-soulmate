// Lightweight activity-feed poll for the browser half (OS toasts, widget flashes).
// The neural-graph route already carries events, but it rebuilds the whole graph —
// too heavy for a 5s notification poll. This one is a pure in-memory slice.

import { execFile } from 'node:child_process';

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
        const focused = focusDshViaProtocol();
        return jsonOut(200, { ok: true, focused, sessionId });
      },
    },
  ];
}
