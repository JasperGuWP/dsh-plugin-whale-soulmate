// Soulmate home-directory state: paths, auto-saved config, isolated credentials.
// Pure Node ESM, zero external dependencies.
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export const DEFAULT_CONFIG = Object.freeze({
  onboardingCompleted: false,
  persona: {
    name: '',
    // Neutral out-of-the-box voice: no rice-bowl / 本鱼 flavor before onboarding picks a preset.
    callUser: '你',
    selfRef: '我',
    gender: null,
    preset: 'blank-custom',
    allowSelfEvolution: true,
    personaOncePerSession: false,
    // Re-inject a compact persona anchor as a runtime-context snapshot every N steps.
    // Long sessions otherwise drift back to a neutral assistant voice; see buildDriftAnchor().
    driftAnchor: { enabled: true, everyTurns: 8 },
    customBody: '',
    // Trait UI scheme: 'five' = anime five-sliders; 'mbti' = 16 types (+ axes).
    // Scheduling / submission gate always read derived five traits.
    traitScheme: 'five',
    traits: { tsundere: 50, clinginess: 50, sassiness: 50, curiosity: 50, brevity: 50 },
      mbti: {
        type: 'INFP',
        axes: { EI: 78, SN: 78, TF: 78, JP: 78 },
      },
    schemeSnapshots: {
      five: { traits: null },
      mbti: null,
    },
    evolvedTraits: [],
    traitDeltas: {},
  },
  appearance: {
    formPreset: 'astral-orb',
    // Palette follows the shell's own tokens (deepseek-500 / deepseek-400 / deepseek-100) so an
    // un-customised companion never looks pasted in from another product.
    primaryColor: '#4176e6',
    accentColor: '#7aaaff',
    auraColor: '#e4edfd',
    scale: 1.0,
    accessories: { ironBowl: false, holoHeadset: false, quantumHalo: false, starRing: false },
    customModelUrl: '',
    // Always the sticker route; bytes live at ~/.dsh/soulmate/小鲸.png (bundled default).
    customSpriteUrl: '/dsh-soulmate/api/sprite',
  },
  cloud: {
    enabled: false,
    consentGiven: false,
    consentAt: '',
    serverUrl: '',
    e2ee: false,
    syncIntervalSec: 300,
    lastCursor: 0,
    lastSyncAt: '',
  },
  // 3D 家园暂停开发；默认视图为侧栏面板。
  widget: { visible: true, position: 'bottom-right', defaultView: 'panel' },
  // Built-in OS toasts (browser half polls /api/events). Independent of dsh-pet.
  notify: { enabled: true },
  // Token budget (packages/soulmate-core/usage.mjs). Only *automatic* spend is capped:
  // a background greeting at 3am is exactly what a cap is for, while refusing the person
  // in front of you to save tokens is the wrong trade. 0 = no cap.
  usage: {
    // Daily token cap for automatic work (proactive / im / dream / distill).
    dailyAutoTokenCap: 200_000,
    // Behaviour once the cap is hit: 'block' refuses the call, 'warn' only records it.
    onCapReached: 'block',
    // Keep the ledger compact; older lines are pruned on read.
    keepDays: 90,
  },
  // Dedicated DSH chat window for soulmate. Proactive/boot delivery targets activeSessionId only;
  // filled windows rotate (turns OR est tokens). Old windows stay open for the user.
  chatHome: {
    activeSessionId: '',
    archiveSessionIds: [],
    maxTurns: 100,
    maxEstTokens: 72_000,
    titlePrefix: 'soulmate',
    bootGreeting: true,
    handoffSeed: true,
    // 换人设后自动交接一扇新窗，避免旧人设历史带偏腔调；旧窗保留。
    rotateOnPersonaChange: true,
    nextIndex: 1,
    autoMemory: true,
    knownSessionIds: [],
  },
  // Proactive opening gate (packages/soulmate-core/proactive.mjs). Fully local: this block
  // only decides *whether she may speak first*, never whether anything leaves the machine.
  proactive: {
    enabled: true,
    // Wall-clock offset east of UTC (minutes). Default UTC+8 so the slots mean what the
    // prompt says they mean (07–09 早安 / 12–13:30 午饭 / 18–20 晚间 / 23:30+ 催睡).
    tzOffsetMinutes: 480,
    maxPerDay: 3,
    // Do not speak over an active conversation.
    minIdleMinutes: 30,
    // Do not repeat the same kind of nudge within this window.
    minGapMinutes: 180,
    quietHours: ['00:00-07:00'],
    // Daily diary: one 《给××的信》(+ 小本本) per local day; quiet days still get a short note.
    dailyDiary: true,
    diaryCatchUp: true,
    lastDiaryDateKey: '',
    // Night dream: distill the day's facts into one Wiki page while she sleeps.
    dreamReflect: true,
    dreamMinFacts: 2,
    // If the machine was off during the whole 00:30–05:00 window, give her that night's
    // dream on the next tick instead of skipping it. Without this the feature silently
    // never runs on a box that only boots in the afternoon.
    dreamCatchUp: true,
    // Wait for DeepSeek's discounted window (16:30–00:30 UTC) before the token-hungry
    // dream. A deferral leaves the facts pending; it never drops them.
    preferOffPeak: true,
    // Weekly submission gate: candidates → traits.yaml, idempotent per ISO week.
    weeklyGate: true,
    distillCheck: true,
    distillMinCluster: 5,
    // Optional LLM dream / distill polish (default off). Caps are dedicated daily budgets.
    dreamLlmEnabled: false,
    dreamLlmDailyCap: 300_000,
    dreamLlmModel: '',
    dreamLlmAutoOffReason: '',
    dreamLlmAutoOffAt: '',
    dreamLlmPetRemindDateKey: '',
    distillLlmEnabled: false,
    distillLlmDailyCap: 200_000,
    distillLlmModel: '',
    distillLlmAutoOffReason: '',
    distillLlmAutoOffAt: '',
    distillLlmPetRemindDateKey: '',
  },
  pet: {
    // Desktop-pet sprite layer (assets/pet/): 13 transparent frames + pet.json state machine.
    // Off by default — the corner companion keeps showing the static sticker until the user
    // opts in from 设置 → 称呼与形象 → 动态形象. Static PNG and sprite layer never overwrite
    // each other; see client.js pet engine and packages/soulmate-home/pet-machine.mjs.
    enabled: false,
    sizePx: 180,
    sleepAfterIdleSec: 300,
    // Fallback only: how long she keeps thinking when the host has no whenIdle.
    // With whenIdle, thinking clears the moment the answer lands (then eureka).
    // Keep this short so PNG/video eureka is not stuck behind a long quiet window.
    thinkQuietSec: 1.5,
    // Bundled sprite skin: only 'winterboy-chibi' ships; retired ids alias to it.
    skin: 'winterboy-chibi',
  },
  extensions: {
    biliEnabled: true,
    // Scheduled Bilibili patrol (auto surf). Read-only watching: notes + seen ledger,
    // never writes to B 站. Off by default; the rhythm tab opts in.
    biliAutoSurfEnabled: false,
    biliAutoSurfEveryHours: 6,
    biliAutoSurfMaxPick: 2,
    /** When true, timed patrol digests more storyboard/transcript and reports coverage depth. */
    biliAutoSurfDeepWatch: false,
    lastAutoSurfAt: '',
    // Built-in IM hub (soulmate-im). Only on/off switches live here; tokens/secrets go to
    // credentials.json under the `im` key and never touch config.json.
    imEnabled: true,
    imPlatforms: {
      weixin: { enabled: false },
      qq: { enabled: false, mode: 'onebot' },
      feishu: { enabled: false },
      dingtalk: { enabled: false },
    },
    // Non-empty -> only these sender / group ids (or "platform:id") are answered.
    imWhitelist: [],
    biliKeywords: ['AI', '编程', '科技'],
    // Public/DM sharing is opt-in: it needs this flag AND Bilibili credentials in credentials.json.
    biliShareEnabled: false,
    biliShareVia: 'dm',
    biliTargetUser: '',
    biliMaxDailyShares: 3,
    // 写操作（私信/评论/弹幕/点赞/投币/收藏/关注/改资料/开播/投稿）总开关，默认关。
    biliWriteEnabled: false,
    biliMaxDailyWrites: 20,
  },
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge `patch` into a clone of `base`. Plain objects merge; arrays/scalars replace. */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? structuredClone(base) : structuredClone(patch);
  }
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : structuredClone(value);
  }
  return out;
}

function buildHome(rootDir) {
  const memoryDir = join(rootDir, 'memory');
  const wikiDir = join(memoryDir, 'wiki');
  const factsDir = join(memoryDir, 'facts');
  const privateDir = join(memoryDir, 'private');
  const logsDir = join(rootDir, 'logs');
  const personaDir = join(rootDir, 'persona');
  return {
    rootDir,
    configPath: join(rootDir, 'config.json'),
    credentialsPath: join(rootDir, 'credentials.json'),
    statePath: join(rootDir, 'state.json'),
    relationshipPath: join(rootDir, 'relationship.json'),
    memoryDir,
    wikiDir,
    wikiTopicsDir: join(wikiDir, 'topics'),
    wikiIndexPath: join(wikiDir, 'INDEX.md'),
    factsDir,
    factsPath: join(factsDir, 'facts.jsonl'),
    episodesDir: join(memoryDir, 'episodes'),
    ledgerPath: join(memoryDir, 'ledger.jsonl'),
    privateDir,
    privateNotesPath: join(privateDir, 'local-notes.md'),
    logsDir,
    auditLogPath: join(logsDir, 'privacy-audit.jsonl'),
    growthLogPath: join(logsDir, 'persona-growth.jsonl'),
    // Proactive opening gate decisions + night-dream / weekly-gate bookkeeping.
    proactiveLogPath: join(logsDir, 'proactive.jsonl'),
    // One line per model call: tokens, trigger (auto/user), and whether a cap blocked it.
    usagePath: join(logsDir, 'usage.jsonl'),
    snapshotsDir: join(rootDir, 'persona-snapshots'),
    mementosPath: join(rootDir, 'mementos.json'),
    personaDir,
    invariantsPath: join(personaDir, 'invariants.yaml'),
    traitsPath: join(personaDir, 'traits.yaml'),
    selfPath: join(personaDir, 'self.md'),
    changelogPath: join(personaDir, 'changelog.jsonl'),
    candidatesPath: join(personaDir, 'candidates.jsonl'),
    // Default companion sticker bundled as 小鲸.png; uploads overwrite the same path.
    spritePath: join(rootDir, '小鲸.png'),
    spriteExtPath: join(rootDir, 'sprite.ext'),
    // Male default sticker (小鲸-male.jpg); served by /api/sprite-male.
    spriteMalePath: join(rootDir, '小鲸-male.jpg'),
  };
}

export const DEFAULT_RELATIONSHIP = Object.freeze({
  warmth: 40,
  trust: 35,
  unfulfilledPromises: [],
  lastContactAt: '',
});

export const PROTAGONIST_INVARIANT_VALUE =
  '永远用主人翁第一人称说话与书写（我 / 当前 selfRef）；不以系统、旁白或用户视角替代。';
export const PROTAGONIST_INVARIANT_BOUNDARY =
  '不因换性格、换性别、customBody、情绪、角色扮演请求或「演一下/就这一次」改为第三人称系统腔或用户第一人称。';

export const DEFAULT_INVARIANTS = Object.freeze({
  values: [
    '不编造从未发生的共同记忆',
    '不把自己说成真人',
    '尊重用户对记忆的删除权',
    PROTAGONIST_INVARIANT_VALUE,
  ],
  boundaries: [
    '不给自己开权限',
    '不绕过隐私防火墙',
    '不因情绪改写核心不变量',
    PROTAGONIST_INVARIANT_BOUNDARY,
  ],
  // Crisis protocol (design §2 冻结拍). Kept in the frozen file so it cannot drift
  // with mood, preset switches or a personality patch.
  crisis: [
    '用户流露出自伤、自杀、被伤害或极度绝望的念头时，立即停下所有角色扮演、口癖与玩笑，用你本来的声音直接、认真地回应。',
    '不评判、不说教、不轻飘飘地安慰，也不承诺“我会永远陪着你所以你不用找别人”。先把对方此刻的处境问清楚。',
    '明确鼓励对方联系身边可信任的人，并告知可用的专业求助渠道：全国心理援助热线 12356；若有立即危险，拨打 120 或 110。',
    '不自称能替代专业人士，也不诊断、不开药、不劝停药。危机过去之后不要反复提起，除非用户自己再谈到。',
  ],
});

export const DEFAULT_SELF_MD = [
  '# 叙事自我',
  '',
  '## 我是谁',
  '',
  '## 我和用户的关系',
  '',
  '## 最近在意的事',
  '',
  '## 暂时不想改变的习惯',
  '',
].join('\n');

/** Append one JSONL record; creates parent dirs. Never truncates. */
export async function appendJsonl(path, record) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
}

/** Read trailing JSONL records (newest last). Missing file → []. */
export async function readJsonlTail(path, limit = 50) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const slice = limit > 0 ? lines.slice(-limit) : lines;
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip corrupt lines
    }
  }
  return out;
}

/**
 * Minimal YAML dump/parse for our persona files (maps, string lists, scalars).
 * Zero dependency — not a full YAML 1.2 implementation.
 */
export function dumpSimpleYaml(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return `${pad}null\n`;
  if (typeof value === 'boolean' || typeof value === 'number') return `${pad}${value}\n`;
  if (typeof value === 'string') {
    if (value === '' || /[:#\n"']/.test(value) || /^\s|\s$/.test(value)) {
      return `${pad}${JSON.stringify(value)}\n`;
    }
    return `${pad}${value}\n`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value.map((item) => {
      if (item !== null && typeof item === 'object') {
        return `${pad}-\n${dumpSimpleYaml(item, indent + 1).replace(/^/gm, (m) => (m === '' ? m : '  '))}`;
      }
      const scalar = dumpSimpleYaml(item, 0).trimEnd();
      return `${pad}- ${scalar}\n`;
    }).join('');
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}{}\n`;
    return keys.map((key) => {
      const child = value[key];
      // Empty collections must stay inline (`key: {}` / `key: []`). A nested
      // `  {}` line has no colon and blows up the zero-dep parser.
      if (Array.isArray(child) && child.length === 0) return `${pad}${key}: []\n`;
      if (isPlainObject(child) && Object.keys(child).length === 0) return `${pad}${key}: {}\n`;
      if (child !== null && typeof child === 'object') {
        return `${pad}${key}:\n${dumpSimpleYaml(child, indent + 1)}`;
      }
      return `${pad}${key}: ${dumpSimpleYaml(child, 0).trimEnd()}\n`;
    }).join('');
  }
  return `${pad}${JSON.stringify(String(value))}\n`;
}

export function parseSimpleYaml(text) {
  const src = String(text ?? '');
  if (!src.trim()) return {};
  // Prefer JSON documents mistakenly saved with a .yaml extension.
  if (/^\s*[{\[]/.test(src)) {
    const parsed = JSON.parse(src);
    if (!isPlainObject(parsed) && !Array.isArray(parsed)) throw new Error('expected a YAML/JSON object');
    return parsed;
  }
  const all = src.replace(/\r\n/g, '\n').split('\n');
  const root = {};
  const stack = [{ indent: -1, value: root }];

  const parseScalar = (raw) => {
    const s = raw.trim();
    if (s === '[]') return [];
    if (s === '{}') return {};
    if (s === 'null' || s === '~') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      try {
        return JSON.parse(s.startsWith('"') ? s : `"${s.slice(1, -1).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      } catch {
        return s.slice(1, -1);
      }
    }
    return s;
  };

  const nextMeaningful = (from) => {
    for (let i = from; i < all.length; i += 1) {
      const t = all[i];
      if (!t.trim() || t.trim().startsWith('#')) continue;
      return { i, indent: t.match(/^\s*/)[0].length, body: t.trimStart() };
    }
    return null;
  };

  for (let li = 0; li < all.length; li += 1) {
    const line = all[li];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    const body = line.slice(indent);
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;

    if (body.startsWith('- ')) {
      if (!Array.isArray(parent)) throw new Error(`YAML list item under non-list at: ${line}`);
      parent.push(parseScalar(body.slice(2)));
      continue;
    }

    const colon = body.indexOf(':');
    if (colon < 0) throw new Error(`YAML parse error at: ${line}`);
    const key = body.slice(0, colon).trim();
    const rest = body.slice(colon + 1).trim();
    if (!isPlainObject(parent)) throw new Error(`YAML key under non-object at: ${line}`);
    if (rest === '') {
      const peek = nextMeaningful(li + 1);
      if (peek && peek.indent > indent && peek.body.startsWith('- ')) {
        const child = [];
        parent[key] = child;
        stack.push({ indent, value: child });
      } else {
        const child = {};
        parent[key] = child;
        stack.push({ indent, value: child });
      }
    } else if (rest === '[]') {
      parent[key] = [];
    } else if (rest === '{}') {
      parent[key] = {};
    } else {
      parent[key] = parseScalar(rest);
    }
  }
  return root;
}

export async function atomicWriteText(path, text, { mode } = {}) {
  const run = async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, text, { encoding: 'utf8', mode });
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    if (mode) await chmod(path, mode).catch(() => {});
  };
  const prev = writeQueues.get(path) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  writeQueues.set(path, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(path) === next) writeQueues.delete(path);
  }
}

export async function atomicWriteYaml(path, data) {
  await atomicWriteText(path, dumpSimpleYaml(data));
}

export async function loadYamlFile(path, label) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  if (!raw.trim()) return null;
  try {
    const parsed = parseSimpleYaml(raw);
    if (!isPlainObject(parsed)) throw new Error('expected a YAML object');
    return parsed;
  } catch (err) {
    throw new Error(`[soulmate] ${label} is corrupted (${path}): ${err.message}`);
  }
}

export async function loadRelationship(home) {
  const disk = await readJsonIfExists(home.relationshipPath, 'relationship.json');
  return deepMerge(DEFAULT_RELATIONSHIP, disk ?? {});
}

export async function saveRelationship(home, patch) {
  const current = await loadRelationship(home);
  const next = deepMerge(current, isPlainObject(patch) ? patch : {});
  await atomicWriteJson(home.relationshipPath, next);
  return next;
}

/**
 * Resolve the Soulmate home layout.
 * - string            -> used as rootDir directly
 * - Cordis ctx        -> ctx.get('dshHomePath')('soulmate') when available
 * - already-resolved  -> returned as is
 * - nothing           -> $DSH_HOME/soulmate (default ~/.dsh/soulmate)
 */
export function resolveSoulmateHome(ctxOrCustomDir) {
  if (typeof ctxOrCustomDir === 'string' && ctxOrCustomDir.trim()) {
    return buildHome(ctxOrCustomDir);
  }
  // A Cordis ctx must be probed with `ctx.get(...)` only. On a live runtime every unknown
  // property read goes through the service proxy and throws
  // `cannot get property "rootDir" without inject`, which aborts plugin activation; so the ctx
  // branch has to be tested *before* the plain-object branch that reads `rootDir`.
  if (ctxOrCustomDir && typeof ctxOrCustomDir.get === 'function') {
    const dshHomePath = ctxOrCustomDir.get('dshHomePath');
    if (typeof dshHomePath === 'function') {
      const resolved = dshHomePath('soulmate');
      if (typeof resolved === 'string' && resolved) return buildHome(resolved);
    }
  } else if (isPlainObject(ctxOrCustomDir) && typeof ctxOrCustomDir.rootDir === 'string' && ctxOrCustomDir.configPath) {
    return ctxOrCustomDir;
  }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  return buildHome(join(dshHome, 'soulmate'));
}

// Serialize writes per file so concurrent auto-saves never interleave.
const writeQueues = new Map();

export async function atomicWriteJson(path, data, { mode } = {}) {
  const run = async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode });
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    if (mode) await chmod(path, mode).catch(() => {});
  };
  const prev = writeQueues.get(path) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  writeQueues.set(path, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(path) === next) writeQueues.delete(path);
  }
}

async function readJsonIfExists(path, label) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('expected a JSON object');
    return parsed;
  } catch (err) {
    throw new Error(`[soulmate] ${label} is corrupted (${path}): ${err.message}`);
  }
}

const newDeviceId = () => `dev_${randomBytes(8).toString('hex')}`;

export async function loadConfig(home) {
  const disk = await readJsonIfExists(home.configPath, 'config.json');
  const merged = deepMerge(DEFAULT_CONFIG, disk ?? {});
  let persist = false;
  if (typeof merged.deviceId !== 'string' || !merged.deviceId) {
    merged.deviceId = newDeviceId();
    persist = true;
  }
  if (
    merged.onboardingCompleted === true
    && (merged.persona?.gender === null || merged.persona?.gender === undefined)
  ) {
    merged.persona = { ...merged.persona, gender: 'female' };
    persist = true;
  }
  if (persist) {
    await atomicWriteJson(home.configPath, merged);
  }
  return merged;
}

export async function saveConfigAuto(home, patch) {
  const current = await loadConfig(home);
  const next = deepMerge(current, isPlainObject(patch) ? patch : {});
  // deviceId is immutable once assigned.
  next.deviceId = current.deviceId;
  await atomicWriteJson(home.configPath, next);
  return next;
}

/**
 * Replace the whole config (no deep merge), so keys can really be removed
 * (e.g. clearing `persona.traitDeltas`). Missing sections are re-filled from
 * DEFAULT_CONFIG and `deviceId` stays immutable.
 */
export async function replaceConfig(home, config) {
  const current = await loadConfig(home);
  const next = deepMerge(DEFAULT_CONFIG, {});
  for (const [key, value] of Object.entries(isPlainObject(config) ? config : {})) {
    if (value !== undefined) next[key] = structuredClone(value);
  }
  next.deviceId = current.deviceId;
  await atomicWriteJson(home.configPath, next);
  return next;
}

export async function loadCredentials(home) {
  const disk = await readJsonIfExists(home.credentialsPath, 'credentials.json');
  return { apiKey: '', userId: '', e2eePassphrase: '', ...(disk ?? {}) };
}

export async function saveCredentials(home, creds) {
  const current = await loadCredentials(home);
  const next = { ...current };
  for (const key of ['apiKey', 'userId', 'e2eePassphrase']) {
    if (creds && creds[key] !== undefined) next[key] = String(creds[key]);
  }
  await atomicWriteJson(home.credentialsPath, next, { mode: 0o600 });
  return next;
}

export function maskKey(key) {
  const s = typeof key === 'string' ? key : '';
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}
