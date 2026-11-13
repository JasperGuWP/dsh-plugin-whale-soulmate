// Pet video cues — pure logic, zero I/O. Shared by asset-routes (manifest shipping)
// and mirrored verbatim in browser/pet-video.mjs (ModuleLoader cannot import ESM);
// test/pet-video.test.mjs runs ONE scenario table against BOTH copies.

/** video basename of a state, or null. Accepts "name" shorthand and { name, ... }. */
export function videoNameOf(st) {
  const v = st && st.video;
  if (typeof v === 'string') return v || null;
  if (v && typeof v === 'object' && typeof v.name === 'string' && v.name) return v.name;
  return null;
}

/** once inference: holdSec without dwellSec → once; explicit video.once overrides. */
export function isOnceState(st) {
  const v = st && st.video;
  if (v && typeof v === 'object' && typeof v.once === 'boolean') return v.once;
  return st != null && st.holdSec != null && st.dwellSec == null;
}

/** Weighted next pick — same algorithm as pet-machine.mjs update(). */
export function pickNextState(st, rand) {
  const next = (st && st.next) || {};
  const entries = Object.entries(next);
  if (!entries.length) return 'idle';
  let roll = rand();
  for (const [key, p] of entries) {
    if (roll < p) return key;
    roll -= p;
  }
  return 'idle';
}

/** ended cue: loop states ignore the event; once states advance via next. */
export function endedCue(states, name, rand) {
  const st = (states || {})[name];
  if (!st || !isOnceState(st)) return null;
  return pickNextState(st, rand);
}

/** WebKit needs HEVC-alpha .mov — Safari decodes VP9 but drops alpha (black box).
 *  iOS browsers are all WebKit and must win over the Chromium/Firefox exclusions.
 *  iPadOS 13+ masquerades as Macintosh: maxTouchPoints unmask it. */
export function prefersMov(ua, platform, maxTouchPoints) {
  const u = String(ua || '');
  if (/iPhone|iPad|iPod/i.test(u)) return true;
  if (/Chrome|Chromium|Edg|OPR|Firefox|FxiOS/i.test(u)) return false;
  const mac = /Mac/i.test(String(platform || '') || u);
  if (mac && Number(maxTouchPoints) > 1) return true;
  return mac;
}

/** Resolve the shipped video URL for a state. WebKit without a shipped .mov gets
 *  null (stay on PNG) — NEVER fall back to webm there: it renders a black box. */
export function videoUrlFor(manifest, state, wantMov) {
  const m = manifest || {};
  if (wantMov) return (m.videoMovUrls || {})[state] || null;
  return (m.videoUrls || {})[state] || null;
}
