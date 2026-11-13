// Inflated ♂/♀ balloon sprites — faithful port of the approved reference
// D:\agent\gender-balloons\index.html (rubber-balloon material, cream card look).
// The symbol is stroked into an alpha mask, blurred into a height field, then lit
// per-pixel (diffuse + two speculars + rim) so it reads as a real inflated tube.
// Sprites are cached per gender+color; minis are painted once, CSS does the bobbing.

const SPR = 420;

const DEFAULT_COLORS = { male: '#38a1ff', female: '#ff5fa2' };

function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function palette(hex) {
  const hsl = hexToHsl(hex);
  const h = hsl[0];
  const s = Math.max(72, hsl[1]);
  const l = hsl[2];
  return {
    a: hslToRgb(h - 16, s, Math.min(88, l + 22)),
    b: hslToRgb(h + 12, s, Math.max(30, l - 8)),
    rim: hslToRgb(h - 38, Math.max(40, s - 12), Math.min(92, l + 30)),
  };
}

// Symbol geometry in a 200x200 design space (same paths as the reference).
function circle(cx, cy, r) {
  const pts = [];
  const n = 72;
  for (let i = 0; i <= n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

const GEO = {
  male: { off: [-4, -6], paths: [circle(86, 116, 44), [[117, 85], [152, 50]], [[120, 50], [152, 50], [152, 82]]] },
  female: { off: [0, -12], paths: [circle(100, 78, 44), [[100, 122], [100, 176]], [[70, 150], [130, 150]]] },
};

// Separable box blur x3 ≈ gaussian; turns the stroke mask into a height field.
function boxH(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x += 1) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x += 1) {
      dst[row + x] = sum * inv;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
}

function boxV(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let x = 0; x < w; x += 1) {
    let sum = 0;
    for (let y = -r; y <= r; y += 1) sum += src[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y += 1) {
      dst[y * w + x] = sum * inv;
      sum += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
    }
  }
}

let tmpA = null;
let tmpB = null;
function blur3(src, w, h, r) {
  if (r < 1) return src.slice();
  if (!tmpA || tmpA.length !== w * h) {
    tmpA = new Float32Array(w * h);
    tmpB = new Float32Array(w * h);
  }
  boxH(src, tmpA, w, h, r);
  boxV(tmpA, tmpB, w, h, r);
  boxH(tmpB, tmpA, w, h, r);
  boxV(tmpA, tmpB, w, h, r);
  boxH(tmpB, tmpA, w, h, r);
  boxV(tmpA, tmpB, w, h, r);
  return tmpB;
}

let maskCv = null;
let maskCtx = null;
const cache = new Map();

/** Render (or fetch cached) inflated symbol sprite for gender + hex color. */
function balloonSprite(gender, color) {
  const hex = color || DEFAULT_COLORS[gender] || DEFAULT_COLORS.male;
  const key = gender + ':' + hex;
  if (cache.has(key)) return cache.get(key);

  const S = SPR;
  const sc = S / 200;
  const geo = GEO[gender] || GEO.male;
  const puff = 1;
  const gloss = 0.9;
  const width = (16 + 10 * puff) * sc;

  if (!maskCv) {
    maskCv = document.createElement('canvas');
    maskCv.width = maskCv.height = S;
    maskCtx = maskCv.getContext('2d', { willReadFrequently: true });
  }
  maskCtx.clearRect(0, 0, S, S);
  maskCtx.strokeStyle = '#fff';
  maskCtx.lineWidth = width;
  maskCtx.lineCap = 'round';
  maskCtx.lineJoin = 'round';
  geo.paths.forEach((pts) => {
    maskCtx.beginPath();
    pts.forEach((p, i) => {
      const x = (p[0] + geo.off[0]) * sc;
      const y = (p[1] + geo.off[1]) * sc;
      if (i) maskCtx.lineTo(x, y);
      else maskCtx.moveTo(x, y);
    });
    maskCtx.stroke();
  });

  const data = maskCtx.getImageData(0, 0, S, S).data;
  const a = new Float32Array(S * S);
  for (let i = 0; i < S * S; i += 1) a[i] = data[i * 4 + 3] / 255;
  const r = Math.max(2, Math.round((width / 2) * (0.30 + 0.42 * puff)));
  const hgt = blur3(a, S, S, r);
  const k = r * (2.6 + 2.4 * puff);
  const pal = palette(hex);

  const az = (225 * Math.PI) / 180;
  const el = (52 * Math.PI) / 180;
  const Lx = Math.cos(az) * Math.cos(el);
  const Ly = Math.sin(az) * Math.cos(el);
  const Lz = Math.sin(el);
  let hx = Lx;
  let hy = Ly;
  let hz = Lz + 1;
  const hl = Math.hypot(hx, hy, hz);
  hx /= hl; hy /= hl; hz /= hl;
  let h2x = -0.45;
  let h2y = -0.6;
  let h2z = 0.66 + 1;
  const h2l = Math.hypot(h2x, h2y, h2z);
  h2x /= h2l; h2y /= h2l; h2z /= h2l;
  const shin = 18 + 70 * gloss;

  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const out = ctx.createImageData(S, S);
  const od = out.data;
  for (let y = 0; y < S; y += 1) {
    const yw = y * S;
    for (let x = 0; x < S; x += 1) {
      const idx = yw + x;
      const al = a[idx];
      if (al < 0.004) continue;
      const xl = hgt[yw + Math.max(0, x - 1)];
      const xr = hgt[yw + Math.min(S - 1, x + 1)];
      const yu = hgt[Math.max(0, y - 1) * S + x];
      const yd = hgt[Math.min(S - 1, y + 1) * S + x];
      let nx = (xl - xr) * k;
      let ny = (yu - yd) * k;
      let nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv; nz = inv;
      const diff = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
      const sp = Math.pow(Math.max(0, nx * hx + ny * hy + nz * hz), shin);
      const sp2 = Math.pow(Math.max(0, nx * h2x + ny * h2y + nz * h2z), 7);
      const rim = Math.pow(1 - nz, 2.0);
      const t = (x / S) * 0.5 + (y / S) * 0.5;
      const br = pal.a[0] + (pal.b[0] - pal.a[0]) * t;
      const bg = pal.a[1] + (pal.b[1] - pal.a[1]) * t;
      const bb = pal.a[2] + (pal.b[2] - pal.a[2]) * t;
      const amb = 0.62 + 0.38 * (1 - y / S);
      const lit = amb * (0.42 + 0.80 * diff);
      const spec = 255 * (sp * gloss + sp2 * 0.10 * gloss);
      const o = idx * 4;
      od[o] = Math.min(255, br * lit + spec + pal.rim[0] * rim * 0.22);
      od[o + 1] = Math.min(255, bg * lit + spec + pal.rim[1] * rim * 0.22);
      od[o + 2] = Math.min(255, bb * lit + spec + pal.rim[2] * rim * 0.22);
      od[o + 3] = Math.min(255, al * 255);
    }
  }
  ctx.putImageData(out, 0, 0);
  // Two soft gloss passes on top of the lit tube.
  ctx.globalCompositeOperation = 'source-atop';
  const g1 = ctx.createRadialGradient(S * 0.34, S * 0.26, 0, S * 0.34, S * 0.26, S * 0.34);
  g1.addColorStop(0, 'rgba(255,255,255,' + 0.22 * Math.min(1, gloss) + ')');
  g1.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, S, S);
  const g2 = ctx.createRadialGradient(S * 0.68, S * 0.74, 0, S * 0.68, S * 0.74, S * 0.3);
  g2.addColorStop(0, 'rgba(255,255,255,' + 0.10 * Math.min(1, gloss) + ')');
  g2.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';

  cache.set(key, cv);
  return cv;
}

/** Paint the sprite into a mini canvas (156x156 backing, 78px CSS like the reference). */
function paintBalloonMini(canvas, gender, color) {
  const sprite = balloonSprite(gender, color);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(sprite, 6, 6, canvas.width - 12, canvas.height - 12);
}

module.exports = { DEFAULT_COLORS, balloonSprite, paintBalloonMini };
