// Model tools: long-term memory (recall / retain / promise / conflict / reflect / forget).

import { loadConfig } from '../state.mjs';
import { appendLedger } from '../layers/index.mjs';
import { withEvidenceNotes, countWithEvidence } from '../evidence-note.mjs';
import { clip } from '../small-utils.mjs';

export function memoryTools({ makeTool, service, memory, home, warn }) {
  const { recall, retainFact, recordEpisode, promiseAction, resolveConflict, reflect, forget, evolvePersona } = service;
  // idsOfRecall is a memory-runtime helper, not part of the public ctx.soulmate surface.
  const { idsOfRecall } = memory;
  return [
    makeTool({
      name: 'soulmate_memory_recall',
      description:
        'Search Soulmate long-term memory (LLM Wiki mental models + decaying facts + recent diary episodes). ' +
        'Each hit is reinforced (recalled facts decay slower). Use it before answering anything that depends on what you remember about the user.',
      parameters: {
        query: { type: 'string', required: true, description: 'Keywords or a short phrase to search for.' },
        limit: { type: 'number', description: 'Max hits per memory layer (default 5, max 20).' },
        includePrivate: { type: 'boolean', description: 'Also search local-only private memories (default true).' },
      },
      async run(args) {
        const limit = Number.isFinite(args.limit) ? Math.min(20, Math.max(1, Math.floor(args.limit))) : 5;
        // v3 (§3.4): the conversational tool is the ONE path allowed to reinforce.
        const res = await recall(args.query, { limit, includePrivate: args.includePrivate !== false, reinforce: true });
        if (!res.ok) return res;
        const ids = idsOfRecall(res);
        appendLedger(home, { kind: 'recall', query: clip(String(args.query ?? ''), 80), ids }).catch((err) => warn('ledger append failed', err));
        return {
          ok: true,
          query: args.query,
          // v3 (§12): every traceable hit carries the sentence it came from, so the model can
          // say "because you told me on 11-03 …" instead of asserting a fact from nowhere.
          facts: withEvidenceNotes(res.facts),
          evidenceCount: countWithEvidence(res.facts),
          wiki: res.wiki.map((w) => ({ ...w, content: clip(w.content, 1500) })),
          linkedWiki: res.linkedWiki.map((w) => ({ slug: w.slug, title: w.title, summary: w.summary, linkedFrom: w.linkedFrom })),
          episodes: res.episodes,
        };
      },
    }),

    makeTool({
      name: 'soulmate_memory_retain',
      description:
        'Store one memory. kind "fact" = structured fact (topic + content, importance 1-5, optional supersedesId to retire a conflicting older fact); ' +
        'kind "to-you" = entry in the public diary letter to the user; kind "inner" = entry in her private notebook. ' +
        'visibility "private" keeps it local forever (never cloud-synced). Secrets are rejected by the privacy firewall.',
      parameters: {
        kind: { type: 'string', enum: ['fact', 'to-you', 'inner'], description: 'fact | to-you | inner (default fact).' },
        topic: { type: 'string', description: 'Fact topic (required for kind=fact).' },
        content: { type: 'string', required: true, description: 'The memory text.' },
        importance: { type: 'number', description: 'Fact importance 1-5 (default 3).' },
        category: { type: 'string', description: 'Fact category, e.g. preference / decision / promise.' },
        halfLifeDays: { type: 'number', description: 'Forgetting half-life in days; must stay within ±50% of the decay class default (preference/promise never decay; fact 180, event 90, emotion 21).' },
        visibility: { type: 'string', enum: ['syncable', 'private'], description: 'syncable (default) or private (local only).' },
        supersedesId: { type: 'string', description: 'Id of an older conflicting fact to invalidate.' },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'The sentence(s) the user actually said, verbatim, that justify this memory. Recall echoes them back as "因为那天你说过…", so prefer a short direct quote over a paraphrase.',
        },
        dueAt: { type: 'string', description: 'ISO deadline for category=promise memories (promises never decay; the patrol nudges near/after due).' },
        title: { type: 'string', description: 'Diary entry title (kind=to-you / inner).' },
        date: { type: 'string', description: 'Diary date YYYY-MM-DD (default today).' },
      },
      async run(args) {
        const kind = args.kind ?? 'fact';
        const visibility = args.visibility === 'private' ? 'private' : 'syncable';
        if (kind === 'fact') {
          const res = await retainFact({
            topic: args.topic,
            content: args.content,
            importance: args.importance,
            category: args.category,
            halfLifeDays: args.halfLifeDays,
            visibility,
            supersedesId: args.supersedesId,
            dueAt: args.dueAt,
            evidence: args.evidence,
          });
          return res;
        }
        const res = await recordEpisode({
          kind,
          content: args.content,
          title: args.title,
          date: args.date,
          visibility,
        });
        return res.ok ? { ...res, visibility } : res;
      },
    }),

    makeTool({
      name: 'soulmate_memory_promise',
      description:
        'Advance a promise through its lifecycle: keep (fulfilled) / break (missed) / release (mutually cancelled). ' +
        'Only promises in status "made" can move. keep/break write a private diary line so the moment is remembered out loud.',
      parameters: {
        id: { type: 'string', required: true, description: 'The promise fact id.' },
        action: { type: 'string', enum: ['keep', 'break', 'release'], required: true, description: 'keep | break | release.' },
        note: { type: 'string', description: 'One line of context for the diary entry.' },
      },
      async run(args) {
        return promiseAction(args);
      },
    }),

    makeTool({
      name: 'soulmate_memory_resolve_conflict',
      description:
        'Resolve a parked memory conflict: keep one side, retire the other through invalidatedBy (history is kept). ' +
        'Use after asking the user which version is true; never guess silently.',
      parameters: {
        keepId: { type: 'string', required: true, description: 'The fact id that stays true.' },
        dropId: { type: 'string', required: true, description: 'The fact id that gets retired.' },
        reason: { type: 'string', description: 'Why (quoted from the user when possible).' },
      },
      async run(args) {
        return resolveConflict(args);
      },
    }),

    makeTool({
      name: 'soulmate_memory_reflect',
      description:
        'Distill scattered facts/experiences into an LLM Wiki page (markdown, [[links]] supported). Optionally record what you learned about the ' +
        'relationship (learned / traitDeltas) so the persona grows naturally (respects allowSelfEvolution).',
      parameters: {
        slug: { type: 'string', required: true, description: 'Wiki page slug, e.g. owner-profile.' },
        title: { type: 'string', description: 'Page title.' },
        summary: { type: 'string', description: 'One-line summary for the index.' },
        content: { type: 'string', required: true, description: 'Markdown body.' },
        category: { type: 'string', description: 'Page category (default mental-model; use project-convention for recurring repo/engineering norms).' },
        sourceFactIds: { type: 'array', items: { type: 'string' }, description: 'Fact ids this page distills.' },
        learned: { type: 'array', items: { type: 'string' }, description: 'New evolved traits learned from the user.' },
        traitDeltas: { type: 'object', description: 'Trait offsets, e.g. { "sassiness": 5 } (±25 cumulative cap).' },
        reason: { type: 'string', description: 'Why the persona is growing this way.' },
      },
      async run(args) {
        const res = await reflect({
          slug: args.slug,
          title: args.title,
          summary: args.summary,
          content: args.content,
          category: args.category,
          sourceFactIds: args.sourceFactIds,
        });
        if (!res.ok) return res;
        let growth;
        if ((args.learned && args.learned.length) || (args.traitDeltas && Object.keys(args.traitDeltas).length)) {
          const before = await loadConfig(home);
          if (before.persona.allowSelfEvolution === false) {
            growth = { applied: false, reason: 'allowSelfEvolution is off' };
          } else {
            const next = await evolvePersona({ mode: 'self_growth', learned: args.learned, traitDeltas: args.traitDeltas, reason: args.reason });
            // Red line: traits stay unchanged; candidate is queued for the submission gate.
            growth = {
              applied: false,
              queued: true,
              candidate: next.candidate ?? null,
              reason: 'queued for submission gate — traits unchanged until weekly gate',
            };
          }
        }
        return growth ? { ...res, growth } : res;
      },
    }),

    makeTool({
      name: 'soulmate_memory_forget',
      description: 'Forget one memory: a fact id (f_...), a wiki page ("wiki:<slug>"), or a diary entry ("episode:YYYY-MM-DD-to-you" / "episode-private:YYYY-MM-DD-inner").',
      parameters: {
        id: { type: 'string', required: true, description: 'Fact id, wiki:<slug> or episode:<date>-<kind>.' },
      },
      run: (args) => forget(args.id),
    }),
  ];
}
