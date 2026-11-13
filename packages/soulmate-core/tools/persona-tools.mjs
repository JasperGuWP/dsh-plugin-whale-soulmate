// Model tools: companion interaction + persona customization / growth / safe resets.

import { loadConfig } from '../state.mjs';
import { AVATAR_FORMS, PRESETS, getDisplayName } from '../persona.mjs';
import { EVOLVE_MODES, RESET_MODES } from '../persona-arcs.mjs';

export const personaBrief = (conf) => ({
  name: conf.persona.name,
  displayName: getDisplayName(conf.persona),
  callUser: conf.persona.callUser,
  selfRef: conf.persona.selfRef,
  preset: conf.persona.preset,
  traitScheme: conf.persona.traitScheme || 'five',
  traits: conf.persona.traits,
  mbti: conf.persona.mbti,
  schemeSnapshots: conf.persona.schemeSnapshots,
  traitDeltas: conf.persona.traitDeltas,
  evolvedTraits: conf.persona.evolvedTraits,
  allowSelfEvolution: conf.persona.allowSelfEvolution,
});

export function personaTools({ makeTool, service, home, getSummary }) {
  const { interact, evolvePersona, resetPersona } = service;

  async function evolveOrReset(args) {
    const mode = args.mode;
    if (!EVOLVE_MODES.includes(mode)) return { ok: false, error: `unknown mode "${mode}" (expected ${EVOLVE_MODES.join(' | ')})` };
    let snapshotFile;
    let skipped = false;
    if (RESET_MODES.includes(mode)) {
      if (mode === 'full_rebirth' && args.confirm !== true) {
        return { ok: false, error: 'full_rebirth erases persona and state; pass confirm:true to proceed' };
      }
      const res = await resetPersona(mode, { removeMemory: mode === 'full_rebirth' && args.confirm === true && args.removeMemory === true });
      snapshotFile = res.snapshotFile;
    } else {
      const before = await loadConfig(home);
      skipped = mode === 'self_growth' && before.persona.allowSelfEvolution === false;
      const { confirm: _c, removeMemory: _r, ...evolution } = args;
      await evolvePersona(evolution);
    }
    const summary = await getSummary();
    return {
      ok: true,
      mode,
      ...(skipped ? { skipped: true, reason: 'allowSelfEvolution is off' } : {}),
      ...(snapshotFile ? { snapshotFile } : {}),
      persona: personaBrief(summary.config),
      appearance: summary.config.appearance,
      notebooks: summary.notebooks,
      state: summary.state,
      bondStage: summary.bondStage,
    };
  }

  const tools = [
    makeTool({
      name: 'soulmate_status_interact',
      description:
        'Interact with the Soulmate companion: feed / pat / tap / nuzzle / chat / work_assist / sleep. Updates mood, energy and affinity; optionally rename her (setName) ' +
        'or change how she addresses the user (setCallUser). Returns the new state, bond stage and the dynamic notebook titles. ' +
        'Desktop pet uses tap (+2) / nuzzle (+5); 3D home head-pat stays pat (+8).',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['feed', 'pat', 'tap', 'nuzzle', 'chat', 'work_assist', 'sleep'],
          description: 'feed | pat | tap | nuzzle | chat | work_assist | sleep',
        },
        setName: { type: 'string', description: 'Give the companion a name (the notebook becomes 《<name>的小本本》).' },
        setCallUser: { type: 'string', description: 'What she calls the user (the letter becomes 《给<name>的信》).' },
      },
      async run(args) {
        const state = await interact(args.action, { setName: args.setName, setCallUser: args.setCallUser });
        const summary = await getSummary();
        return {
          ok: true,
          action: args.action,
          state,
          bondStage: summary.bondStage,
          notebooks: summary.notebooks,
          persona: personaBrief(summary.config),
        };
      },
    }),

    makeTool({
      name: 'soulmate_persona_evolve',
      description:
        'Customize / grow / reset the Soulmate persona and appearance. mode: user_customize (name, callUser, selfRef, preset, traits 0-100, customBody) | ' +
        'self_growth (learned, traitDeltas) | appearance (formPreset, colors, scale, accessories) | reset_growth (clear learned traits only) | ' +
        'reset_persona (factory persona + look, memory kept) | full_rebirth (also resets state; needs confirm:true). Every reset snapshots first.',
      parameters: {
        mode: { type: 'string', required: true, enum: EVOLVE_MODES, description: EVOLVE_MODES.join(' | ') },
        name: { type: 'string' },
        callUser: { type: 'string' },
        selfRef: { type: 'string' },
        preset: { type: 'string', enum: Object.keys(PRESETS) },
        customBody: { type: 'string', description: 'Free-form persona text that overrides the preset.' },
        traits: { type: 'object', description: 'Trait sliders, any of tsundere|clinginess|sassiness|curiosity|brevity (0-100).' },
        traitScheme: { type: 'string', enum: ['five', 'mbti'], description: 'five = anime sliders; mbti = 16 types (maps to five for scheduling).' },
        mbti: { type: 'object', description: 'MBTI block: { type: INFP|…, axes: { EI,SN,TF,JP 0-100 } }. User edits drive five-trait mapping.' },
        allowSelfEvolution: { type: 'boolean' },
        learned: { type: 'array', items: { type: 'string' }, description: 'self_growth: newly learned traits.' },
        traitDeltas: { type: 'object', description: 'self_growth: trait offsets (±25 cumulative).' },
        reason: { type: 'string' },
        formPreset: { type: 'string', enum: Object.keys(AVATAR_FORMS) },
        primaryColor: { type: 'string' },
        accentColor: { type: 'string' },
        auraColor: { type: 'string' },
        scale: { type: 'number' },
        accessories: { type: 'object', description: 'ironBowl / holoHeadset / quantumHalo / starRing booleans.' },
        confirm: { type: 'boolean', description: 'Required for full_rebirth.' },
        removeMemory: { type: 'boolean', description: 'full_rebirth + confirm: also wipe local memory.' },
      },
      run: (args) => evolveOrReset(args),
    }),
  ];

  return { tools, evolveOrReset };
}
