// Soul-share routes: export one .soulmate.md, preview (zero side effects), import with rollback.
import { loadConfig } from '../state.mjs';
import { restorePersonaSnapshot } from '../persona.mjs';
import { buildSoulShareMarkdown, parseSoulShareMarkdown, applySoulShare } from '../soul-share.mjs';
import { upsertIdentityAnchors } from '../memory-enrichment.mjs';
import { jsonOut } from '../http-plumbing.mjs';
import { errMsg } from '../small-utils.mjs';

export function soulShareRoutes({ home, memory, getSummary, refreshPresence, warn, runBootGreetingWithRetry }) {
  const { enrichSafe } = memory;
  return [
    {
      method: 'GET',
      paths: ['/dsh-soulmate/api/soul-share/export'],
      handler: async ({ query }) => {
        try {
          const includeWiki = query?.get('wiki') === '1';
          const res = await buildSoulShareMarkdown(home, { includeWiki });
          return jsonOut(200, res);
        } catch (err) {
          return jsonOut(400, { ok: false, error: errMsg(err) });
        }
      },
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/soul-share/preview'],
      handler: async ({ body }) => {
        const parsed = parseSoulShareMarkdown(body?.markdown);
        if (!parsed.ok) return jsonOut(400, parsed);
        const fm = parsed.parsed.frontmatter;
        return jsonOut(200, {
          ok: true,
          preview: {
            name: fm.name,
            gender: fm.gender,
            preset: fm.preset,
            traitScheme: fm.traitScheme,
            traits: fm.traits,
            mbti: fm.mbti,
            selfRef: fm.selfRef,
            callUser: fm.callUser,
            catchphrases: parsed.parsed.catchphrases,
            evolvedTraits: fm.evolvedTraits,
            wikiImpressions: parsed.parsed.wikiImpressions,
            welcome: parsed.parsed.welcome,
            exportedAt: parsed.parsed.exportedAt,
            customBodyChars: parsed.parsed.customBody.length,
          },
        });
      },
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/soul-share/import'],
      handler: async ({ body }) => {
        const parsed = parseSoulShareMarkdown(body?.markdown);
        if (!parsed.ok) return jsonOut(400, parsed);
        try {
          const res = await applySoulShare(home, parsed.parsed);
          if (!res.ok) return jsonOut(400, res);
          await enrichSafe('soul-share-import', async () => {
            const conf = await loadConfig(home);
            await upsertIdentityAnchors(home, conf.persona);
            void refreshPresence();
          });
          // One greeting in the imported voice; the welcome line guides it, never stored.
          if (res.welcome && typeof runBootGreetingWithRetry === 'function') {
            void runBootGreetingWithRetry({ force: true, delaysMs: [0, 4000] })
              .catch((err) => warn('soul-share import greeting failed', err));
          }
          return jsonOut(200, { ok: true, snapshotFile: res.snapshotFile, welcome: res.welcome, ...(await getSummary()) });
        } catch (err) {
          return jsonOut(400, { ok: false, error: errMsg(err) });
        }
      },
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/soul-share/undo'],
      handler: async ({ body }) => {
        try {
          const res = await restorePersonaSnapshot(home, body?.snapshotFile);
          return jsonOut(200, { ok: true, restoredFrom: res.restoredFrom, ...(await getSummary()) });
        } catch (err) {
          return jsonOut(400, { ok: false, error: errMsg(err) });
        }
      },
    },
  ];
}