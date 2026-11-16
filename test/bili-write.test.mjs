import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BILI_WRITE_ACTIONS, biliWriteAction } from '../packages/soulmate-bili/write-actions.mjs';
import { saveBiliCredentials } from '../packages/soulmate-bili/auth/credentials.mjs';
import { resolveSoulmateHome, saveConfigAuto } from '../packages/soulmate-core/state.mjs';
import { readPrivacyAudit } from '../packages/soulmate-core/privacy-firewall.mjs';

const SESSDATA = 'sess-write-secret-77';
const CSRF = 'csrf-write-secret-88';
const UID = '424242';
const T0 = Date.parse('2026-11-12T10:00:00Z');

async function withHome(fn, { writeEnabled = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-bili-write-'));
  const home = resolveSoulmateHome(dir);
  await mkdir(home.rootDir, { recursive: true });
  await saveBiliCredentials(home, { sessdata: SESSDATA, biliJct: CSRF, uid: UID, uname: '测试鲸' });
  if (writeEnabled) await saveConfigAuto(home, { extensions: { biliWriteEnabled: true } });
  try {
    return await fn(home, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Recording fetch mock: routes by method+path, captures form bodies. */
function makeNet(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    let form = null;
    if (typeof init.body === 'string' && (init.headers?.['content-type'] || '').includes('urlencoded')) {
      form = Object.fromEntries(new URLSearchParams(init.body));
    }
    calls.push({ key, url, form, headers: init.headers || {} });
    const handler = routes[key] || routes[u.pathname];
    const body = handler ? await handler({ url: u, form, init }) : { code: 0, data: {} };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

const videoView = { code: 0, data: { aid: 170001, cid: 270002, title: '测试视频' } };

test('write actions are gated off by default', async () => {
  await withHome(async (home) => {
    const res = await biliWriteAction(home, { action: 'like', bvid: 'BV1xx411c7mD' }, { nowMs: T0 });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'write_disabled');
  }, { writeEnabled: false });
});

test('write actions require credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-bili-write-nocred-'));
  const home = resolveSoulmateHome(dir);
  await mkdir(home.rootDir, { recursive: true });
  await saveConfigAuto(home, { extensions: { biliWriteEnabled: true } });
  try {
    const res = await biliWriteAction(home, { action: 'like', bvid: 'BV1xx411c7mD' }, { nowMs: T0 });
    assert.equal(res.code, 'no_credentials');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bad action is refused', async () => {
  await withHome(async (home) => {
    const res = await biliWriteAction(home, { action: 'hack' }, { nowMs: T0 });
    assert.equal(res.code, 'bad_action');
    assert.ok(BILI_WRITE_ACTIONS.includes('upload'));
    assert.ok(BILI_WRITE_ACTIONS.includes('live_start'));
  });
});

test('dm sends form with csrf + receiver, records ledger and audit', async () => {
  await withHome(async (home) => {
    const net = makeNet({ 'POST /web_im/v1/web_im/send_msg': () => ({ code: 0, data: {} }) });
    const res = await biliWriteAction(home, { action: 'dm', uid: '10086', message: '今天也一起看片吗？' }, { ...net, nowMs: T0 });
    assert.equal(res.ok, true);
    const call = net.calls.find((c) => c.key === 'POST /web_im/v1/web_im/send_msg');
    assert.equal(call.form['msg[receiver_id]'], '10086');
    assert.equal(call.form['msg[sender_uid]'], UID);
    assert.equal(call.form.csrf, CSRF);
    assert.ok(call.headers.cookie.includes(`SESSDATA=${SESSDATA}`));
    assert.ok(JSON.parse(call.form['msg[content]']).content.includes('一起看片'));
    assert.equal(res.writtenToday, 1);
    const audit = await readPrivacyAudit(home, 10);
    assert.ok(audit.some((a) => a.action === 'bili_write_dm'));
  });
});

test('dm outbound text passes the privacy firewall (secrets refused)', async () => {
  await withHome(async (home) => {
    const net = makeNet();
    const res = await biliWriteAction(home, { action: 'dm', uid: '10086', message: `我的 SESSDATA=${SESSDATA} 给你` }, { ...net, nowMs: T0 });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'privacy_blocked');
    assert.equal(net.calls.length, 0, 'nothing sent');
  });
});

test('comment resolves BV -> aid and posts reply/add', async () => {
  await withHome(async (home) => {
    const net = makeNet({
      'GET /x/web-interface/view': () => videoView,
      'POST /x/v2/reply/add': ({ form }) => {
        assert.equal(form.oid, '170001');
        assert.equal(form.type, '1');
        return { code: 0, data: { rpid: 555 } };
      },
    });
    const res = await biliWriteAction(home, { action: 'comment', target: 'https://www.bilibili.com/video/BV1xx411c7mD', message: '前排！' }, { ...net, nowMs: T0 });
    assert.equal(res.ok, true);
    assert.equal(res.rpid, 555);
  });
});

test('danmaku posts to dm/post with cid', async () => {
  await withHome(async (home) => {
    const net = makeNet({
      'GET /x/web-interface/view': () => videoView,
      'POST /x/v2/dm/post': ({ form }) => {
        assert.equal(form.oid, '270002');
        assert.equal(form.msg, 'awsl');
        return { code: 0, data: {} };
      },
    });
    const res = await biliWriteAction(home, { action: 'danmaku', bvid: 'BV1xx411c7mD', message: 'awsl' }, { ...net, nowMs: T0 });
    assert.equal(res.ok, true);
  });
});

test('like / coin / favorite / follow hit the right endpoints', async () => {
  await withHome(async (home) => {
    const net = makeNet({
      'GET /x/web-interface/view': () => videoView,
      'GET /x/v3/fav/folder/created/list-all': () => ({ code: 0, data: { list: [{ id: 9001 }] } }),
    });
    const like = await biliWriteAction(home, { action: 'like', bvid: 'BV1xx411c7mD' }, { ...net, nowMs: T0 });
    assert.equal(like.ok, true);
    assert.equal(net.calls.find((c) => c.key === 'POST /x/web-interface/archive/like').form.like, '1');
    const coin = await biliWriteAction(home, { action: 'coin', bvid: 'BV1xx411c7mD', multiply: 2 }, { ...net, nowMs: T0 + 60_000 });
    assert.equal(coin.ok, true);
    assert.equal(net.calls.find((c) => c.key === 'POST /x/web-interface/coin/add').form.multiply, '2');
    const fav = await biliWriteAction(home, { action: 'favorite', bvid: 'BV1xx411c7mD' }, { ...net, nowMs: T0 + 120_000 });
    assert.equal(fav.ok, true);
    assert.equal(fav.fid, 9001);
    assert.equal(net.calls.find((c) => c.key === 'POST /x/v3/fav/resource/deal').form.add_media_ids, '9001');
    const follow = await biliWriteAction(home, { action: 'follow', mid: '777' }, { ...net, nowMs: T0 + 180_000 });
    assert.equal(follow.ok, true);
    assert.equal(net.calls.find((c) => c.key === 'POST /x/relation/modify').form.act, '1');
    const unfollow = await biliWriteAction(home, { action: 'follow', mid: '777', unfollow: true }, { ...net, nowMs: T0 + 240_000 });
    assert.equal(unfollow.ok, true);
    assert.equal(net.calls.filter((c) => c.key === 'POST /x/relation/modify').pop().form.act, '2');
  });
});

test('daily quota and cooldown hold writes', async () => {
  await withHome(async (home) => {
    const net = makeNet({ 'GET /x/web-interface/view': () => videoView });
    const first = await biliWriteAction(home, { action: 'like', bvid: 'BV1xx411c7mD' }, { ...net, nowMs: T0, maxDailyWrites: 2 });
    assert.equal(first.ok, true);
    const soon = await biliWriteAction(home, { action: 'like', bvid: 'BV1xx411c7mD' }, { ...net, nowMs: T0 + 5_000, maxDailyWrites: 2 });
    assert.equal(soon.code, 'cooldown');
    const second = await biliWriteAction(home, { action: 'like', bvid: 'BV1xx411c7mD' }, { ...net, nowMs: T0 + 60_000, maxDailyWrites: 2 });
    assert.equal(second.ok, true);
    const third = await biliWriteAction(home, { action: 'like', bvid: 'BV1xx411c7mD' }, { ...net, nowMs: T0 + 120_000, maxDailyWrites: 2 });
    assert.equal(third.code, 'daily_limit');
  });
});

test('dryRun previews without sending or recording', async () => {
  await withHome(async (home) => {
    const net = makeNet();
    const res = await biliWriteAction(home, { action: 'comment', bvid: 'BV1xx411c7mD', message: '你好', dryRun: true }, { ...net, nowMs: T0 });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(net.calls.length, 0);
    const ledger = JSON.parse(await readFile(join(home.rootDir, 'bili-write-ledger.json'), 'utf8').catch(() => '{"writes":[]}'));
    assert.equal(ledger.writes.length, 0);
  });
});

test('profile update signs WBI params', async () => {
  await withHome(async (home) => {
    const img = '7cd084941338484aae1ad9425b84077c';
    const sub = '4932caff0ff746eab6f01bf08b70ac45';
    const net = makeNet({
      'GET /x/web-interface/nav': () => ({ code: 0, data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${img}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${sub}.png` } } }),
      'POST /x/member/web/profile/update': ({ form }) => {
        assert.ok(form.w_rid && /^[0-9a-f]{32}$/.test(form.w_rid));
        assert.ok(form.wts);
        assert.equal(form.uname, '新名字');
        return { code: 0, data: {} };
      },
    });
    const res = await biliWriteAction(home, { action: 'profile', uname: '新名字', sign: '好好生活' }, { ...net, nowMs: T0 });
    assert.equal(res.ok, true);
  });
});

test('live_start / live_stop speak the live protocol', async () => {
  await withHome(async (home) => {
    const net = makeNet({
      'POST /room/v1/Room/startLive': ({ form }) => {
        assert.equal(form.room_id, '123');
        assert.equal(form.area_v2, '9');
        return { code: 0, data: { rtmp: { addr: 'rtmp://x', code: '?key=SECRET-LIVE' }, live_key: 'SECRET-LIVE' } };
      },
      'POST /room/v1/Room/stopLive': () => ({ code: 0, data: {} }),
    });
    const start = await biliWriteAction(home, { action: 'live_start', roomId: 123, areaId: 9, liveTitle: '陪伴直播' }, { ...net, nowMs: T0 });
    assert.equal(start.ok, true);
    assert.equal(start.liveKey, '***', 'live key masked');
    const stop = await biliWriteAction(home, { action: 'live_stop', roomId: 123 }, { ...net, nowMs: T0 + 60_000 });
    assert.equal(stop.ok, true);
  });
});

test('upload runs preupload -> upos chunks -> submit', async () => {
  await withHome(async (home) => {
    const videoDir = await mkdtemp(join(tmpdir(), 'soulmate-bili-video-'));
    try {
      const file = join(videoDir, 'clip.mp4');
      await writeFile(file, Buffer.alloc(1024 * 1024 + 7, 7));
      const net = makeNet({
        'GET /preupload': () => ({ code: 0, data: { upos_uri: 'upos://ugcfx/clip.mp4', endpoint: 'upos.example.com', chunk_size: 512 * 1024, threads: 2, auth: 'AUTH', biz_id: 3 } }),
        'POST /ugcfx/clip.mp4': ({ url }) => (url.searchParams.has('uploads') ? { upload_id: 'UP1', OK: 1 } : { OK: 1 }),
        'PUT /ugcfx/clip.mp4': () => ({ OK: 1 }),
        'POST /x/vu/web/add': ({ form }) => {
          assert.ok(form.videos.includes('clip'));
          assert.equal(form.copyright, '1');
          assert.equal(form.desc, '联系 <PHONE>', 'the scrubbed desc is what actually gets submitted');
          assert.equal(form.title, '测试投稿');
          return { code: 0, data: { bvid: 'BV1up411c7xx', aid: 999 } };
        },
      });
      const res = await biliWriteAction(home, { action: 'upload', filePath: file, title: '测试投稿', desc: '联系 13812345678', tags: '生活,日常' }, { ...net, nowMs: T0 });
      assert.equal(res.ok, true, res.error);
      assert.equal(res.bvid, 'BV1up411c7xx');
      assert.equal(net.calls.filter((c) => c.key === 'PUT /ugcfx/clip.mp4').length, 3, '3 chunks');
    } finally {
      await rm(videoDir, { recursive: true, force: true });
    }
  });
});

test('upload guard: video files only, nothing from the soulmate data dir, secrets never leave', async () => {
  await withHome(async (home, dir) => {
    const net = makeNet({});
    const notes = join(dir, 'notes.txt');
    await writeFile(notes, '私有笔记');
    const wrongExt = await biliWriteAction(home, { action: 'upload', filePath: notes }, { ...net, nowMs: T0 });
    assert.equal(wrongExt.ok, false);
    assert.equal(wrongExt.code, 'bad_file');

    const inside = join(dir, 'sneaky.mp4');
    await writeFile(inside, 'not really a video');
    const fromHome = await biliWriteAction(home, { action: 'upload', filePath: inside }, { ...net, nowMs: T0 });
    assert.equal(fromHome.ok, false);
    assert.equal(fromHome.code, 'bad_file', 'files inside the soulmate data dir are never uploadable');

    const videoDir = await mkdtemp(join(tmpdir(), 'soulmate-bili-video-'));
    try {
      const file = join(videoDir, 'clip.mp4');
      await writeFile(file, Buffer.alloc(64, 1));
      const secret = await biliWriteAction(
        home,
        { action: 'upload', filePath: file, title: '投稿', desc: '部署用 sk-testonly-upload-leak-key01' },
        { ...net, nowMs: T0 }
      );
      assert.equal(secret.ok, false);
      assert.equal(secret.code, 'privacy_blocked');
      assert.equal(net.calls.length, 0, 'a blocked upload triggers no network I/O');
    } finally {
      await rm(videoDir, { recursive: true, force: true });
    }
  });
});

test('bilibili refusal surfaces honestly, secrets masked', async () => {
  await withHome(async (home) => {
    const net = makeNet({
      'GET /x/web-interface/view': () => videoView,
      'POST /x/web-interface/archive/like': () => ({ code: -101, message: `账号未登录 ${SESSDATA}` }),
    });
    const res = await biliWriteAction(home, { action: 'like', bvid: 'BV1xx411c7mD' }, { ...net, nowMs: T0 });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'write_failed');
    assert.ok(!res.error.includes(SESSDATA), 'secret masked in error');
  });
});
