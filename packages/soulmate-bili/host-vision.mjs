/**
 * Bind Bilibili vision timeline summary to the host multimodal model.
 * Prefer silent generateReply. If the host only has sessionController.prompt,
 * fall back to a wake-marked prompt so the client hides the bubble (no blue dump).
 */
import { WAKE_BUBBLE_MARK } from '../soulmate-core/chat-home.mjs';
import { materializeVisionImages } from './vision-summary.mjs';
import { join } from 'node:path';

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
      // 宿主 admission 的 saveInput 读平铺字段 data/mediaType(非 Anthropic 嵌套 source);
      // 嵌套形状会让 decodeBase64(undefined) throw,被统一包成 agent-busy「prompt rejected」。
      blocks.push({ type: 'image', data: data[2], mediaType: data[1] || 'image/jpeg' });
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
  const canGenerate = typeof controller.generateReply === 'function';
  const canPrompt = typeof controller.prompt === 'function'
    && chatHome
    && typeof chatHome.ensureHomeSession === 'function';
  if (!canGenerate && !canPrompt) return null;

  return async ({ model: modelOverride, prompt, images, purpose = 'bili-vision-summary' }) => {
    const textPrompt = str(prompt).trim();
    if (!textPrompt) throw new Error('empty-prompt');
    // 无帧（雪碧图也没有）时退化为纯文本通道：字幕+元数据仍可读，诚实标注 ok:text-only。
    if (!Array.isArray(images) || !images.length) {
      if (canGenerate) {
        const out = await controller.generateReply({ text: textPrompt, purpose });
        const text = extractText(out);
        if (text) return { text, textOnly: true };
      }
      throw new Error('no-images');
    }
    const ready = await materializeVisionImages(images, {
      fetchImpl,
      soulmateRoot,
      readFileImpl,
      // QQ multimedia rejects the bilibili referer (HTTP 400); only bili frames need it.
      ...(String(purpose).startsWith('qq-') ? { referer: '' } : {}),
    });
    if (!ready.length) throw new Error('no-images');
    if (!ready.some((img) => str(img?.url).startsWith('data:'))) {
      throw new Error('no-image-pixels');
    }

    if (typeof controller.initializeDefaultModel === 'function') {
      try { await controller.initializeDefaultModel(); } catch { /* best-effort */ }
    }

    const modelId = str(modelOverride || model).trim() || undefined;
    const openAiContent = [{ type: 'text', text: textPrompt }, ...toOpenAiImageParts(ready)];
    const harnessContent = [{ type: 'text', text: textPrompt }, ...toHarnessImageParts(ready)];

    // A) Silent generateReply (preferred — never touches the dedicated chat UI).
    if (canGenerate) {
      const attempts = [
        { text: textPrompt, content: openAiContent, images: ready, model: modelId, purpose },
        { text: textPrompt, content: harnessContent, images: ready, model: modelId, purpose },
        { text: textPrompt, messages: [{ role: 'user', content: openAiContent }], model: modelId, purpose },
        { prompt: textPrompt, content: openAiContent, model: modelId, purpose },
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

    // B) Hidden prompt into home session: WAKE_BUBBLE_MARK makes the client hide the blue bubble.
    // 宿主把 admission/steer 的任何失败都报成 agent-busy「prompt rejected」(会话 agent 卡忙时
    // 每次必拒):拒收后等 4s 重试一次,仍拒则轮换到新会话(forceRotate)再试,避开卡死的 agent。
    if (canPrompt) {
      const { extractLatestAssistantUsage, waitForSessionUsage } = await import('../soulmate-core/usage.mjs');
      const logVision = (rec) => {
        if (!soulmateRoot) return;
        import('../soulmate-core/state.mjs').then(({ appendJsonl }) => {
          appendJsonl(join(soulmateRoot, 'logs', 'proactive.jsonl'), { at: new Date().toISOString(), kind: 'vision-debug', ...rec }).catch(() => {});
        }).catch(() => {});
      };
      const runPrompt = async (forceRotate) => {
        const ensured = await chatHome.ensureHomeSession({
          seedAfterRotate: false,
          forceRotate,
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

        const hiddenContent = [
          { type: 'text', text: `${WAKE_BUBBLE_MARK}${textPrompt}` },
          ...toHarnessImageParts(ready),
        ];
        let out;
        try {
          out = await controller.prompt({
            requestId: `bili-vision-${Date.now()}`,
            sessionId,
            mode: 'queue',
            content: hiddenContent,
            ...(modelId ? { model: modelId } : {}),
          }, signal);
        } catch (err) {
          // 宿主也可能直接 throw RemoteError(agent-busy/attachment-invalid),不走 ok:false 返回值
          const reason = str(err?.message || err);
          logVision({ ok: false, reason, forceRotate, sessionId, thrown: true });
          const e = new Error(reason);
          e.rejected = /prompt rejected|agent-busy/i.test(reason);
          throw e;
        }
        if (out && out.ok === false) {
          const reason = str(out.error || out.reason || 'prompt-rejected');
          logVision({ ok: false, reason, forceRotate, sessionId });
          const err = new Error(reason);
          err.rejected = true;
          throw err;
        }

        const waited = await waitForSessionUsage(controller, {
          sessionId,
          beforeMessageId,
          beforeAssistantCount,
          timeoutMs: 120_000,
          rejectTexts: [textPrompt.slice(0, 80), WAKE_BUBBLE_MARK],
        });
        const text = str(waited?.text || waited?.reply || '').trim();
        if (text) return { text };
        throw new Error('vision-prompt-empty');
      };
      try {
        return await runPrompt(false);
      } catch (err) {
        if (!err?.rejected) throw err;
        await new Promise((r) => setTimeout(r, 4000));
        try {
          return await runPrompt(false);
        } catch (err2) {
          if (!err2?.rejected) throw err2;
          return await runPrompt(true);
        }
      }
    }

    throw new Error('no-host-multimodal-path');
  };
}
