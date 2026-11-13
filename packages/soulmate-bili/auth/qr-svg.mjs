// QR image helpers for Bilibili passport login (wraps `qrcode`, same stack as dsh-bili-whale).
import QRCode from 'qrcode';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * @returns {Promise<{ svg: string }>}
 */
export async function encodeQrSvg(text, { margin = 2, width = 200, dark = '#111111', light = '#ffffff' } = {}) {
  const svg = await QRCode.toString(str(text), {
    type: 'svg',
    margin,
    width,
    errorCorrectionLevel: 'M',
    color: { dark, light },
  });
  return { svg };
}

/** data:image/png;base64,… — convenient for <img src>. */
export async function encodeQrDataUrl(text, { margin = 2, width = 200, dark = '#111111', light = '#ffffff' } = {}) {
  return QRCode.toDataURL(str(text), {
    margin,
    width,
    errorCorrectionLevel: 'M',
    color: { dark, light },
  });
}
