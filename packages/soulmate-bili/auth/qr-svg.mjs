// QR image helpers for Bilibili passport login. Encoding lives in soulmate-core's
// qr-encode (createRequire-based — the host loader's ESM default import of the CJS
// `qrcode` package lost toDataURL on the live runtime).
import { encodeQrDataUrl as coreDataUrl, encodeQrSvgString } from '../../soulmate-core/qr-encode.mjs';

/**
 * @returns {Promise<{ svg: string }>}
 */
export async function encodeQrSvg(text, opts = {}) {
  return { svg: await encodeQrSvgString(text, opts) };
}

/** data:image/png;base64,… — convenient for <img src>. */
export async function encodeQrDataUrl(text, opts = {}) {
  return coreDataUrl(text, opts);
}