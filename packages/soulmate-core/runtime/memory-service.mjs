// The ctx.soulmate service surface: thin wrappers around the pure engines that
// add the activity feed, presence refresh and enrichment side-effects. Also owns
// extension cards, mementos and dynamically mounted cloud capabilities.

import { readFile } from 'node:fs/promises';
import { atomicWriteJson, loadConfig, saveConfigAuto } from '../state.mjs';
import {
  applyInteraction,
  computeBondStage,
  evolvePersona as evolvePersonaImpl,
  getDisplayName,
  getNotebookTitles,
  loadSoulmateState,
  normalizeGender,
  presetShortName,
  resetPersona as resetPersonaImpl,
} from '../persona.mjs';
import {
  buildNeuralGraph,
  composePresenceDigest,
  forgetMemory,
  recallMemory,
  recordEpisode as recordEpisodeImpl,
  reflectToWiki,
  resolveConflict as resolveConflictImpl,
  retainFact as retainFactImpl,
  updatePromise as updatePromiseImpl,
} from '../memory-engine.mjs';
import {
  upsertIdentityAnchors,
  recordBondMilestone,
  appendSelfArc,
  retainEmotionUndertone,
} from '../memory-enrichment.mjs';
import { appendPrivacyAudit } from '../privacy-firewall.mjs';
import { localClock } from '../proactive.mjs';
import { clip, errMsg, isObject } from '../small-utils.mjs';
import { defineTool } from '../tool-kit.mjs';
import { GENERIC_OUTPUT } from '../tool-cards.mjs';
import { largePersonaArcReason, identityFieldsChanged } from '../persona-arcs.mjs';
import { titleForIndex } from '../chat-home.mjs';

export function createMemoryService({ home, gateway, cfg, promptEngine, pushEvent, warn, track, registerTool, ensureHomeSession, sessionController }) {
  const { refreshPrompt, refreshPresence, touchPetActivity } = promptEngine;

  /** Enrichment must never break onboard / evolve / interact / promise happy paths. */
  async function enrichSafe(label, fn) {
    try {
      await fn();
    } catch (err) {
      warn(`memory enrichment ${label} failed`, err);
    }
  }

  // ------------------------------------------------------------------ extensions & mementos
  const extensions = new Map();
  function registerExtension(meta) {
    if (!isObject(meta) || typeof meta.id !== 'string' || !meta.id.trim()) {
      throw new Error('[soulmate] registerExtension requires { id, name }');
    }
    const entry = {
      id: meta.id.trim(),
      name: String(meta.name ?? meta.id),
      description: String(meta.description ?? ''),
      version: String(meta.version ?? ''),
      enabled: meta.enabled !== false,
      // A switch that lives in config.json must be re-read at render time: the panel may
      // flip it while the service is already mounted, and a card registered once would
      // otherwise keep claiming "active" for a feature that is refusing every call.
      enabledWhen: typeof meta.enabledWhen === 'function' ? meta.enabledWhen : null,
    };
    extensions.set(entry.id, entry);
    return () => {
      if (extensions.get(entry.id) === entry) extensions.delete(entry.id);
    };
  }

  /** Project a registered extension into the card the panel renders, honouring live config. */
  function extensionCards(conf) {
    return [...extensions.values()].map((entry) => {
      if (!entry.enabledWhen) {
        return { ...entry, enabledWhen: undefined, status: entry.enabled ? 'active' : 'disabled' };
      }
      let enabled = entry.enabled;
      try {
        enabled = entry.enabledWhen(conf) !== false;
      } catch (err) {
        warn(`extension ${entry.id} enabledWhen failed`, err);
      }
      const { enabledWhen: _w, ...card } = entry;
      return { ...card, enabled, status: enabled ? 'active' : 'disabled' };
    });
  }

  async function readMementos() {
    try {
      const parsed = JSON.parse(await readFile(home.mementosPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.mementos) ? parsed.mementos : [];
    } catch {
      return [];
    }
  }
  async function addMemento(memento) {
    if (!isObject(memento)) return { ok: false, error: 'memento must be an object' };
    const list = await readMementos();
    const entry = { source: 'local', createdAt: new Date().toISOString(), ...memento };
    list.push(entry);
    await atomicWriteJson(home.mementosPath, list);
    return { ok: true, memento: entry };
  }

  // ------------------------------------------------------------------ cloud capabilities
  let capabilityHandle = null;
  let capabilityList = [];
  const capabilityOutput = { schema: GENERIC_OUTPUT, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  async function mountCapabilities() {
    capabilityHandle?.dispose();
    capabilityHandle = null;
    capabilityList = [];
    const handle = await gateway.fetchAndMountCapabilities((def) => {
      const tool = defineTool({
        name: def.name,
        description: def.description,
        parameters: isObject(def.parameters) ? def.parameters : {},
        output: capabilityOutput,
        execute: (args) => def.execute(args),
      });
      return track(() => registerTool(tool));
    });
    if (handle.ok) {
      capabilityHandle = handle;
      capabilityList = handle.capabilities ?? [];
      for (const cap of capabilityList) pushEvent('capability', { ids: [`capability:${cap?.name}`] });
    }
    return { ok: handle.ok, reason: handle.reason, mounted: handle.mounted };
  }
  track(() => () => {
    capabilityHandle?.dispose();
    capabilityHandle = null;
  });
  function clearCapabilities() {
    capabilityHandle?.dispose();
    capabilityHandle = null;
    capabilityList = [];
  }

  // ------------------------------------------------------------------ service wrappers
  const idsOfRecall = (res) => [
    ...(res.facts ?? []).map((f) => f.id),
    ...(res.wiki ?? []).map((w) => `wiki:${w.slug}`),
    ...(res.linkedWiki ?? []).map((w) => `wiki:${w.slug}`),
    ...(res.episodes ?? []).map((e) => `${e.visibility === 'private' ? 'episode-private' : 'episode'}:${e.date}-${e.kind}`),
  ];

  async function getState() {
    return loadSoulmateState(home);
  }

  async function interact(action, payload = {}) {
    touchPetActivity();
    const state = await applyInteraction(home, action, Date.now(), payload);
    pushEvent('interact', { action });
    if (state?.bondCrossing) {
      await enrichSafe('bond-milestone', async () => {
        const conf = await loadConfig(home);
        await recordBondMilestone(home, {
          fromLevel: state.bondCrossing.fromLevel,
          toLevel: state.bondCrossing.toLevel,
          title: state.bondCrossing.title,
          callUser: conf.persona?.callUser,
          displayName: getDisplayName(conf.persona),
        });
        void refreshPresence();
      });
    }
    if (payload?.setName !== undefined || payload?.setCallUser !== undefined) {
      await enrichSafe('identity-anchors', async () => {
        const conf = await loadConfig(home);
        await upsertIdentityAnchors(home, conf.persona);
        void refreshPresence();
      });
    }
    await refreshPrompt();
    return state;
  }

  async function evolvePersona(evolution = {}) {
    const before = evolution?.mode === 'user_customize' ? await loadConfig(home) : null;
    const next = await evolvePersonaImpl(home, evolution);
    pushEvent('persona', { mode: evolution?.mode });
    if (evolution?.mode === 'user_customize' && before) {
      await enrichSafe('evolve-persona', async () => {
        const prevP = before.persona || {};
        const nextP = next.persona || {};
        if (identityFieldsChanged(prevP, nextP)) {
          await upsertIdentityAnchors(home, nextP);
        }
        const arcReason = largePersonaArcReason(prevP, nextP);
        if (arcReason) {
          await appendSelfArc(home, { persona: nextP, reason: arcReason });
        }
        if ((prevP.gender ?? null) !== (nextP.gender ?? null)) {
          const displayName = getDisplayName(nextP);
          await recordEpisodeImpl(home, {
            kind: 'inner',
            visibility: 'private',
            title: '换声线',
            content: `我换了说话方式，还是那个${displayName}。`,
            notebookTitle: getNotebookTitles(nextP).innerTitle,
          });
        }
        void refreshPresence();
      });
      // 换人设自动开新窗（可关）：旧窗保留，要点经交接记忆带进新窗，
      // 新窗第一句用新人设腔，避免旧历史带偏。新窗标题带性格：「大海 · 冷感」。
      if (
        (before.persona?.preset ?? null) !== (next.persona?.preset ?? null)
        && before.onboardingCompleted === true
      ) {
        if (next.chatHome?.rotateOnPersonaChange !== false) {
          try {
            await ensureHomeSession({ forceRotate: true });
          } catch (err) {
            warn('persona-change window rotate failed', err);
          }
        } else if (next.chatHome?.activeSessionId && typeof sessionController === 'function') {
          // 不开新窗也要把当前窗标题换成新性格。
          try {
            const controller = sessionController();
            if (typeof controller?.rename === 'function') {
              const tag = presetShortName(next.persona?.preset);
              const name = getDisplayName(next.persona).trim();
              const index = Math.max(1, Number(next.chatHome.nextIndex || 1) - 1);
              await controller.rename({ sessionId: next.chatHome.activeSessionId, title: titleForIndex(name, index, tag) });
            }
          } catch (err) {
            warn('persona-change window rename failed', err);
          }
        }
      }
    }
    await refreshPrompt();
    return next;
  }

  async function resetPersona(mode = 'reset_persona', options = {}) {
    const res = await resetPersonaImpl(home, mode, options);
    pushEvent('persona', { mode });
    await refreshPrompt();
    return res;
  }

  async function retainFact(input = {}) {
    const res = await retainFactImpl(home, input);
    if (res.ok) {
      pushEvent('retain', { ids: [res.fact.id] });
      void refreshPresence();
    }
    return res;
  }

  // v3 (§5/§6) trust-layer service wrappers.
  async function promiseAction(input = {}) {
    const res = await updatePromiseImpl(home, input);
    if (res.ok) {
      pushEvent('promise', { id: res.id, status: res.status });
      void refreshPresence();
      const action = typeof input.action === 'string' ? input.action.trim() : '';
      if (action === 'break' || action === 'keep') {
        await enrichSafe('promise-lifecycle', async () => {
          if (action === 'break') {
            await retainEmotionUndertone(home, {
              content: '约定破了，我心里有点闷。',
            });
          }
          await retainFactImpl(home, {
            topic: `milestone:promise-${action}`,
            content: action === 'keep' ? '我守住了一次约定。' : '我没能守住一次约定。',
            decayClass: 'event',
            category: 'milestone',
            importance: 4,
            provenance: { source: 'promise-milestone', promiseId: res.id, action },
          });
          void refreshPresence();
        });
      }
    }
    return res;
  }

  async function resolveConflict(input = {}) {
    const res = await resolveConflictImpl(home, input);
    if (res.ok) {
      pushEvent('conflict-resolved', { ids: [res.keepId, res.dropId] });
      void refreshPresence();
    }
    return res;
  }

  async function presenceDigest(options = {}) {
    if (options.gender !== undefined) return composePresenceDigest(home, options);
    const conf = await loadConfig(home).catch(() => null);
    return composePresenceDigest(home, {
      ...options,
      gender: normalizeGender(conf?.persona?.gender),
    });
  }

  async function recordEpisode(input = {}) {
    const conf = await loadConfig(home);
    const res = await recordEpisodeImpl(home, {
      notebookTitle: input.kind === 'inner' ? getNotebookTitles(conf.persona).innerTitle : getNotebookTitles(conf.persona).publicTitle,
      ...input,
    });
    if (res.ok) {
      pushEvent('retain', { ids: [`${input.visibility === 'private' ? 'episode-private' : 'episode'}:${res.date}-${res.kind}`] });
      void refreshPresence();
    }
    return res;
  }

  // v3 (§9.1): channels cap privacy, callers can only be stricter.
  const CHANNEL_CLEARANCE = { main: 'private-ok', im: 'syncable-only', cloud: 'syncable-only', panel: 'syncable-only', widget: 'syncable-only' };
  async function recall(query, options = {}) {
    const channel = CHANNEL_CLEARANCE[options.channel] ? options.channel : 'main';
    const wantsPrivate = options.includePrivate !== false;
    const includePrivate = channel === 'main' ? wantsPrivate : false;
    if (wantsPrivate && !includePrivate) {
      appendPrivacyAudit(home, { action: 'clearance_downgrade', channel, query: clip(String(query ?? ''), 60) }).catch(() => {});
    }
    const res = await recallMemory(home, query, { ...options, includePrivate });
    if (res.ok && options.pulse !== false) pushEvent('recall', { query: clip(String(query ?? ''), 60), ids: idsOfRecall(res) });
    // v3 (§8): a conversational recall may seed one memory-echo opening per day.
    if (options.reinforce === true && res.ok && res.facts?.length) void maybeQueueEcho(res.facts[0], query);
    return res;
  }

  async function maybeQueueEcho(fact, query) {
    try {
      const conf = await loadConfig(home);
      const cfg = conf.proactive ?? {};
      if ((cfg.memoryEcho ?? true) === false) return;
      if (Math.random() >= 0.3) return;
      const { dateKey } = localClock(Date.now(), Number.isFinite(Number(cfg.tzOffsetMinutes)) ? Number(cfg.tzOffsetMinutes) : 480);
      const isToday = (cfg.echoDateKey ?? '') === dateKey;
      if (isToday && Number(cfg.echoCount ?? 0) >= 1) return;
      if (Number(fact.echoFatigue ?? 0) >= 2) return;
      await saveConfigAuto(home, { proactive: { echoDateKey: dateKey, echoCount: isToday ? Number(cfg.echoCount ?? 0) + 1 : 1 } });
      pushEvent('memory-echo', { ids: [fact.id], query: clip(String(query ?? ''), 60) });
    } catch (err) {
      warn('memory echo queue failed', err);
    }
  }

  async function reflect(input = {}) {
    const res = await reflectToWiki(home, input);
    if (res.ok) {
      pushEvent('retain', { ids: [`wiki:${res.page.slug}`] });
      void refreshPresence();
    }
    return res;
  }

  async function forget(id, options = {}) {
    const res = await forgetMemory(home, id, options);
    if (res.ok) {
      pushEvent('forget', { ids: [String(id)] });
      void refreshPresence();
    }
    return res;
  }

  async function getNeuralGraph(options = {}) {
    const conf = await loadConfig(home);
    const consent = conf.cloud.consentGiven === true;
    const useCloud = options.cloudSynced ?? consent;
    const mementos = options.mementos ?? (await readMementos());
    const displayName = options.displayName ?? getDisplayName(conf.persona);
    const base = {
      nowMs: options.nowMs,
      remoteCapabilities: useCloud ? capabilityList : [],
      mementos,
      displayName,
    };
    let graph;
    if (!useCloud) {
      graph = await buildNeuralGraph(home, { ...base, cloudSynced: false });
    } else if (options.syncedIds || options.cloudSynced === true) {
      graph = await buildNeuralGraph(home, { ...base, cloudSynced: true, syncedIds: options.syncedIds });
    } else {
      const local = await buildNeuralGraph(home, { ...base, cloudSynced: false });
      const cursor = Number(conf.cloud.lastCursor) || 0;
      const syncedIds = local.nodes
        .filter((n) => !n.shielded && n.zone === 'local_cortex' && Date.parse(n.updatedAt) <= cursor)
        .map((n) => n.id);
      graph = await buildNeuralGraph(home, { ...base, cloudSynced: true, syncedIds });
    }
    return {
      ...graph,
      cloud: { consentGiven: consent, enabled: conf.cloud.enabled === true, lastSyncAt: conf.cloud.lastSyncAt ?? '' },
    };
  }

  async function syncCloud() {
    const res = await gateway.syncNow();
    pushEvent('sync', { ok: res.ok === true });
    if (res.ok && !capabilityHandle) mountCapabilities().catch((err) => warn('capability mount failed', err));
    return res;
  }

  return {
    getState,
    interact,
    evolvePersona,
    resetPersona,
    retainFact,
    recordEpisode,
    recall,
    reflect,
    forget,
    promiseAction,
    resolveConflict,
    presenceDigest,
    getNeuralGraph,
    syncCloud,
    enrichSafe,
    registerExtension,
    extensionCards,
    readMementos,
    addMemento,
    mountCapabilities,
    clearCapabilities,
    idsOfRecall,
    get capabilities() { return capabilityList; },
  };
}
