// QR encoding for all soulmate surfaces (Bilibili passport / WeChat iLink / anything
// else). The host's module loader hands CJS packages to ESM `import default` with
// unstable interop — on the live DSH runtime `QRCode.toDataURL` came back undefined
// ("QRCode.toDataURL is not a function"), killing every QR image while the raw URLs
// still worked. Load via createRequire (same trick the official qqbot plugin uses)
// and unwrap `.default` defensively.

import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
let cachedApi;

function loadQrApi() {
  if (!cachedApi) {
    const mod = require_('qrcode');
    cachedApi = typeof mod?.toDataURL === 'function' ? mod : mod?.default;
    if (typeof cachedApi?.toDataURL !== 'function') {
      throw new Error('qrcode module loaded without toDataURL (interop failure)');
    }
  }
  return cachedApi;
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** data:image/png;base64,… for <img src>. */
export async function encodeQrDataUrl(text, { margin = 2, width = 200, dark = '#111111', light = '#ffffff' } = {}) {
  return loadQrApi().toDataURL(str(text), {
    margin,
    width,
    errorCorrectionLevel: 'M',
    color: { dark, light },
  });
}

/** Raw SVG string (callers may wrap it into a data URL themselves). */
export async function encodeQrSvgString(text, { margin = 2, width = 200, dark = '#111111', light = '#ffffff' } = {}) {
  const svg = await loadQrApi().toString(str(text), {
    type: 'svg',
    margin,
    width,
    errorCorrectionLevel: 'M',
    color: { dark, light },
  });
  if (typeof svg !== 'string' || !svg.trimStart().startsWith('<svg')) {
    throw new Error(`unexpected QRCode.toString result (${typeof svg})`);
  }
  return svg;
}