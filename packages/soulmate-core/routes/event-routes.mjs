// Lightweight activity-feed poll for the browser half (OS toasts, widget flashes).
// The neural-graph route already carries events, but it rebuilds the whole graph —
// too heavy for a 5s notification poll. This one is a pure in-memory slice.

import { jsonOut } from '../http-plumbing.mjs';

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
  ];
}
