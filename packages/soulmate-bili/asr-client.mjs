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
    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
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
