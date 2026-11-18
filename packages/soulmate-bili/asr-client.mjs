import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/** 有官方字幕时是否改用 ASR 文本:官方为空/被判错配必用;否则仅当 ASR 覆盖足够(≥30%)
 *  才替换,避免长片 ASR 截断反而比官方字幕少。 */
export function preferAsrTranscript({ official = '', asrText = '', transcriptEmpty = false } = {}) {
  const a = str(asrText).trim();
  if (!a) return false;
  const o = str(official).trim();
  if (transcriptEmpty || !o) return true;
  return a.length >= Math.max(40, Math.floor(o.length * 0.3));
}

/** 协议族解析:显式四类(deepseek / dashscope / openai / json)按配置走;
 *  旧配置的 auto / 空值 → 推荐 DeepSeek ASR(阿里域名仍走 Qwen DashScope)。 */
export function resolveAsrProtocol(endpoint, protocol) {
  const p = str(protocol).trim().toLowerCase();
  if (p === 'openai' || p === 'dashscope' || p === 'deepseek' || p === 'json') return p;
  return /aliyuncs\.com|dashscope/i.test(str(endpoint)) ? 'dashscope' : 'deepseek';
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

/** 阿里 DashScope(百炼 / maas compatible-mode):本地下载音频 → base64 data URI →
 *  chat/completions 的 input_audio(服务器拉不到 B 站 CDN,必须直传)。
 *  配置的 ASR 模型 400 时回退 qwen3-asr-flash(ASR 专用 compatible 模型)。 */
export async function transcribeDashScope({
  endpoint = '',
  apiKey = '',
  model = '',
  audioUrl = '',
  fetchImpl,
  timeoutMs = 180_000,
  maxBytes = 8 * 1024 * 1024,
} = {}) {
  const url = str(endpoint).trim();
  if (!url) return { ok: false, channel: 'skip:unconfigured', text: '', error: 'no-endpoint' };
  if (!str(audioUrl).trim()) return { ok: false, channel: 'skip:error', text: '', error: 'no-audio-url' };
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: false, channel: 'skip:error', text: '', error: 'no-fetch' };
  let target;
  try {
    const u = new URL(url);
    target = /\/chat\/completions$/i.test(u.pathname)
      ? u.toString()
      : (/\/v\d+$/i.test(u.pathname) ? u.toString() + '/chat/completions' : u.origin + '/compatible-mode/v1/chat/completions');
  } catch {
    return { ok: false, channel: 'skip:error', text: '', error: 'bad-endpoint' };
  }
  const t = withTimeout(timeoutMs, 180_000);
  try {
    const audioRes = await fetchFn(str(audioUrl).trim(), { headers: BILI_HEADERS, signal: t.controller?.signal });
    if (!audioRes.ok) return { ok: false, channel: 'skip:error', text: '', error: `audio-http-${audioRes.status}` };
    let bytes = Buffer.from(await audioRes.arrayBuffer());
    if (bytes.length > maxBytes) bytes = bytes.subarray(0, maxBytes);
    const dataUri = 'data:audio/mp4;base64,' + bytes.toString('base64');

    const tryModel = async (modelId) => {
      const res = await fetchFn(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${str(apiKey).trim()}` },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] }],
        }),
        signal: t.controller?.signal,
      });
      const bodyText = await res.text().catch(() => '');
      if (!res.ok) return { ok: false, status: res.status, body: bodyText };
      let data = {};
      try { data = JSON.parse(bodyText); } catch { data = {}; }
      const text = str(data?.choices?.[0]?.message?.content || '').trim();
      return { ok: !!text, status: res.status, text, body: bodyText };
    };

    let r = await tryModel(str(model).trim() || 'qwen3-asr-flash');
    if (!r.ok && r.status === 400 && str(model).trim() !== 'qwen3-asr-flash') {
      r = await tryModel('qwen3-asr-flash');
    }
    if (r.ok) return { ok: true, channel: 'ok', text: r.text, segments: [] };
    const detail = String(r.body || '').replace(/\s+/g, ' ').slice(0, 140);
    return { ok: false, channel: 'skip:error', text: '', error: `http-${r.status}${detail ? ':' + detail : ''}` };
  } catch (err) {
    return { ok: false, channel: 'skip:error', text: '', error: err instanceof Error ? err.message : String(err) };
  } finally {
    t.done();
  }
}

/** DeepSeek 官方语音转文字:POST {base}/v1/tools/asr,multipart 上传 16-bit PCM WAV。
 *  B 站音轨是 m4s(AAC),先用 ffmpeg 转 WAV;没有 ffmpeg 时返回友好错误。 */
export async function transcribeDeepseek({
  endpoint = '',
  apiKey = '',
  model = '',
  audioUrl = '',
  fetchImpl,
  timeoutMs = 180_000,
  ffmpegPath = '',
  maxBytes = 25 * 1024 * 1024,
} = {}) {
  const base = str(endpoint).trim();
  if (!base) return { ok: false, channel: 'skip:unconfigured', text: '', error: 'no-endpoint' };
  if (!str(audioUrl).trim()) return { ok: false, channel: 'skip:error', text: '', error: 'no-audio-url' };
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: false, channel: 'skip:error', text: '', error: 'no-fetch' };
  let target;
  try {
    const u = new URL(base);
    if (/\/tools\/asr$/i.test(u.pathname)) target = u.toString();
    else if (/\/v\d+$/i.test(u.pathname)) target = u.toString() + '/tools/asr';
    else target = u.origin + '/v1/tools/asr';
  } catch {
    return { ok: false, channel: 'skip:error', text: '', error: 'bad-endpoint' };
  }
  const t = withTimeout(timeoutMs, 180_000);
  let dir = '';
  try {
    const audioRes = await fetchFn(str(audioUrl).trim(), { headers: BILI_HEADERS, signal: t.controller?.signal });
    if (!audioRes.ok) return { ok: false, channel: 'skip:error', text: '', error: `audio-http-${audioRes.status}` };
    const raw = Buffer.from(await audioRes.arrayBuffer());
    if (!raw.length) return { ok: false, channel: 'skip:error', text: '', error: 'empty-audio' };

    dir = await mkdtemp(join(tmpdir(), 'sm-asr-'));
    const inPath = join(dir, 'audio.m4s');
    const outPath = join(dir, 'audio.wav');
    await writeFile(inPath, raw);
    const bin = str(ffmpegPath).trim() || 'ffmpeg';
    const maxSec = Math.max(30, Math.floor(maxBytes / (16000 * 2)));
    const conv = await runProcess(bin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inPath, '-t', String(maxSec), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outPath,
    ], { timeoutMs: 120_000, env: process.env });
    if (conv.code !== 0) {
      const detail = String(conv.stderr || '').replace(/\s+/g, ' ').slice(0, 140);
      const missing = /ENOENT|not found|不是内部或外部命令/i.test(detail + conv.error);
      return {
        ok: false,
        channel: 'skip:error',
        text: '',
        error: missing ? 'no-ffmpeg' : `ffmpeg-${conv.code}${detail ? ':' + detail : ''}`,
      };
    }
    const wav = await readFile(outPath).catch(() => null);
    if (!wav || !wav.length) return { ok: false, channel: 'skip:error', text: '', error: 'empty-converted-audio' };

    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    if (str(model).trim()) form.append('model', str(model).trim());
    const headers = {};
    const key = str(apiKey).trim();
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetchFn(target, { method: 'POST', headers, body: form, signal: t.controller?.signal });
    const bodyText = await res.text().catch(() => '');
    if (!res.ok) {
      const detail = bodyText.replace(/\s+/g, ' ').slice(0, 140);
      return { ok: false, channel: 'skip:error', text: '', error: `http-${res.status}${detail ? ':' + detail : ''}` };
    }
    let data = {};
    try { data = JSON.parse(bodyText); } catch { data = {}; }
    const text = str(data?.text || data?.data?.text || '').trim();
    if (!text) return { ok: false, channel: 'skip:error', text: '', error: 'empty-transcript' };
    return { ok: true, channel: 'ok', text, segments: [] };
  } catch (err) {
    return { ok: false, channel: 'skip:error', text: '', error: err instanceof Error ? err.message : String(err) };
  } finally {
    t.done();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runProcess(command, args, { timeoutMs = 15_000, env } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      done({ code: 1, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } done({ code: 124, stdout, stderr, error: 'timeout' }); }, timeoutMs);
    child.stdout?.on('data', (c) => { stdout += c.toString(); });
    child.stderr?.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (err) => { clearTimeout(timer); done({ code: 1, stdout, stderr, error: err instanceof Error ? err.message : String(err) }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code: code ?? 1, stdout, stderr }); });
  });
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
