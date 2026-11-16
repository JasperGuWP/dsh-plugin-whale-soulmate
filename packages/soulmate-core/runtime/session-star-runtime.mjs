// Session stars: auto window episodes for the dedicated companion chat window.
// Discovery (workspace registry), fingerprint dedupe, debounced upserts. Split out
// of chat-home-runtime so each module keeps a single responsibility.

import { join } from 'node:path';
import { loadConfig, saveConfigAuto } from '../state.mjs';
import { getDisplayName } from '../persona.mjs';
import { upsertSessionEpisode } from '../memory-engine.mjs';
import { measureFromRecords, normalizeChatHome } from '../chat-home.mjs';
import {
  isChatHomeWorkspace,
  registerKnownSession,
  sessionIdsToWatch,
  fingerprintMeasure,
  createDebouncedRunner,
  captureSessionStarOnce,
} from '../session-star.mjs';
import { errMsg } from '../small-utils.mjs';

export function createSessionStarRuntime({ home, ctx, sessionController, warn }) {
  /** In-memory fingerprints so tick/deliver do not rewrite unchanged stars. */
  const lastSessionStarFingerprints = new Map();
  /** Warn once per sessionId when controller.events is missing. */
  const sessionStarNoEventsWarned = new Set();
  const sessionStarDebouncer = createDebouncedRunner({ waitMs: 2500 });

  /** Persist chatHome patch after ensure/rotate. */
  const saveChatHome = async (chatHome) => {
    await saveConfigAuto(home, { chatHome: normalizeChatHome(chatHome) });
    return normalizeChatHome(chatHome);
  };

  /** Register a chat-home session id (immutable patch + save only when new). */
  const noteChatHomeSession = async (sessionId) => {
    const id = String(sessionId || '').trim();
    if (!id) return normalizeChatHome((await loadConfig(home)).chatHome);
    const conf = await loadConfig(home);
    const cur = normalizeChatHome(conf.chatHome);
    if (cur.knownSessionIds.includes(id)) return cur;
    return saveChatHome(registerKnownSession(cur, id));
  };

  /** Best-effort: collect session ids under a workspace object / registry. */
  const collectWorkspaceSessionIds = (ws, reg) => {
    const out = [];
    const add = (raw) => {
      if (raw == null) return;
      if (typeof raw === 'string' || typeof raw === 'number') {
        const s = String(raw).trim();
        if (s && !out.includes(s)) out.push(s);
        return;
      }
      if (typeof raw === 'object') {
        const s = String(raw.sessionId || raw.id || '').trim();
        if (s && !out.includes(s)) out.push(s);
      }
    };
    const pull = (list) => {
      if (Array.isArray(list)) for (const item of list) add(item);
    };
    pull(ws?.sessions);
    pull(ws?.sessionIds);
    if (typeof ws?.listSessions === 'function') {
      try { pull(ws.listSessions()); } catch { /* optional */ }
    }
    if (typeof reg?.listSessions === 'function') {
      try {
        const wid = ws?.id || ws?.workspaceId;
        pull(wid != null ? reg.listSessions(wid) : reg.listSessions());
      } catch { /* optional */ }
    }
    return out;
  };

  /**
   * Discover sessions under chat-home workspaces and fold into knownSessionIds.
   * Returns { chatHome, changed } — caller saves only when changed.
   */
  const discoverChatHomeSessions = async (chatHome, conf) => {
    const reg = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : ctx.workspaceRegistry;
    if (!reg || typeof reg.list !== 'function') {
      return { chatHome, changed: false };
    }
    let workspaces = [];
    try {
      const list = reg.list();
      workspaces = Array.isArray(list) ? list : [];
    } catch {
      return { chatHome, changed: false };
    }
    const pluginSessionsDir = home?.rootDir ? join(home.rootDir, 'plugin-sessions') : '';
    const personaName = getDisplayName(conf?.persona).trim();
    let next = chatHome;
    let changed = false;
    for (const ws of workspaces) {
      if (!isChatHomeWorkspace(ws, { pluginSessionsDir, personaName })) continue;
      for (const sid of collectWorkspaceSessionIds(ws, reg)) {
        const before = next.knownSessionIds || [];
        next = registerKnownSession(next, sid);
        if ((next.knownSessionIds || []).length !== before.length) changed = true;
      }
    }
    return { chatHome: next, changed };
  };

  /** Measure + upsert one session star (shared by tick debounce and deliver fast path). */
  const runSessionStarUpsert = async (sessionId, preset = {}) => {
    const id = String(sessionId || '').trim();
    if (!id) return { ok: false, reason: 'no-session' };
    try {
      const conf = preset.conf || await loadConfig(home);
      const chatHome = normalizeChatHome(preset.chatHome || conf.chatHome);
      if (chatHome.autoMemory === false) return { ok: false, reason: 'disabled' };

      let measure = preset.measure;
      if (!measure) {
        const controller = sessionController();
        if (typeof controller?.events !== 'function') {
          if (!sessionStarNoEventsWarned.has(id)) {
            sessionStarNoEventsWarned.add(id);
            warn(`session star skip ${id}: no events API`);
          }
          return { ok: false, reason: 'no-events' };
        }
        const page = await controller.events({
          address: { kind: 'session', sessionId: id },
          maxMessages: 80,
        }, new AbortController().signal);
        measure = measureFromRecords(page);
      }

      const fp = fingerprintMeasure(measure);
      if (lastSessionStarFingerprints.get(id) === fp) {
        return { ok: true, skipped: 'unchanged' };
      }

      const title = String(chatHome.titlePrefix || getDisplayName(conf.persona) || id).trim();
      const result = await captureSessionStarOnce({
        sessionId: id,
        measure,
        title,
        callUser: conf.persona?.callUser,
        upsert: (input) => upsertSessionEpisode(home, input),
      });
      if (result?.ok === true || result?.reason === 'empty-summary') {
        lastSessionStarFingerprints.set(id, fp);
      }
      return result;
    } catch (err) {
      warn('session star upsert failed', err);
      return { ok: false, error: errMsg(err) };
    }
  };

  /** Fast-path / debounce entry: coalesce bursts per sessionId. */
  const scheduleSessionStarCapture = (sessionId) => {
    const id = String(sessionId || '').trim();
    if (!id) return;
    sessionStarDebouncer.schedule(id, () => runSessionStarUpsert(id));
  };

  /**
   * Main path: discover chat-home sessions, fingerprint watch list, debounce upserts.
   * autoMemory false → no-op. Missing events API → skip + warn once; never throw.
   */
  async function maybeCaptureSessionStars({ at } = {}) {
    const conf = await loadConfig(home);
    let chatHome = normalizeChatHome(conf.chatHome);
    if (chatHome.autoMemory === false) {
      return { ok: true, skipped: 'disabled', at };
    }

    try {
      const discovered = await discoverChatHomeSessions(chatHome, conf);
      if (discovered.changed) {
        chatHome = await saveChatHome(discovered.chatHome);
      } else {
        chatHome = discovered.chatHome;
      }
    } catch (err) {
      warn('session star discover failed', err);
    }

    const controller = sessionController();
    const ids = sessionIdsToWatch(chatHome);
    let scheduled = 0;
    let skippedUnchanged = 0;

    if (typeof controller?.events !== 'function') {
      for (const id of ids) {
        if (!sessionStarNoEventsWarned.has(id)) {
          sessionStarNoEventsWarned.add(id);
          warn(`session star skip ${id}: no events API`);
        }
      }
      return { ok: true, scheduled: 0, skippedUnchanged: 0, noEvents: true, at };
    }

    for (const sessionId of ids) {
      try {
        const page = await controller.events({
          address: { kind: 'session', sessionId },
          maxMessages: 80,
        }, new AbortController().signal);
        const measure = measureFromRecords(page);
        const fp = fingerprintMeasure(measure);
        if (lastSessionStarFingerprints.get(sessionId) === fp) {
          skippedUnchanged += 1;
          continue;
        }
        sessionStarDebouncer.schedule(sessionId, () =>
          runSessionStarUpsert(sessionId, { conf, chatHome, measure }),
        );
        scheduled += 1;
      } catch (err) {
        warn(`session star measure failed for ${sessionId}`, err);
      }
    }

    return { ok: true, scheduled, skippedUnchanged, at };
  }

  return { maybeCaptureSessionStars, noteChatHomeSession, scheduleSessionStarCapture };
}
