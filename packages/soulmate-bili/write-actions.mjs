// Bilibili write-side actions: DM / comment / danmaku / like / coin / favorite /
// follow / profile / live-start / upload.
//
// Safety posture (same family as the share guardrails):
//   * Master switch `extensions.biliWriteEnabled` (default OFF) gates every write.
//   * Credentials live only in credentials.json (0600), never echoed; errors are masked.
//   * Outbound text passes the privacy firewall before it leaves the machine.
//   * Daily quota + minimum gap between writes, recorded in bili-write-ledger.json.
//   * Every write lands in the privacy audit log.
//   * Upload / live-start speak the real member / live protocols; when Bilibili's risk
//     control refuses, the error is surfaced honestly — never faked as success.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { atomicWriteJson, loadConfig, loadCredentials } from '../soulmate-core/state.mjs';
import { appendPrivacyAudit, inspectAndScrub } from '../soulmate-core/privacy-firewall.mjs';
import { cookieFromCredentials } from './auth/credentials.mjs';

export const BILI_WRITE_ACTIONS = Object.freeze([
  'dm', 'comment', 'danmaku', 'like', 'coin', 'favorite', 'follow', 'profile', 'live_start', 'live_stop', 'upload',
]);

export const WRITE_LIMITS = Object.freeze({
  maxDailyWrites: 20,
  minWriteGapMs: 30 * 1000,
});

// Bilibili only accepts video containers; the allowlist also keeps arbitrary local
// files (notes, configs, credentials) from being uploaded via a prompt-injected path.
const UPLOAD_EXTS = new Set(['.mp4', '.flv', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.ts', '.wmv', '.mpg', '.mpeg']);

const API_BASE = 'https://api.bilibili.com';
const VC_BASE = 'https://api.vc.bilibili.com';
const LIVE_BASE = 'https://api.live.bilibili.com';
const MEMBER_BASE = 'https://member.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 soulmate-bili/0.2';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const clip = (s, n) => {
  const t = str(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const errMsg = (err) => (err instanceof Error ? err.message : String(err));
const hold = (code, error, extra = {}) => ({ ok: false, held: true, code, error, ...extra });

const BV_RE = /(?<![0-9A-Za-z])[Bb][Vv]([0-9A-Za-z]{10})(?![0-9A-Za-z])/;
function parseBvid(input) {
  const m = str(input).match(BV_RE);
  return m ? `BV${m[1]}` : '';
}

function makeClient(options = {}, cookie = '') {
  const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('[soulmate-bili] no fetch implementation available');
  const timeoutMs = num(options.timeoutMs, 20_000);
  const headers = (extra = {}) => ({
    'user-agent': UA,
    referer: 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
    accept: 'application/json, text/plain, */*',
    ...(cookie ? { cookie } : {}),
    ...extra,
  });
  const request = async (url, init = {}) => {
    const res = await fetchImpl(url, {
      ...init,
      headers: headers(init.headers),
      signal: init.signal ?? (timeoutMs > 0 && typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined),
    });
    if (!res || typeof res.ok !== 'boolean') throw new Error('invalid fetch response');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  };
  const json = async (url, init) => (await request(url, init)).json();
  const api = async (base, path, params = {}, init) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    const body = await json(`${base}${path}${[...q].length ? `?${q}` : ''}`, init);
    if (!isObject(body)) throw new Error(`unexpected response from ${path}`);
    if (body.code !== undefined && body.code !== 0) throw new Error(`${path}: code ${body.code} ${str(body.message || body.msg)}`.trim());
    return body.data ?? body;
  };
  const form = async (url, fields) => {
    const body = await json(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams(fields).toString(),
    });
    if (!isObject(body) || (body.code !== undefined && body.code !== 0)) {
      throw new Error(`Bilibili 拒绝了请求：code ${body?.code} ${str(body?.message || body?.msg)}`.trim());
    }
    return body.data ?? body;
  };
  return { request, json, api, form };
}

// ---------------------------------------------------------------------------
// ledger / guards
// ---------------------------------------------------------------------------

const ledgerPath = (home) => join(home.rootDir, 'bili-write-ledger.json');

async function readLedger(home) {
  try {
    const data = JSON.parse(await readFile(ledgerPath(home), 'utf8'));
    return { writes: Array.isArray(data?.writes) ? data.writes.filter((w) => isObject(w) && Number.isFinite(w.at)) : [] };
  } catch {
    return { writes: [] };
  }
}

async function recordWrite(home, action, meta, nowMs) {
  const ledger = await readLedger(home);
  ledger.writes.push({ action, at: nowMs, atIso: new Date(nowMs).toISOString(), ...meta });
  ledger.writes = ledger.writes.filter((w) => nowMs - w.at < 30 * 24 * 3600 * 1000);
  await atomicWriteJson(ledgerPath(home), ledger);
}

/** Outbound text must pass the privacy firewall; secrets never leave the machine. */
async function scrubOutbound(home, action, text, maxChars) {
  const checked = inspectAndScrub(clip(str(text).trim(), maxChars));
  if (!checked.allowed) {
    await appendPrivacyAudit(home, { action: `bili_write_${action}_blocked`, reason: checked.blockedReason });
    return { blocked: true, reason: checked.blockedReason };
  }
  return { blocked: false, text: checked.scrubbedText };
}

// ---------------------------------------------------------------------------
// WBI signing (profile update requires w_rid / wts)
// ---------------------------------------------------------------------------

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

async function getMixinKey(client) {
  const data = await client.api(API_BASE, '/x/web-interface/nav');
  const wbi = data?.wbi_img ?? {};
  const keyOf = (u) => str(u).split('/').pop()?.split('.')[0] ?? '';
  const raw = keyOf(wbi.img_url) + keyOf(wbi.sub_url);
  return MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

async function signWbi(client, params) {
  const mixinKey = await getMixinKey(client);
  const wts = Math.floor(Date.now() / 1000);
  const sorted = Object.keys({ ...params, wts }).sort();
  const query = sorted
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String({ ...params, wts }[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return { ...params, wts, w_rid: createHash('md5').update(query + mixinKey).digest('hex') };
}

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------

/**
 * Run one Bilibili write action behind the guardrails.
 * input: { action, target?, bvid?, aid?, mid?, uid?, message?, text?, count?, multiply?,
 *          fid?, add?, remove?, uname?, sign?, liveTitle?, liveArea?, filePath?, title?, desc?, tags?, dryRun? }
 * options: { fetchImpl, timeoutMs, nowMs, maxDailyWrites, minWriteGapMs }
 */
export async function biliWriteAction(home, input = {}, options = {}) {
  const action = str(input.action).trim();
  if (!BILI_WRITE_ACTIONS.includes(action)) {
    return hold('bad_action', `action 只能是 ${BILI_WRITE_ACTIONS.join(' | ')}，收到 "${action}"`);
  }
  const nowMs = num(options.nowMs, Date.now());
  const conf = await loadConfig(home);
  const ext = conf.extensions ?? {};
  if (ext.biliWriteEnabled !== true && options.force !== true) {
    return hold('write_disabled', 'B 站写操作默认关闭：先在设置里打开「允许 B 站写操作」（extensions.biliWriteEnabled = true）并登录。');
  }

  const creds = await loadCredentials(home);
  const sessdata = str(creds.biliSessdata);
  const jct = str(creds.biliJct);
  const myUid = str(creds.biliUid);
  if (!sessdata || !jct) return hold('no_credentials', '还没有 B 站登录凭据（先扫码或填三个 Cookie 框）。');
  const cookie = await cookieFromCredentials(home);
  const client = makeClient(options, cookie);
  const mask = (s) => str(s).replaceAll(sessdata, '***').replaceAll(jct, '***');

  // quota + gap (dryRun previews skip the ledger but still show counters)
  const ledger = await readLedger(home);
  const dayAgo = nowMs - 24 * 3600 * 1000;
  const todayCount = ledger.writes.filter((w) => w.at > dayAgo).length;
  const maxDaily = clamp(Math.floor(num(options.maxDailyWrites ?? ext.biliMaxDailyWrites, WRITE_LIMITS.maxDailyWrites)), 1, 200);
  const minGap = Math.max(0, num(options.minWriteGapMs, WRITE_LIMITS.minWriteGapMs));
  const lastAny = ledger.writes.reduce((m, w) => Math.max(m, w.at), 0);
  if (input.dryRun !== true && options.dryRun !== true) {
    if (todayCount >= maxDaily) return hold('daily_limit', `今天已写 ${todayCount} 次（上限 ${maxDaily}），明天再说。`, { writtenToday: todayCount, maxDailyWrites: maxDaily });
    if (lastAny && nowMs - lastAny < minGap) {
      const waitSec = Math.ceil((minGap - (nowMs - lastAny)) / 1000);
      return hold('cooldown', `两次写操作至少间隔 ${minGap / 1000} 秒，还需等 ${waitSec} 秒。`, { retryAfterSec: waitSec });
    }
  }

  const resolveVideo = async () => {
    const bvid = str(input.bvid) || parseBvid(input.target);
    let aid = num(input.aid);
    let cid = num(input.cid);
    if (!bvid && !aid) return { error: '需要 bvid / target（视频链接或 BV 号）或 aid。' };
    if ((!aid || !cid) && bvid) {
      const view = await client.api(API_BASE, '/x/web-interface/view', { bvid });
      aid = num(view.aid);
      cid = num(view.cid);
    }
    return { bvid, aid, cid };
  };

  try {
    let result = null;
    let meta = {};

    if (action === 'dm') {
      const to = str(input.uid || input.to).trim();
      if (!/^\d+$/.test(to)) return hold('bad_target', '私信需要接收者 UID（纯数字）。');
      if (!/^\d+$/.test(myUid)) return hold('no_credentials', '私信需要自己的 UID（credentials 里的 biliUid）。');
      const scrub = await scrubOutbound(home, action, input.message ?? input.text, 480);
      if (scrub.blocked) return hold('privacy_blocked', `消息被隐私防火墙拦截：${scrub.reason}`);
      if (!scrub.text) return hold('empty_message', '私信内容不能为空。');
      if (input.dryRun === true || options.dryRun === true) return { ok: true, dryRun: true, action, to, message: scrub.text, writtenToday: todayCount, maxDailyWrites: maxDaily };
      await client.form(`${VC_BASE}/web_im/v1/web_im/send_msg`, {
        'msg[sender_uid]': myUid,
        'msg[receiver_id]': to,
        'msg[receiver_type]': '1',
        'msg[msg_type]': '1',
        'msg[msg_status]': '0',
        'msg[dev_id]': 'soulmate-' + myUid,
        'msg[timestamp]': String(Math.floor(nowMs / 1000)),
        'msg[new_face_version]': '0',
        'msg[content]': JSON.stringify({ content: scrub.text }),
        build: '0',
        mobi_app: 'web',
        csrf_token: jct,
        csrf: jct,
      });
      result = { ok: true, action, to, message: scrub.text };
      meta = { to };
    } else if (action === 'comment') {
      const scrub = await scrubOutbound(home, action, input.message ?? input.text, 900);
      if (scrub.blocked) return hold('privacy_blocked', `评论被隐私防火墙拦截：${scrub.reason}`);
      if (!scrub.text) return hold('empty_message', '评论内容不能为空。');
      const parent = str(input.parent || input.root || '').trim();
      const root = str(input.root || input.parent || '').trim();
      if (input.dryRun === true || options.dryRun === true) {
        return {
          ok: true, dryRun: true, action, bvid: str(input.bvid) || parseBvid(input.target),
          message: scrub.text, parent: parent || undefined, root: root || undefined,
          writtenToday: todayCount, maxDailyWrites: maxDaily,
        };
      }
      const v = await resolveVideo();
      if (v.error) return hold('no_target', v.error);
      const fields = { type: '1', oid: String(v.aid), message: scrub.text, plat: '1', csrf: jct };
      // Threaded reply: Bilibili expects parent (and often root) as rpid strings.
      if (/^\d+$/.test(parent)) fields.parent = parent;
      if (/^\d+$/.test(root)) fields.root = root;
      const data = await client.form(`${API_BASE}/x/v2/reply/add`, fields);
      result = { ok: true, action, bvid: v.bvid, rpid: num(data?.rpid), parent: fields.parent, root: fields.root };
      meta = { bvid: v.bvid, parent: fields.parent, root: fields.root };
    } else if (action === 'danmaku') {
      const scrub = await scrubOutbound(home, action, input.message ?? input.text, 100);
      if (scrub.blocked) return hold('privacy_blocked', `弹幕被隐私防火墙拦截：${scrub.reason}`);
      if (!scrub.text) return hold('empty_message', '弹幕内容不能为空。');
      if (input.dryRun === true || options.dryRun === true) return { ok: true, dryRun: true, action, bvid: str(input.bvid) || parseBvid(input.target), message: scrub.text, writtenToday: todayCount, maxDailyWrites: maxDaily };
      const v = await resolveVideo();
      if (v.error || !v.cid) return hold('no_target', v.error || '无法解析视频 cid。');
      await client.form(`${API_BASE}/x/v2/dm/post`, {
        type: '1',
        oid: String(v.cid),
        msg: scrub.text,
        bvid: v.bvid || '',
        progress: String(clamp(Math.floor(num(input.progressMs, 1500)), 0, 24 * 3600 * 1000)),
        color: String(num(input.color, 16777215)),
        fontsize: '25',
        pool: '0',
        mode: '1',
        plat: '1',
        csrf: jct,
      });
      result = { ok: true, action, bvid: v.bvid, message: scrub.text };
      meta = { bvid: v.bvid };
    } else if (action === 'like') {
      const like = input.unlike === true ? 2 : 1;
      if (input.dryRun === true || options.dryRun === true) return { ok: true, dryRun: true, action, bvid: str(input.bvid) || parseBvid(input.target), like, writtenToday: todayCount, maxDailyWrites: maxDaily };
      const v = await resolveVideo();
      if (v.error) return hold('no_target', v.error);
      await client.form(`${API_BASE}/x/web-interface/archive/like`, { bvid: v.bvid || '', aid: String(v.aid), like: String(like), csrf: jct });
      result = { ok: true, action, bvid: v.bvid, liked: like === 1 };
      meta = { bvid: v.bvid };
    } else if (action === 'coin') {
      const multiply = clamp(Math.floor(num(input.multiply ?? input.count, 1)), 1, 2);
      if (input.dryRun === true || options.dryRun === true) return { ok: true, dryRun: true, action, bvid: str(input.bvid) || parseBvid(input.target), multiply, writtenToday: todayCount, maxDailyWrites: maxDaily };
      const v = await resolveVideo();
      if (v.error) return hold('no_target', v.error);
      await client.form(`${API_BASE}/x/web-interface/coin/add`, { bvid: v.bvid || '', aid: String(v.aid), multiply: String(multiply), up_like: '1', csrf: jct });
      result = { ok: true, action, bvid: v.bvid, multiply };
      meta = { bvid: v.bvid };
    } else if (action === 'favorite') {
      const remove = input.remove === true;
      if (input.dryRun === true || options.dryRun === true) return { ok: true, dryRun: true, action, bvid: str(input.bvid) || parseBvid(input.target), fid: num(input.fid) || undefined, remove, writtenToday: todayCount, maxDailyWrites: maxDaily };
      const v = await resolveVideo();
      if (v.error) return hold('no_target', v.error);
      let fid = num(input.fid);
      if (!fid) {
        if (!/^\d+$/.test(myUid)) return hold('no_credentials', '收藏需要自己的 UID。');
        const folders = await client.api(API_BASE, '/x/v3/fav/folder/created/list-all', { up_mid: myUid });
        fid = num(folders?.list?.[0]?.id);
        if (!fid) return hold('no_folder', '账号下没有收藏夹，请先在 B 站创建一个。');
      }
      await client.form(`${API_BASE}/x/v3/fav/resource/deal`, {
        rid: String(v.aid),
        type: '2',
        add_media_ids: remove ? '' : String(fid),
        del_media_ids: remove ? String(fid) : '',
        csrf: jct,
      });
      result = { ok: true, action, bvid: v.bvid, fid, removed: remove };
      meta = { bvid: v.bvid, fid };
    } else if (action === 'follow') {
      const mid = str(input.mid || input.uid).trim();
      if (!/^\d+$/.test(mid)) return hold('bad_target', '关注需要对方 mid（纯数字）。');
      const unfollow = input.unfollow === true;
      if (input.dryRun === true || options.dryRun === true) return { ok: true, dryRun: true, action, mid, unfollow, writtenToday: todayCount, maxDailyWrites: maxDaily };
      await client.form(`${API_BASE}/x/relation/modify`, { fid: mid, act: unfollow ? '2' : '1', re_src: '11', csrf: jct });
      result = { ok: true, action, mid, followed: !unfollow };
      meta = { mid };
    } else if (action === 'profile') {
      const fields = {};
      if (input.uname !== undefined) fields.uname = clip(str(input.uname).trim(), 24);
      if (input.sign !== undefined) fields.user_sign = clip(str(input.sign).trim(), 70);
      if (!Object.keys(fields).length) return hold('nothing_to_change', 'profile 需要 uname 或 sign 至少一项。');
      for (const [k, v] of Object.entries(fields)) {
        const scrub = await scrubOutbound(home, action, v, 80);
        if (scrub.blocked) return hold('privacy_blocked', `资料被隐私防火墙拦截：${scrub.reason}`);
        fields[k] = scrub.text;
      }
      if (input.dryRun === true || options.dryRun === true) return { ok: true, dryRun: true, action, fields, writtenToday: todayCount, maxDailyWrites: maxDaily };
      const signed = await signWbi(client, fields);
      await client.form(`${API_BASE}/x/member/web/profile/update`, { ...signed, csrf: jct });
      result = { ok: true, action, fields };
      meta = { fields: Object.keys(fields) };
    } else if (action === 'live_start' || action === 'live_stop') {
      const starting = action === 'live_start';
      let roomId = num(input.roomId);
      let areaId = num(input.areaId ?? input.liveArea);
      let title = clip(str(input.liveTitle ?? input.title).trim(), 40);
      if (starting) {
        if (!roomId || !areaId || !title) {
          const init = await client.api(LIVE_BASE, '/room/v1/Room/get_status_info_by_uids', { uids: myUid }).catch(() => null);
          const mine = init?.[myUid] ?? Object.values(init ?? {})[0];
          roomId = roomId || num(mine?.room_id);
          areaId = areaId || num(mine?.area_v2_id);
          title = title || str(mine?.title) || '陪伴直播';
        }
        if (!roomId || !areaId) return hold('no_room', '拿不到直播间 / 分区：请先在 B 站完成主播实名并开通直播间，或显式传 roomId / areaId。');
        const scrub = await scrubOutbound(home, action, title, 40);
        if (scrub.blocked) return hold('privacy_blocked', `直播标题被隐私防火墙拦截：${scrub.reason}`);
        title = scrub.text;
      } else if (!roomId) {
        return hold('no_room', '下播需要 roomId。');
      }
      if (input.dryRun === true || options.dryRun === true) return { ok: true, dryRun: true, action, roomId, areaId, title, writtenToday: todayCount, maxDailyWrites: maxDaily };
      if (starting) {
        const data = await client.form(`${LIVE_BASE}/room/v1/Room/startLive`, {
          room_id: String(roomId),
          platform: 'pc',
          area_v2: String(areaId),
          title,
          csrf: jct,
          csrf_token: jct,
        });
        result = { ok: true, action, roomId, rtmp: data?.rtmp ?? null, liveKey: data?.live_key ? '***' : '' };
      } else {
        await client.form(`${LIVE_BASE}/room/v1/Room/stopLive`, { room_id: String(roomId), platform: 'pc', csrf: jct, csrf_token: jct });
        result = { ok: true, action, roomId };
      }
      meta = { roomId };
    } else if (action === 'upload') {
      const filePath = str(input.filePath).trim();
      if (!filePath) return hold('no_file', 'upload 需要本机视频文件路径 filePath。');
      // Prompt-injection guard: only video files, never anything inside the soulmate data dir
      // (credentials / memories live there and must not become uploadable bytes).
      const resolvedFile = resolve(filePath);
      const ext = extname(resolvedFile).toLowerCase();
      if (!UPLOAD_EXTS.has(ext)) return hold('bad_file', 'upload 只接受视频文件（mp4 / flv / mov / mkv / webm / avi 等）。');
      const homeRoot = resolve(home.rootDir).toLowerCase();
      const lowerFile = resolvedFile.toLowerCase();
      if (lowerFile === homeRoot || lowerFile.startsWith(homeRoot + sep.toLowerCase())) {
        return hold('bad_file', '不能上传 soulmate 数据目录内的文件。');
      }
      const buf = await readFile(resolvedFile).catch((err) => {
        throw new Error(`读不到文件：${errMsg(err)}`);
      });
      let title = clip(str(input.title).trim() || filePath.split(/[\\/]/).pop() || '投稿', 80);
      const scrubTitle = await scrubOutbound(home, action, title, 80);
      if (scrubTitle.blocked) return hold('privacy_blocked', `投稿标题被隐私防火墙拦截：${scrubTitle.reason}`);
      title = scrubTitle.text;
      const scrubDesc = await scrubOutbound(home, action, str(input.desc), 2000);
      if (scrubDesc.blocked) return hold('privacy_blocked', `投稿简介被隐私防火墙拦截：${scrubDesc.reason}`);
      const desc = scrubDesc.text;
      const scrubTags = await scrubOutbound(home, action, (Array.isArray(input.tags) ? input.tags.join(',') : str(input.tags)) || '生活,日常', 200);
      if (scrubTags.blocked) return hold('privacy_blocked', `投稿标签被隐私防火墙拦截：${scrubTags.reason}`);
      const tags = scrubTags.text;
      if (input.dryRun === true || options.dryRun === true) {
        return { ok: true, dryRun: true, action, title, bytes: buf.length, writtenToday: todayCount, maxDailyWrites: maxDaily };
      }
      // 1) preupload: ask member for the upload endpoint
      const pre = await client.api(MEMBER_BASE, '/preupload', {
        name: filePath.split(/[\\/]/).pop() || 'video.mp4',
        size: String(buf.length),
        r: 'upos',
        profile: 'ugcfx/bup',
        ssl: '1',
        version: '2.14.0.0',
        build: '2140000',
      });
      const uposUri = str(pre?.upos_uri).replace(/^upos:\/\//, '');
      const endpoint = str(pre?.endpoint);
      const chunkSize = num(pre?.chunk_size, 4 * 1024 * 1024);
      const threads = Math.max(1, num(pre?.threads, 1));
      if (!uposUri || !endpoint) throw new Error('preupload 未返回上传地址（可能被风控）。');
      const auth = str(pre?.auth);
      const bizId = num(pre?.biz_id);
      const uposHost = `https://${endpoint.replace(/^https?:\/\//, '')}`;
      const uposPath = `/${uposUri}`;
      // 2) init uploads -> upload_id
      const initRes = await client.json(`${uposHost}${uposPath}?uploads&output=json`, {
        method: 'POST',
        headers: { 'x-upos-auth': auth },
      });
      const uploadId = str(initRes?.upload_id);
      if (!uploadId) throw new Error('upos 初始化失败（无 upload_id）。');
      // 3) chunks
      const totalChunks = Math.ceil(buf.length / chunkSize);
      for (let i = 0; i < totalChunks; i += 1) {
        const part = buf.subarray(i * chunkSize, Math.min(buf.length, (i + 1) * chunkSize));
        const chunkUrl = `${uposHost}${uposPath}?partNumber=${i + 1}&uploadId=${encodeURIComponent(uploadId)}&chunk=${i}&chunks=${totalChunks}&size=${part.length}&start=${i * chunkSize}&end=${Math.min(buf.length, (i + 1) * chunkSize)}&total=${buf.length}`;
        await client.request(chunkUrl, { method: 'PUT', headers: { 'x-upos-auth': auth, 'content-type': 'application/octet-stream' }, body: part });
      }
      // 4) finalize
      const endRes = await client.json(`${uposHost}${uposPath}?output=json&name=${encodeURIComponent(filePath.split(/[\\/]/).pop() || 'video.mp4')}&profile=ugcfx%2Fbup&uploadId=${encodeURIComponent(uploadId)}&biz_id=${bizId}&chunk=${totalChunks - 1}&chunks=${totalChunks}`, {
        method: 'POST',
        headers: { 'x-upos-auth': auth },
      });
      if (endRes?.OK !== 1 && endRes?.ok !== 1) throw new Error(`upos 收尾失败：${str(endRes?.message || JSON.stringify(endRes).slice(0, 120))}`);
      // 5) submit the archive
      const filename = uposUri.split('/').pop()?.split('.')[0] ?? '';
      const submitted = await client.form(`${MEMBER_BASE}/x/vu/web/add`, {
        csrf: jct,
        ...(await signWbi(client, {})),
        copyright: '1',
        source: '',
        tid: String(num(input.tid, 171)),
        tag: clip(tags, 200),
        desc_format_id: '0',
        desc: clip(desc, 2000),
        dynamic: '',
        title,
        videos: JSON.stringify([{ filename, title: title.slice(0, 80), desc: '' }]),
      });
      result = { ok: true, action, title, bvid: str(submitted?.bvid), aid: num(submitted?.aid), bytes: buf.length, threads };
      meta = { bvid: str(submitted?.bvid) };
    }

    if (!result) return hold('bad_action', `未实现的 action：${action}`);
    if (input.dryRun !== true && options.dryRun !== true) {
      await recordWrite(home, action, meta, nowMs);
      await appendPrivacyAudit(home, { action: `bili_write_${action}`, ...meta });
    }
    return { ...result, writtenToday: todayCount + 1, maxDailyWrites: maxDaily };
  } catch (err) {
    return { ok: false, code: 'write_failed', action, error: `B 站写操作失败：${mask(errMsg(err))}` };
  }
}
