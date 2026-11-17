/**
 * Bind Bilibili vision timeline summary to the host's normal chat multimodal model
 * (same sessionController.generateReply / prompt path as everyday chat — not a separate "vision product").
 */
import { materializeVisionImages } from './vision-summary.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function extractText(out) {
  if (out == null) return '';
  if (typeof out === 'string') return out.trim();
  const direct = str(out.text ?? out.reply ?? out.content ?? out.message?.content ?? '').trim();
  if (direct) return direct;
  if (Array.isArray(out.content)) {
    return out.content.map((b) => str(b?.text || b?.content || '')).filter(Boolean).join('\n').trim();
  }
  return '';
}

function toOpenAiImageParts(images) {
  return (images || []).map((img) => ({
    type: 'image_url',
    image_url: { url: str(img?.url).trim() },
  })).filter((b) => b.image_url.url);
}

function toHarnessImageParts(images) {
  const blocks = [];
  for (const img of images || []) {
    const url = str(img?.url).trim();
    if (!url) continue;
    const data = url.match(/^data:([^;]+);base64,(.+)$/i);
    if (data) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: data[1] || 'image/jpeg', data: data[2] },
      });
    } else {
      blocks.push({ type: 'image_url', image_url: { url } });
    }
  }
  return blocks;
}

/**
 * @returns {null | ((args) => Promise<{text:string}>)}
 */
export function createHostVisionSummarize({
  controller,
  chatHome,
  fetchImpl,
  model = '',
  soulmateRoot = '',
  readFileImpl,
  warn = () => {},
} = {}) {
  if (!controller) return null;

  return async ({ model: modelOverride, prompt, images }) => {
    const ready = await materializeVisionImages(images, {
      fetchImpl,
      soulmateRoot,
      readFileImpl,
    });
    if (!ready.length) throw new Error('no-images');
    // Require at least one real data URL — relative live-frame paths are useless to the model.
    if (!ready.some((img) => str(img?.url).startsWith('data:'))) {
      throw new Error('no-image-pixels');
    }
    const textPrompt = str(prompt).trim();
    if (!textPrompt) throw new Error('empty-prompt');

    if (typeof controller.initializeDefaultModel === 'function') {
      try { await controller.initializeDefaultModel(); } catch { /* best-effort */ }
    }

    const modelId = str(modelOverride || model).trim() || undefined;
    const openAiContent = [{ type: 'text', text: textPrompt }, ...toOpenAiImageParts(ready)];
    const harnessContent = [{ type: 'text', text: textPrompt }, ...toHarnessImageParts(ready)];

    // A) Same fast path as chat / IM: generateReply on the host multimodal model.
    if (typeof controller.generateReply === 'function') {
      const attempts = [
        { text: textPrompt, content: openAiContent, images: ready, model: modelId, purpose: 'bili-vision-summary' },
        { text: textPrompt, content: harnessContent, images: ready, model: modelId, purpose: 'bili-vision-summary' },
        { text: textPrompt, messages: [{ role: 'user', content: openAiContent }], model: modelId, purpose: 'bili-vision-summary' },
        { prompt: textPrompt, content: openAiContent, model: modelId, purpose: 'bili-vision-summary' },
      ];
      for (const args of attempts) {
        try {
          const out = await controller.generateReply(args);
          const text = extractText(out);
          if (text) return { text };
        } catch (err) {
          warn('host vision generateReply attempt failed', err);
        }
      }
    }

    // B) Dedicated soulmate window prompt + wait (works on hosts where generateReply is thin).
    if (chatHome && typeof chatHome.ensureHomeSession === 'function' && typeof controller.prompt === 'function') {
      const { deliverViaPrompt } = await import('../soulmate-core/chat-home.mjs');
      const { extractLatestAssistantUsage, waitForSessionUsage } = await import('../soulmate-core/usage.mjs');

      const ensured = await chatHome.ensureHomeSession({
        seedAfterRotate: false,
        forceRotate: false,
        rotateIfFull: false,
      });
      if (!ensured?.ok || !ensured.sessionId) {
        throw new Error(ensured?.error || 'no-chat-home-session');
      }
      const sessionId = ensured.sessionId;

      let beforeMessageId = '';
      let beforeAssistantCount = 0;
      if (typeof controller.events === 'function') {
        try {
          const page = await controller.events({
            address: { kind: 'session', sessionId },
            maxMessages: 40,
          }, typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(12_000)
            : new AbortController().signal);
          const snap = extractLatestAssistantUsage(page);
          beforeMessageId = snap.messageId || '';
          beforeAssistantCount = snap.assistantCount || 0;
        } catch { /* baseline best-effort */ }
      }

      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(180_000)
        : new AbortController().signal;

      // Prefer multimodal content on prompt(); fall back to text-only deliverViaPrompt.
      let delivered;
      try {
        const out = await controller.prompt({
          requestId: `bili-vision-${Date.now()}`,
          sessionId,
          mode: 'queue',
          content: harnessContent,
          ...(modelId ? { model: modelId } : {}),
        }, signal);
        delivered = out && out.ok === false
          ? { ok: false, reason: str(out.error || out.reason || 'prompt-rejected') }
          : { ok: true };
      } catch (err) {
        delivered = await deliverViaPrompt(controller, {
          sessionId,
          kind: 'bili-vision',
          visibleText: textPrompt.slice(0, 500),
        });
        if (!delivered.ok) throw err instanceof Error ? err : new Error(str(err));
      }
      if (!delivered.ok) throw new Error(delivered.reason || 'prompt-failed');

      const waited = await waitForSessionUsage(controller, {
        sessionId,
        beforeMessageId,
        beforeAssistantCount,
        timeoutMs: 120_000,
        rejectTexts: [textPrompt.slice(0, 80)],
      });
      const text = str(waited?.text || waited?.reply || '').trim();
      if (text) return { text };
      throw new Error('vision-prompt-empty');
    }

    throw new Error('no-host-multimodal-path');
  };
}
