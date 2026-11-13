// The panel / tool summary projection (/api/state, interact & evolve tool output).
// Pure read-side composition: config + credentials + state + engine snapshot.

import { deepMerge, loadConfig, loadCredentials, maskKey } from '../state.mjs';
import {
  AVATAR_FORMS,
  MBTI_TYPES,
  MBTI_BLURBS,
  PRESETS,
  TRAIT_KEYS,
  computeBondStage,
  getDisplayName,
  getEffectiveTraits,
  getNotebookTitles,
  loadSoulmateState,
} from '../persona.mjs';
import { getEngineSnapshot } from '../layers/index.mjs';

export function createSummaryProvider({ home, warn, promptEngine, memory, eventSeq }) {
  const { readMementos, extensionCards } = memory;

  return async function getSummary() {
    const [conf, creds, state, mementos, engine] = await Promise.all([
      loadConfig(home),
      loadCredentials(home),
      loadSoulmateState(home),
      readMementos(),
      getEngineSnapshot(home, Date.now(), { promptText: promptEngine.promptText }).catch((err) => {
        warn('engine snapshot failed', err);
        return null;
      }),
    ]);
    const publicConfig = deepMerge(conf, {
      cloud: { apiKeyMasked: maskKey(creds.apiKey), hasKey: Boolean(creds.apiKey), hasPassphrase: Boolean(creds.e2eePassphrase) },
    });
    return {
      ok: true,
      config: publicConfig,
      state,
      bondStage: computeBondStage(state.affinity),
      notebooks: getNotebookTitles(conf.persona),
      displayName: getDisplayName(conf.persona),
      effectiveTraits: getEffectiveTraits(conf.persona),
      extensions: extensionCards(conf),
      petThinking: promptEngine.petThinking === true,
      petSay: promptEngine.petSay,
      petTurnPreview: promptEngine.petTurnPreview || '',
      petTurnPhase: promptEngine.petTurnPhase || 'idle',
      sessionId: promptEngine.sessionId || conf.chatHome?.activeSessionId || null,
      mementos: mementos.slice(-24),
      presets: Object.values(PRESETS).map((p) => ({
        id: p.id,
        gender: p.gender,
        emoji: p.emoji,
        name: p.name,
        title: p.title,
        description: p.description,
        catchphrases: Array.isArray(p.catchphrases) ? p.catchphrases : [],
        defaultSelfRef: p.defaultSelfRef,
        defaultCallUser: p.defaultCallUser,
        traits: p.traits,
      })),
      forms: Object.values(AVATAR_FORMS),
      traitKeys: TRAIT_KEYS,
      mbtiTypes: MBTI_TYPES,
      mbtiBlurbs: MBTI_BLURBS,
      eventSeq: eventSeq(),
      // Compact engine strip for the floating widget; full detail is GET /api/engine.
      engine: engine
        ? {
            warmth: engine.status?.relationship?.warmth,
            trust: engine.status?.relationship?.trust,
            initiative: engine.scheduling?.strategy?.initiative,
            silenceThresholdHours: engine.scheduling?.strategy?.silenceThresholdHours,
            candidatesPending: engine.persona?.candidatesPending ?? 0,
            time: engine.status?.time,
            memory: engine.status?.memory,
          }
        : undefined,
    };
  };
}
