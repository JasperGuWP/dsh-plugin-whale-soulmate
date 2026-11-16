// One-shot home bootstrap: persona schema files, bundled default sprites, legacy
// memory migration, events-index backfill, then warm the persona prompt cache.
// Every step degrades to a warning — a broken sprite must never block the plugin.

import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadConfig, saveConfigAuto } from '../state.mjs';
import { BUNDLED_SPRITE, BUNDLED_SPRITE_MALE, DEFAULT_SPRITE_URL } from '../assets.mjs';
import {
  autoResolveNoiseConflicts,
  backfillEventsIndex,
  migrateFactsToContract,
} from '../memory-engine.mjs';
import { migrateLegacyDisplayName } from '../memory-enrichment.mjs';
import { ensurePersonaFiles } from '../layers/index.mjs';

export async function ensureDefaultSprite(home) {
  await mkdir(dirname(home.spritePath), { recursive: true });
  // 默认形象 = 随包 Q版 idle PNG（GET /api/sprite 直读包内文件）。
  // sprite.ext 只在用户上传图片时存在，是「有自定义图」的唯一标记。
  let hasCustom = false;
  try {
    await access(home.spriteExtPath);
    await access(home.spritePath);
    hasCustom = true;
  } catch {
    // 旧版曾把全身立绘拷进 小鲸.png 当默认；没有 ext 标记的一律清掉换 Q版。
    await rm(home.spritePath, { force: true });
    await rm(home.spriteExtPath, { force: true });
    const legacy = join(home.rootDir, 'sprite.img');
    try {
      await access(legacy);
      await copyFile(legacy, home.spritePath);
      await writeFile(home.spriteExtPath, 'png');
      hasCustom = true;
    } catch { /* no legacy custom upload */ }
  }
  // 0.2.83：旧默认（小鲸.png / 小鲸-male.jpg 全身立绘）一次性换成包内 Q版 PNG；
  // 用户自己上传过的图（字节与随包默认不同）原样保留。
  if (hasCustom) {
    try {
      const [cur, bundled, bundledMale] = await Promise.all([
        readFile(home.spritePath),
        readFile(BUNDLED_SPRITE).catch(() => null),
        readFile(BUNDLED_SPRITE_MALE).catch(() => null),
      ]);
      if ((bundled && cur.equals(bundled)) || (bundledMale && cur.equals(bundledMale))) {
        await rm(home.spritePath, { force: true });
        await rm(home.spriteExtPath, { force: true });
        hasCustom = false;
      }
    } catch { /* keep whatever is on disk */ }
  }
  const conf = await loadConfig(home);
  const url = conf.appearance?.customSpriteUrl;
  if (!url || url.includes('sprite.img') || url === '') {
    await saveConfigAuto(home, { appearance: { customSpriteUrl: DEFAULT_SPRITE_URL } });
  }
  return hasCustom;
}

export async function ensureDefaultSpriteMale(home) {
  // 男默认同样走包内 Q版 PNG；旧全身 JPG 拷贝直接移除。
  await rm(home.spriteMalePath, { force: true });
}

/** Returns the ready promise every route / tool waits on before touching the home dir. */
export function bootstrapHome({ home, warn, refreshPrompt }) {
  return ensurePersonaFiles(home)
    .catch((err) => warn('persona file bootstrap failed', err))
    .then(() => ensureDefaultSprite(home))
    .catch((err) => warn('default sprite bootstrap failed', err))
    .then(() => ensureDefaultSpriteMale(home))
    .catch((err) => warn('default male sprite bootstrap failed', err))
    // One-shot memory rewrite into the §5 contract (kind/text/t/salience/confidence/evidence).
    .then(() => migrateFactsToContract(home))
    .then((res) => {
      if (res?.rewritten) warn(`memory contract: rewrote ${res.rewritten} legacy fact row(s)`);
    })
    .catch((err) => warn('memory contract migration failed', err))
    // v3 (§1.1): one-shot mirror of pre-existing diaries into events.jsonl.
    .then(() => backfillEventsIndex(home))
    .then((res) => {
      if (res?.backfilled) warn(`events index: backfilled ${res.events} episode row(s)`);
    })
    .catch((err) => warn('events index backfill failed', err))
    // 0.2.35: purge the legacy「大肥鱼」shorthand from memory rows / wiki titles / window prefix.
    .then(async () => {
      const conf = await loadConfig(home);
      const res = await migrateLegacyDisplayName(home, conf.persona);
      if (str(conf.chatHome?.titlePrefix).includes('大肥鱼')) {
        const name = str(conf.persona?.name).trim() || 'soulmate';
        await saveConfigAuto(home, { chatHome: { titlePrefix: name } });
        res.config = 1;
      }
      if (res.facts || res.wiki || res.config) {
        warn(`legacy rename: facts=${res.facts} wiki=${res.wiki} config=${res.config}`);
      }
    })
    .catch((err) => warn('legacy display-name migration failed', err))
    // Auto-clear handoff / system-noise conflicts left open for the user.
    .then(() => autoResolveNoiseConflicts(home))
    .then((res) => {
      if (res?.resolved) warn(`noise conflicts auto-resolved: ${res.resolved}`);
    })
    .catch((err) => warn('noise conflict auto-resolve failed', err))
    .then(() => refreshPrompt());
}

const str = (v) => (v == null ? '' : String(v));
