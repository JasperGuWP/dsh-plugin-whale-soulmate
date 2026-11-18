/** 从 ASR 服务(OpenAI 兼容)拉模型 ID 列表:把 endpoint 末段换成 /models。
 *  兼容 {data:[{id}]} / {models:[{id}|string]} 两种形状。 */
export async function fetchAsrModels({
  endpoint = '',
  apiKey = '',
  fetchImpl,
  timeoutMs = 10_000,
} = {}) {
  const url = str(endpoint).trim();
  if (!url) return { ok: false, models: [], error: 'no-endpoint' };
  let modelsUrl;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return { ok: false, models: [], error: 'bad-protocol' };
    // OpenAI 兼容约定:版本段之后的深路径一律回落到 {…/v1}/models;
    // 纯基址(以 /v1 结尾)直接拼 /models;无版本段才砍末段(如 …/transcribe)。
    const vm = u.pathname.match(/^(.*\/v\d+)(?:\/.*)?$/i);
    u.pathname = vm ? vm[1] + '/models' : u.pathname.replace(/\/[^/]*$/, '') + '/models';
    modelsUrl = u.toString();
  } catch {
    return { ok: false, models: [], error: 'bad-endpoint' };
  }
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: false, models: [], error: 'no-fetch' };
  const headers = { accept: 'application/json' };
  const key = str(apiKey).trim();
  if (key) headers.authorization = `Bearer ${key}`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(2_000, num(timeoutMs, 10_000))) : null;
  try {
    const res = await fetchFn(modelsUrl, { method: 'GET', headers, signal: controller?.signal });
    if (!res.ok) return { ok: false, models: [], modelsUrl, error: `http-${res.status}` };
    const data = await res.json().catch(() => ({}));
    const raw = Array.isArray(data?.data) ? data.data
      : Array.isArray(data?.models) ? data.models
        : Array.isArray(data) ? data
          : [];
    const models = [...new Set(raw.map((m) => str(m?.id ?? m?.name ?? m).trim()).filter(Boolean))];
    return { ok: true, models, modelsUrl, error: models.length ? '' : 'empty-list' };
  } catch (err) {
    return { ok: false, models: [], modelsUrl, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 协议族解析:auto = 阿里系域名走 DashScope,其余走 OpenAI 式转写。 */
export function resolveAsrProtocol(endpoint, protocol) {
  const p = str(protocol).trim().toLowerCase();
  if (p === 'openai' || p === 'dashscope' || p === 'deepseek' || p === 'json') return p;
  return /aliyuncs\.com/i.test(str(endpoint)) ? 'dashscope' : 'openai';
}

const BILI_HEADERS = { referer: 'https://www.bilibili.com/', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

function withTimeout(timeoutMs, fallback = 120_000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(5_000, num(timeoutMs, fallback))) : null;
  return { controller, done: () => { if (timer) clearTimeout(timer); } };
}

/** OpenAI 式转写:下载 B 站音频流,multipart 上传到 {base}/audio/transcriptions。
 *  火山引擎/自建 whisper/多数兼容网关都吃这套。 */
export async function transcribeOpenAiAudio({
  endpoint = '',
  apiKey = '',
  model = '',
  audioUrl = '',
  fetchImpl,
  timeoutMs = 120_000,
} = {}) {
  const base = str(endpoint).trim();
  if (!base) return { ok: false, channel: 'skip:unconfigured', text: '', error: 'no-endpoint' };
  if (!str(audioUrl).trim()) return { ok: false, channel: 'skip:error', text: '', error: 'no-audio-url' };
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: false, channel: 'skip:error', text: '', error: 'no-fetch' };
  let target = base;
  try {
    const u = new URL(base);
    if (/\/v\d+$/i.test(u.pathname)) { u.pathname = u.pathname + '/audio/transcriptions'; target = u.toString(); }
  } catch { /* invalid URL fails loudly at fetch */ }
  const t = withTimeout(timeoutMs);
  try {
    const audioRes = await fetchFn(str(audioUrl).trim(), { headers: BILI_HEADERS, signal: t.controller?.signal });
    if (!audioRes.ok) return { ok: false, channel: 'skip:error', text: '', error: `audio-http-${audioRes.status}` };
    const bytes = await audioRes.arrayBuffer();
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/mp4' }), 'audio.m4s');
    if (str(model).trim()) form.append('model', str(model).trim());
    const headers = {};
    const key = str(apiKey).trim();
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetchFn(target, { method: 'POST', headers, body: form, signal: t.controller?.signal });
    if (!res.ok) return { ok: false, channel: 'skip:error', text: '', error: `http-${res.status}` };
    const data = await res.json().catch(() => ({}));
    const segments = Array.isArray(data?.segments)
      ? data.segments.map((s) => ({ startSec: num(s?.startSec ?? s?.start, 0), endSec: num(s?.endSec ?? s?.end, 0), text: str(s?.text).trim() })).filter((s) => s.text)
      : [];
    let text = str(data?.text).trim();
    if (!text && segments.length) text = segments.map((s) => s.text).join('\n');
    if (!text) return { ok: false, channel: 'skip:error', text: '', error: 'empty-transcript' };
    return { ok: true, channel: 'ok', text, segments };
  } catch (err) {
    return { ok: false, channel: 'skip:error', text: '', error: err instanceof Error ? err.message : String(err) };
  } finally {
    t.done();
  }
}

/** 阿里 DashScope 多模态生成:qwen-audio-asr 系模型,传音频 URL。 */
export async function transcribeDashScope({
  endpoint = '',
  apiKey = '',
  model = '',
  audioUrl = '',
  fetchImpl,
  timeoutMs = 120_000,
} = {}) {
  const url = str(endpoint).trim();
  if (!url) return { ok: false, channel: 'skip:unconfigured', text: '', error: 'no-endpoint' };
  if (!str(audioUrl).trim()) return { ok: false, channel: 'skip:error', text: '', error: 'no-audio-url' };
  if (!str(model).trim()) return { ok: false, channel: 'skip:error', text: '', error: 'no-model' };
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: false, channel: 'skip:error', text: '', error: 'no-fetch' };
  let target;
  try {
    const u = new URL(url);
    target = /multimodal-generation/i.test(u.pathname)
      ? u.toString()
      : u.origin + '/api/v1/services/aigc/multimodal-generation/generation';
  } catch {
    return { ok: false, channel: 'skip:error', text: '', error: 'bad-endpoint' };
  }
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetchFn(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${str(apiKey).trim()}` },
      body: JSON.stringify({
        model: str(model).trim(),
        input: { messages: [{ role: 'user', content: [{ audio: str(audioUrl).trim() }] }] },
      }),
      signal: t.controller?.signal,
    });
    if (!res.ok) return { ok: false, channel: 'skip:error', text: '', error: `http-${res.status}` };
    const data = await res.json().catch(() => ({}));
    const out = data?.output || {};
    const text = str(
      out.text
      || out.choices?.[0]?.message?.content?.map?.((c) => str(c?.text)).join('')
      || out.choices?.[0]?.message?.content
      || ''
    ).trim();
    if (!text) return { ok: false, channel: 'skip:error', text: '', error: 'empty-transcript' };
    return { ok: true, channel: 'ok', text, segments: [] };
  } catch (err) {
    return { ok: false, channel: 'skip:error', text: '', error: err instanceof Error ? err.message : String(err) };
  } finally {
    t.done();
  }
}

/** Deepseek 原生转写:OpenAI 兼容 /v1/tools/asr 端点,参数格式一致。 */
export async function transcribeDeepseek({
  endpoint = '',
  apiKey = '',
  model = '',
  audioUrl = '',
  fetchImpl,
  timeoutMs = 120_000,
} = {}) {
  const base = str(endpoint).trim();
  if (!base) return { ok: false, channel: 'skip:unconfigured', text: '', error: 'no-endpoint' };
  if (!str(audioUrl).trim()) return { ok: false, channel: 'skip:error', text: '', error: 'no-audio-url' };
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: false, channel: 'skip:error', text: '', error: 'no-fetch' };
  let target = base;
  try {
    const u = new URL(base);
    if (/\/v\d+$/i.test(u.pathname)) { u.pathname = u.pathname + '/tools/asr'; target = u.toString(); }
  } catch { /* invalid URL fails loudly at fetch */ }
  const t = withTimeout(timeoutMs);
  try {
    const audioRes = await fetchFn(str(audioUrl).trim(), { headers: BILI_HEADERS, signal: t.controller?.signal });
    if (!audioRes.ok) return { ok: false, channel: 'skip:error', text: '', error: `audio-http-${audioRes.status}` };
    const bytes = await audioRes.arrayBuffer();
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/mp4' }), 'audio.m4s');
    if (str(model).trim()) form.append('model', str(model).trim());
    const headers = {};
    const key = str(apiKey).trim();
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetchFn(target, { method: 'POST', headers, body: form, signal: t.controller?.signal });
    if (!res.ok) return { ok: false, channel: 'skip:error', text: '', error: `http-${res.status}` };
    const data = await res.json().catch(() => ({}));
    const segments = Array.isArray(data?.segments)
      ? data.segments.map((s) => ({ startSec: num(s?.startSec ?? s?.start, 0), endSec: num(s?.endSec ?? s?.end, 0), text: str(s?.text).trim() })).filter((s) => s.text)
      : [];
    let text = str(data?.text).trim();
    if (!text && segments.length) text = segments.map((s) => s.text).join('\n');
    if (!text) return { ok: false, channel: 'skip:error', text: '', error: 'empty-transcript' };
    return { ok: true, channel: 'ok', text, segments };
  } catch (err) {
    return { ok: false, channel: 'skip:error', text: '', error: err instanceof Error ? err.message : String(err) };
  } finally {
    t.done();
  }
}

/**
 * Optional external ASR for Bilibili videos when official subtitles are missing.
 * User-configured endpoint only — no bundled Whisper.
 */

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * @returns {{ ok: boolean, channel: string, text: string, segments?: object[], error?: string }}
 */
export async function transcribeViaEndpoint({
  endpoint = '',
  apiKey = '',
  model = '',
  bvid = '',
  audioUrl = '',
  durationSec = 0,
  fetchImpl,
  timeoutMs = 60_000,
} = {}) {
  const url = str(endpoint).trim();
  if (!url) {
    return { ok: false, channel: 'skip:unconfigured', text: '', error: 'no-endpoint' };
  }
  // 只填了基址(以 /v1 结尾)时补 OpenAI 标准转写路径
  let target = url;
  try {
    const u = new URL(url);
    if (/\/v\d+$/i.test(u.pathname)) { u.pathname = u.pathname + '/audio/transcriptions'; target = u.toString(); }
  } catch { /* invalid URL fails loudly at fetch */ }
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, channel: 'skip:error', text: '', error: 'no-fetch' };
  }

  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  const key = str(apiKey).trim();
  if (key) headers.authorization = `Bearer ${key}`;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), Math.max(5_000, num(timeoutMs, 60_000)))
    : null;

  try {
    const res = await fetchFn(target, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...(str(model).trim() ? { model: str(model).trim() } : {}),
        bvid: str(bvid).trim() || undefined,
        audioUrl: str(audioUrl).trim() || undefined,
        durationSec: num(durationSec, 0) || undefined,
      }),
      signal: controller?.signal,
    });
    if (!res.ok) {
      return { ok: false, channel: 'skip:error', text: '', error: `http-${res.status}` };
    }
    const data = await res.json().catch(() => ({}));
    const segments = Array.isArray(data?.segments)
      ? data.segments.map((s) => ({
        startSec: num(s?.startSec ?? s?.start, 0),
        endSec: num(s?.endSec ?? s?.end, 0),
        text: str(s?.text).trim(),
      })).filter((s) => s.text)
      : [];
    let text = str(data?.text).trim();
    if (!text && segments.length) {
      text = segments.map((s) => s.text).join('\n');
    }
    if (!text) {
      return { ok: false, channel: 'skip:error', text: '', error: 'empty-transcript' };
    }
    return { ok: true, channel: 'ok', text, segments };
  } catch (err) {
    return {
      ok: false,
      channel: 'skip:error',
      text: '',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
