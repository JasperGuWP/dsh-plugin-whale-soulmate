// Host-level plugin config validation + the panel's config-patch allow-list.
// Pure logic: a typo must fail loudly instead of silently becoming a default.

import { isObject } from './small-utils.mjs';

/** Validate plugin config loudly: a typo must not silently become a default. */
export function resolvePluginConfig(config) {
  const cfg = config === undefined || config === null ? {} : config;
  if (!isObject(cfg)) throw new Error('[soulmate] plugin config must be an object');
  const out = {
    homeDir: '',
    autoSync: true,
    syncIntervalSec: 300,
    proactive: true,
    proactiveIntervalSec: 120,
    imAutoPoll: true,
    fetch: undefined,
    ...cfg,
  };
  if (out.homeDir !== undefined && out.homeDir !== '' && typeof out.homeDir !== 'string') {
    throw new Error('[soulmate] config.homeDir must be a string');
  }
  if (typeof out.autoSync !== 'boolean') throw new Error('[soulmate] config.autoSync must be a boolean');
  if (!Number.isFinite(out.syncIntervalSec) || out.syncIntervalSec < 30) {
    throw new Error('[soulmate] config.syncIntervalSec must be a number >= 30');
  }
  // Host-level switch for the local scheduler. The on/off the *user* sees lives in
  // config.json `proactive.enabled`; this only lets an embedding host disable the timer.
  if (typeof out.proactive !== 'boolean') throw new Error('[soulmate] config.proactive must be a boolean');
  if (!Number.isFinite(out.proactiveIntervalSec) || out.proactiveIntervalSec < 30) {
    throw new Error('[soulmate] config.proactiveIntervalSec must be a number >= 30');
  }
  if (out.fetch !== undefined && typeof out.fetch !== 'function') throw new Error('[soulmate] config.fetch must be a function');
  if (out.biliFetch !== undefined && typeof out.biliFetch !== 'function') throw new Error('[soulmate] config.biliFetch must be a function');
  for (const key of ['biliBaseUrl', 'biliDmBaseUrl']) {
    if (out[key] !== undefined && typeof out[key] !== 'string') throw new Error(`[soulmate] config.${key} must be a string`);
  }
  for (const key of ['imFetch', 'imReplyGenerator']) {
    if (out[key] !== undefined && typeof out[key] !== 'function') throw new Error(`[soulmate] config.${key} must be a function`);
  }
  if (out.imAutoPoll !== undefined && typeof out.imAutoPoll !== 'boolean') throw new Error('[soulmate] config.imAutoPoll must be a boolean');
  if (out.imMemoryVisibility !== undefined && !['syncable', 'private'].includes(out.imMemoryVisibility)) {
    throw new Error('[soulmate] config.imMemoryVisibility must be "syncable" or "private"');
  }
  return out;
}

export const CONFIG_PATCH_KEYS = {
  onboardingCompleted: 'boolean',
  widget: { visible: 'boolean', position: 'string', defaultView: 'string' },
  notify: { enabled: 'boolean' },
  pet: {
    enabled: 'boolean', sizePx: 'number', sleepAfterIdleSec: 'number', thinkQuietSec: 'number', skin: 'string', skinAuto: 'boolean',
    physics: { gravity: 'number', restitution: 'number', groundFriction: 'number', throwPower: 'number' },
  },
  proactive: {
    enabled: 'boolean',
    tzOffsetMinutes: 'number',
    maxPerDay: 'number',
    minIdleMinutes: 'number',
    minGapMinutes: 'number',
    quietHours: 'array',
    dailyDiary: 'boolean',
    diaryCatchUp: 'boolean',
    dreamReflect: 'boolean',
    dreamMinFacts: 'number',
    dreamMinSalience: 'number',
    dreamCatchUp: 'boolean',
    distillCheck: 'boolean',
    distillMinCluster: 'number',
    preferOffPeak: 'boolean',
    weeklyGate: 'boolean',
    dreamLlmEnabled: 'boolean',
    dreamLlmDailyCap: 'number',
    dreamLlmModel: 'string',
    distillLlmEnabled: 'boolean',
    distillLlmDailyCap: 'number',
    distillLlmModel: 'string',
  },
  chatHome: {
    maxTurns: 'number',
    maxEstTokens: 'number',
    titlePrefix: 'string',
    bootGreeting: 'boolean',
    handoffSeed: 'boolean',
    rotateOnPersonaChange: 'boolean',
    autoMemory: 'boolean',
  },
  extensions: {
    biliEnabled: 'boolean',
    imEnabled: 'boolean',
    biliWriteEnabled: 'boolean',
    biliMaxDailyWrites: 'number',
    biliAutoSurfEnabled: 'boolean',
    biliAutoSurfEveryHours: 'number',
    biliAutoSurfMaxPick: 'number',
    biliAutoSurfDeepWatch: 'boolean',
    biliAutoSurfMaxAgeDays: 'number',
    biliKeywords: 'string-array',
  },
  usage: {
    dailyAutoTokenCap: 'number',
    onCapReached: 'string',
    keepDays: 'number',
  },
};

export const pickPatch = (input, spec) => {
  const out = {};
  for (const [key, rule] of Object.entries(spec)) {
    const value = input?.[key];
    if (value === undefined) continue;
    if (typeof rule === 'string') {
      // `array` is a rule kind, not a JS type: an array patch (e.g. quietHours) must be
      // copied by value so a caller cannot keep a handle on config through the request body.
      if (rule === 'array') {
        if (Array.isArray(value)) out[key] = value.filter((v) => typeof v === 'string');
      } else if (rule === 'string-array') {
        if (Array.isArray(value)) out[key] = value.map((v) => String(v).trim()).filter(Boolean);
      } else if (typeof value === rule) {
        out[key] = value;
      }
    } else if (isObject(value)) {
      const nested = pickPatch(value, rule);
      if (Object.keys(nested).length) out[key] = nested;
    }
  }
  return out;
};
