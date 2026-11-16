// Panel / onboarding routes: state, config patch, onboard, interact, persona evolve, quiz.

import { loadConfig, saveConfigAuto } from '../state.mjs';
import { PRESETS, normalizeGender } from '../persona.mjs';
import { upsertIdentityAnchors } from '../memory-enrichment.mjs';
import { CONFIG_PATCH_KEYS, pickPatch } from '../plugin-config.mjs';
import { GENDER_PET_SKIN } from '../assets.mjs';
import { jsonOut, statusOf } from '../http-plumbing.mjs';
import { errMsg } from '../small-utils.mjs';

export function personaRoutes({ home, service, memory, getSummary, evolveOrReset, startPersonaQuiz, runBootGreetingWithRetry, refreshPresence, warn }) {
  // enrichSafe lives on the memory runtime, not on the public ctx.soulmate surface.
  const { interact, evolvePersona } = service;
  const { enrichSafe } = memory;
  return [
    { method: 'GET', paths: ['/dsh-soulmate/api/state'], handler: async () => jsonOut(200, await getSummary()) },
    { method: 'GET', paths: ['/dsh-soulmate/api/config'], handler: async () => jsonOut(200, (await getSummary()).config) },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/config'],
      handler: async ({ body }) => {
        const patch = pickPatch(body, CONFIG_PATCH_KEYS);
        if (Object.keys(patch).length === 0) return jsonOut(400, { ok: false, error: 'no writable config fields in request' });
        // Re-enabling clears the auto-off reason so pet reminders and UI stop showing "exhausted".
        if (patch.proactive && patch.proactive.dreamLlmEnabled === true) {
          patch.proactive.dreamLlmAutoOffReason = '';
        }
        if (patch.proactive && patch.proactive.distillLlmEnabled === true) {
          patch.proactive.distillLlmAutoOffReason = '';
        }
        // 皮肤自动联动：skinAuto 未显式关闭时，皮肤必须跟随当前性别（防旧草稿回写错配）。
        if (patch.pet && patch.pet.skin !== undefined && patch.pet.skinAuto !== false) {
          const conf = await loadConfig(home);
          const linked = conf.persona?.gender === 'male' ? GENDER_PET_SKIN.male : GENDER_PET_SKIN.female;
          if (patch.pet.skin !== linked) patch.pet.skin = linked;
        }
        await saveConfigAuto(home, patch);
        return jsonOut(200, await getSummary());
      },
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/onboard'],
      handler: async ({ body }) => {
        const gender = normalizeGender(body.gender);
        if (!gender) return jsonOut(400, { ok: false, error: 'gender required' });
        const preset = typeof body.preset === 'string' && PRESETS[body.preset] ? PRESETS[body.preset] : null;
        if (!preset || preset.gender !== gender) {
          return jsonOut(400, { ok: false, error: 'preset does not match gender' });
        }
        const customize = {
          mode: 'user_customize',
          gender,
          preset: preset.id,
          selfRef: preset.defaultSelfRef,
          callUser: preset.defaultCallUser,
        };
        if (typeof body.callUser === 'string' && body.callUser.trim()) customize.callUser = body.callUser.trim();
        if (typeof body.name === 'string') customize.name = body.name.trim();
        try {
          await evolvePersona(customize);
        } catch (err) {
          return jsonOut(400, { ok: false, error: errMsg(err) });
        }
        if (body.complete !== false) {
          await saveConfigAuto(home, { onboardingCompleted: true });
          // Deferred boot greeting: now that the chosen preset is on disk, greet in its voice.
          void runBootGreetingWithRetry({ delaysMs: [0, 4000, 10000] }).catch((err) => warn('post-onboard boot greeting failed', err));
        }
        await enrichSafe('onboard-identity', async () => {
          const conf = await loadConfig(home);
          await upsertIdentityAnchors(home, conf.persona);
          void refreshPresence();
        });
        return jsonOut(200, await getSummary());
      },
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/interact'],
      handler: async ({ body }) => {
        try {
          const state = await interact(body.action, { setName: body.setName, setCallUser: body.setCallUser });
          const summary = await getSummary();
          return jsonOut(200, { ...summary, ok: true, action: body.action, state });
        } catch (err) {
          return jsonOut(400, { ok: false, error: errMsg(err) });
        }
      },
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/persona-evolve'],
      handler: async ({ body }) => {
        try {
          const res = await evolveOrReset(body);
          return jsonOut(statusOf(res), res.ok ? { ...(await getSummary()), ...res } : res);
        } catch (err) {
          return jsonOut(400, { ok: false, error: errMsg(err) });
        }
      },
    },
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/persona-quiz-start'],
      handler: async () => {
        try {
          const res = await startPersonaQuiz();
          return jsonOut(res.ok ? 200 : 400, res);
        } catch (err) {
          return jsonOut(400, { ok: false, error: errMsg(err) });
        }
      },
    },
  ];
}
