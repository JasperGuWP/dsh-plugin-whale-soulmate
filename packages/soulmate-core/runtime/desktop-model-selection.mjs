// Follow the model the user currently has selected in DSH. Internal one-shot calls
// (intent / dream / IM proactive / engage) must default to that selection instead of
// auto-picking "cheapest flash" — the user's picker is the single source of truth.
//
// Reuses the qqbot-model-sync primitives: live `model/selection` session events plus
// a startup scan of session summaries, excluding QQ-bound and subagent sessions.

import {
  createLatestSelectionTracker,
  createPrefsReader,
  defaultPrefsPath,
  pickLatestDesktopSelection,
} from '../qqbot-model-sync.mjs';

export function createDesktopModelSelection({ ctx, warn, sessionController }) {
  const readPrefs = createPrefsReader(defaultPrefsPath());
  const tracker = createLatestSelectionTracker(readPrefs);
  const disposers = [];
  let seeded = false;

  const off = typeof ctx?.on === 'function'
    ? ctx.on('session/event', (session, event) => {
        try { tracker.observe(session, event); } catch { /* never break a turn */ }
      }, { global: true })
    : null;
  if (typeof off === 'function') disposers.push(off);

  // Startup seed: newest ordinary desktop session carrying a recorded selection.
  (async () => {
    const scanVersion = tracker.beginScan();
    for (let attempt = 0; attempt < 40; attempt++) {
      const controller = typeof sessionController === 'function' ? sessionController() : null;
      if (typeof controller?.list === 'function') {
        try {
          const result = await controller.list(new AbortController().signal);
          const summaries = Array.isArray(result) ? result : result?.items;
          const candidate = pickLatestDesktopSelection(summaries, readPrefs());
          if (tracker.seed(candidate, scanVersion)) seeded = true;
        } catch (err) {
          warn?.('desktop model selection scan failed', err);
        }
        return;
      }
      await new Promise((r) => { const t = setTimeout(r, 500); t.unref?.(); });
    }
  })();

  return {
    /** {provider, model, reasoningEffort?} | undefined */
    current: () => tracker.current(),
    /** The session the selection came from — account-authenticated routes may scope
     *  their credential to a live session, so one-shot calls should carry it. */
    currentSessionId: () => tracker.currentSession?.(),
    seeded: () => seeded,
    dispose: () => { for (const d of disposers) { try { d(); } catch { /* gone */ } } },
  };
}