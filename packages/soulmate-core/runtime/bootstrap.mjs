// One-shot home bootstrap: persona schema files, bundled default sprites, legacy
// memory migration, events-index backfill, then warm the persona prompt cache.
// Every step degrades to a warning — a broken sprite must never block the plugin.

import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadConfig, saveConfigAuto } from '../state.mjs';
import { BUNDLED_SPRITE, BUNDLED_SPRITE_MALE, DEFAULT_SPRITE_URL } from '../assets.mjs';
import { backfillEventsIndex, migrateFactsToContract } from '../memory-engine.mjs';
import { migrateLegacyDisplayName } from '../memory-enrichment.mjs';
import { ensurePersonaFiles } from '../layers/index.mjs';

export async function ensureDefaultSprite(home) {
  await mkdir(dirname(home.spritePath), { recursive: true });
  try {
    await access(home.spritePath);
  } catch {
    const legacy = join(home.rootDir, 'sprite.img');
    try {
      await access(legacy);
      await copyFile(legacy, home.spritePath);
    } catch {
      await copyFile(BUNDLED_SPRITE, home.spritePath);
    }
  }
  const conf = await loadConfig(home);
  const url = conf.appearance?.customSpriteUrl;
  if (!url || url.includes('sprite.img') || url === '') {
    await saveConfigAuto(home, { appearance: { customSpriteUrl: DEFAULT_SPRITE_URL } });
  }
}

export async function ensureDefaultSpriteMale(home) {
  await mkdir(dirname(home.spriteMalePath), { recursive: true });
  try {
    await access(home.spriteMalePath);
  } catch {
    await copyFile(BUNDLED_SPRITE_MALE, home.spriteMalePath);
  }
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
    .then(() => refreshPrompt());
}

const str = (v) => (v == null ? '' : String(v));
