// Opening-gate observability + manual tick routes (panel / 3D home).

import { loadConfig } from '../state.mjs';
import { loadSoulmateState } from '../persona.mjs';
import { getEngineSnapshot } from '../layers/index.mjs';
import { evaluateOpeningGate } from '../proactive.mjs';
import { jsonOut } from '../http-plumbing.mjs';
import { errMsg } from '../small-utils.mjs';

export function proactiveRoutes({ home, proactive, chatHome, promptText, eventSeq }) {
  const { runProactiveTick, proactiveRecent, priceInfo } = proactive;
  const { chatHomeStatus } = chatHome;
  return [
    {
      // Read-only view of the opening gate: what she would say right now, and why/why not.
      // `?now=<epoch ms>` pins the clock so the decision is reproducible from the panel.
      method: 'GET',
      paths: ['/dsh-soulmate/api/proactive/status'],
      handler: async ({ query }) => {
        const pinned = Number(query.get('now'));
        const at = Number.isFinite(pinned) && pinned > 0 ? pinned : Date.now();
        const conf = await loadConfig(home);
        const cfg = conf.proactive ?? {};
        const tz = Number.isFinite(Number(cfg.tzOffsetMinutes)) ? Number(cfg.tzOffsetMinutes) : 480;
        const [state, engine] = await Promise.all([
          loadSoulmateState(home, at),
          getEngineSnapshot(home, at, { promptText: promptText() }).catch(() => null),
        ]);
        const plan = evaluateOpeningGate({
          nowMs: at,
          tzOffsetMinutes: tz,
          strategy: engine?.scheduling?.strategy ?? {},
          state,
          config: cfg,
          recent: await proactiveRecent(),
          persona: conf.persona,
        });
        const homeStatus = await chatHomeStatus({ nowMs: at }).catch((err) => ({ ok: false, error: errMsg(err) }));
        return jsonOut(200, {
          ok: true,
          at: new Date(at).toISOString(),
          plan,
          config: cfg,
          chatHome: homeStatus,
          ...priceInfo(at),
        });
      },
    },
    {
      // Manual nudge for the 3D home / panel. Same gate: it cannot bypass the rules.
      method: 'POST',
      paths: ['/dsh-soulmate/api/proactive/tick'],
      handler: async ({ body }) => {
        const pinned = Number(body?.now);
        const at = Number.isFinite(pinned) && pinned > 0 ? pinned : Date.now();
        const res = await runProactiveTick(at);
        return jsonOut(200, { ...res, eventSeq: eventSeq() });
      },
    },
    {
      // 「拉取最新」: run the QQ bridge now instead of waiting for the 2-min tick.
      method: 'POST',
      paths: ['/dsh-soulmate/api/qqbot/sync'],
      handler: async () => {
        if (typeof proactive.syncQqbotBridge !== 'function') return jsonOut(200, { ok: false, error: 'bridge unavailable' });
        const res = await proactive.syncQqbotBridge();
        return jsonOut(200, res);
      },
    },
  ];
}
