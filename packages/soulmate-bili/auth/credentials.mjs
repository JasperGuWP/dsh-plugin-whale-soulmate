// Bilibili credential slice of ~/.dsh/soulmate/credentials.json (mode 0600).
// Public APIs never echo SESSDATA / bili_jct.
import { atomicWriteJson, loadConfig, loadCredentials, maskKey } from '../../soulmate-core/state.mjs';
import { buildBiliCookieHeader } from './cookie.mjs';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

const BILI_KEYS = Object.freeze(['biliSessdata', 'biliJct', 'biliUid', 'biliUname', 'biliBuvid3']);

const credQueues = new Map();
function withCredLock(path, fn) {
  const prev = credQueues.get(path) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  credQueues.set(path, next);
  const cleanup = () => {
    if (credQueues.get(path) === next) credQueues.delete(path);
  };
  next.then(cleanup, cleanup);
  return next;
}

/** Raw fields for internal network use only — never hand to tools/routes. */
export async function loadBiliCredentialFields(home) {
  const disk = await loadCredentials(home);
  return {
    sessdata: str(disk.biliSessdata),
    biliJct: str(disk.biliJct),
    uid: str(disk.biliUid),
    uname: str(disk.biliUname),
    buvid3: str(disk.biliBuvid3),
  };
}

export async function cookieFromCredentials(home) {
  try {
    const c = await loadBiliCredentialFields(home);
    return buildBiliCookieHeader(c);
  } catch {
    return '';
  }
}

/**
 * Store Bilibili login material in credentials.json only (0600). Never echoed anywhere.
 * Compatible with legacy callers: `{ sessdata, biliJct, uid }` (+ optional uname / buvid3).
 */
export async function saveBiliCredentials(home, { sessdata, biliJct, uid, uname, buvid3 } = {}) {
  let snapshot = { hasSessdata: false, hasCsrf: false, hasUid: false };
  await withCredLock(home.credentialsPath, async () => {
    const current = await loadCredentials(home);
    const next = { ...current };
    if (sessdata !== undefined) next.biliSessdata = str(sessdata);
    if (biliJct !== undefined) next.biliJct = str(biliJct);
    if (uid !== undefined) next.biliUid = str(uid);
    if (uname !== undefined) next.biliUname = str(uname);
    if (buvid3 !== undefined) next.biliBuvid3 = str(buvid3);
    await atomicWriteJson(home.credentialsPath, next, { mode: 0o600 });
    snapshot = {
      hasSessdata: Boolean(next.biliSessdata),
      hasCsrf: Boolean(next.biliJct),
      hasUid: Boolean(next.biliUid),
    };
  });
  return { ok: true, ...snapshot };
}

export async function clearBiliCredentials(home) {
  await withCredLock(home.credentialsPath, async () => {
    const current = await loadCredentials(home);
    const next = { ...current };
    for (const key of BILI_KEYS) delete next[key];
    await atomicWriteJson(home.credentialsPath, next, { mode: 0o600 });
  });
  return { ok: true, loggedIn: false, hasSessdata: false, hasCsrf: false };
}

/** Masked overview — safe for tools / HTTP / panel. */
export async function getBiliAuthStatus(home) {
  const [conf, fields] = await Promise.all([loadConfig(home), loadBiliCredentialFields(home)]);
  const ext = conf.extensions ?? {};
  const loggedIn = Boolean(fields.sessdata && fields.biliJct);
  let ffmpegReady = false;
  let ffmpegVersion = '';
  let ffmpegError = '';
  try {
    const { probeFfmpeg } = await import('../live-frames.mjs');
    const probe = await probeFfmpeg({ ffmpegPath: ext.biliFfmpegPath });
    ffmpegReady = probe.ok === true;
    ffmpegVersion = probe.version || '';
    ffmpegError = probe.ok ? '' : (probe.error || 'not-found');
  } catch (err) {
    ffmpegError = err instanceof Error ? err.message : String(err);
  }
  const liveOn = ext.biliLiveFrameWatch === true;
  let liveFrameWatchBlockedReason = '';
  if (liveOn && !loggedIn) liveFrameWatchBlockedReason = 'not-logged-in';
  else if (liveOn && !ffmpegReady) liveFrameWatchBlockedReason = 'no-ffmpeg';
  return {
    ok: true,
    loggedIn,
    hasSessdata: Boolean(fields.sessdata),
    hasCsrf: Boolean(fields.biliJct),
    hasUid: Boolean(fields.uid),
    uidMasked: maskKey(fields.uid),
    uname: fields.uname ? str(fields.uname).slice(0, 32) : '',
    biliEnabled: ext.biliEnabled !== false,
    biliShareEnabled: ext.biliShareEnabled === true,
    biliShareVia: ext.biliShareVia === 'comment' ? 'comment' : 'dm',
    biliTargetUserMasked: maskKey(str(ext.biliTargetUser)),
    ffmpegReady,
    ffmpegVersion,
    ffmpegError,
    liveFrameWatchEnabled: liveOn,
    liveFrameEverySec: Number(ext.biliLiveFrameEverySec) || 30,
    liveFrameWatchBlockedReason,
  };
}
