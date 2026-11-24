// LLM adapters for the Bilibili engage brain: one place that turns the usage runtime's
// metered one-shot into the `decideEngage` / `authorReply` callbacks the bili package
// consumes. Kept out of proactive-runtime so the tick file stays under the size ceiling.

import { loadConfig } from '../state.mjs';
import { resolveLlmModel } from '../llm-model-pick.mjs';
import { personaVoiceBrief } from '../persona-voice.mjs';
import { createLlmEngageDecider } from '../../soulmate-bili/engage-brain.mjs';
import { str } from '../small-utils.mjs';

export function createBiliLlmAdapters({ home, usage }) {
  const { meteredCall, listHostModels, oneShotLlm } = usage;

  const decideEngageFor = (ext) => (ext?.biliEngageLlmEnabled === false ? undefined : createLlmEngageDecider({
    oneShotLlm,
    listHostModels,
    resolveModel: resolveLlmModel,
    meteredCall,
    voiceOf: (persona) => personaVoiceBrief(persona, {}),
    maxCharsOf: async () => Number((await loadConfig(home).catch(() => null))?.extensions?.biliCommentMaxChars) || 80,
  }));

  const authorReply = async ({ prompt, kind }) => {
    const models = await listHostModels().catch(() => []);
    const picked = resolveLlmModel({ models, preferredId: '' });
    if (!picked.id) throw new Error('no model');
    const metered = await meteredCall({
      kind,
      trigger: 'auto',
      prompt,
      call: () => oneShotLlm({ prompt, modelId: picked.id, kind }),
    });
    if (!metered.ok || metered.blocked) throw new Error('blocked');
    return typeof metered.out === 'string' ? metered.out : str(metered.out?.text);
  };

  return { decideEngageFor, authorReply };
}