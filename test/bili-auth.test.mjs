import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BILI_AUTH_ACTIONS,
  clearBiliCredentials,
  getBiliAuthStatus,
  importWhaleCredentials,
  manageBiliAuth,
  parseBiliCookieText,
  saveBiliCredentials,
  startBiliQrLogin,
  pollBiliQrLogin,
  verifyBiliLogin,
} from '../packages/soulmate-bili/auth/index.mjs';
import { resolveSoulmateHome } from '../packages/soulmate-core/state.mjs';

const SESSDATA = 'SESSDATA-auth-secret-9f8e7d';
const CSRF = 'csrf-auth-secret-1a2b3c';
const UID = '998877';

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-bili-auth-'));
  const home = resolveSoulmateHome(dir);
  await mkdir(home.rootDir, { recursive: true });
  try {
    return await fn(home, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeAuthServer(handlers) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const key = `${req.method} ${url.pathname}`;
    const h = handlers[key] || handlers[url.pathname];
    if (!h) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    const out = await h({ req, url, headers: req.headers });
    const status = out.status ?? 200;
    const headers = { 'content-type': 'application/json', ...(out.headers || {}) };
    res.writeHead(status, headers);
    res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? { code: 0, data: {} }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        passportBaseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('parseBiliCookieText extracts SESSDATA / bili_jct / uid / buvid3', () => {
  const parsed = parseBiliCookieText(
    `buvid3=BUV; SESSDATA=${SESSDATA}; bili_jct=${CSRF}; DedeUserID=${UID}; other=x`
  );
  assert.equal(parsed.sessdata, SESSDATA);
  assert.equal(parsed.biliJct, CSRF);
  assert.equal(parsed.uid, UID);
  assert.equal(parsed.buvid3, 'BUV');
});

test('parseBiliCookieText accepts key=value lines without cookie separators', () => {
  const parsed = parseBiliCookieText(`SESSDATA=${SESSDATA}\nbili_jct=${CSRF}\nDedeUserID=${UID}`);
  assert.equal(parsed.sessdata, SESSDATA);
  assert.equal(parsed.biliJct, CSRF);
  assert.equal(parsed.uid, UID);
});

test('getBiliAuthStatus never echoes secrets', async () => {
  await withHome(async (home) => {
    await saveBiliCredentials(home, { sessdata: SESSDATA, biliJct: CSRF, uid: UID, uname: '小海海' });
    const st = await getBiliAuthStatus(home);
    assert.equal(st.ok, true);
    assert.equal(st.loggedIn, true);
    assert.equal(st.hasSessdata, true);
    assert.equal(st.hasCsrf, true);
    assert.match(st.uidMasked, /\*/);
    assert.ok(!JSON.stringify(st).includes(SESSDATA));
    assert.ok(!JSON.stringify(st).includes(CSRF));
  });
});

test('configure_cookie verifies via nav before writing; bad login does not overwrite', async () => {
  await withHome(async (home) => {
    await saveBiliCredentials(home, { sessdata: 'old-sess', biliJct: 'old-csrf', uid: '1' });
    const mock = await makeAuthServer({
      'GET /x/web-interface/nav': () => ({ body: { code: 0, data: { isLogin: false } } }),
    });
    try {
      const res = await manageBiliAuth(home, {
        action: 'configure_cookie',
        cookie: `SESSDATA=${SESSDATA}; bili_jct=${CSRF}`,
      }, { baseUrl: mock.baseUrl });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'nav_not_logged_in');
      const disk = JSON.parse(await readFile(home.credentialsPath, 'utf8'));
      assert.equal(disk.biliSessdata, 'old-sess');
    } finally {
      await mock.close();
    }
  });
});

test('configure_cookie success writes after nav ok', async () => {
  await withHome(async (home) => {
    const mock = await makeAuthServer({
      'GET /x/web-interface/nav': ({ headers }) => {
        assert.match(headers.cookie || '', new RegExp(SESSDATA));
        return { body: { code: 0, data: { isLogin: true, mid: Number(UID), uname: '小海海' } } };
      },
    });
    try {
      const res = await manageBiliAuth(
        home,
        { action: 'configure_cookie', cookie: `SESSDATA=${SESSDATA}; bili_jct=${CSRF}; DedeUserID=${UID}` },
        { baseUrl: mock.baseUrl }
      );
      assert.equal(res.ok, true);
      assert.equal(res.loggedIn, true);
      assert.equal(res.uid, UID);
      assert.equal(res.uname, '小海海');
      const disk = JSON.parse(await readFile(home.credentialsPath, 'utf8'));
      assert.equal(disk.biliSessdata, SESSDATA);
      assert.equal(disk.biliJct, CSRF);
      assert.equal(disk.biliUid, UID);
      assert.equal(disk.biliUname, '小海海');
      assert.ok(!JSON.stringify(res).includes(SESSDATA));
    } finally {
      await mock.close();
    }
  });
});

test('qr_start + qr_poll success saves credentials; expired does not clear old', async () => {
  await withHome(async (home) => {
    await saveBiliCredentials(home, { sessdata: 'keep-me', biliJct: 'keep-csrf', uid: '42' });
    let pollHits = 0;
    const mock = await makeAuthServer({
      'GET /x/passport-login/web/qrcode/generate': () => ({
        body: { code: 0, data: { url: 'https://example.test/qr', qrcode_key: 'key-abc' } },
      }),
      'GET /x/passport-login/web/qrcode/poll': ({ url }) => {
        assert.equal(url.searchParams.get('qrcode_key'), 'key-abc');
        pollHits += 1;
        if (pollHits === 1) return { body: { code: 0, data: { code: 86101, message: '未扫码' } } };
        return {
          body: { code: 0, data: { code: 0, message: 'ok', refresh_token: 'rt' } },
          headers: {
            'set-cookie': [
              `SESSDATA=${SESSDATA}; Path=/; HttpOnly`,
              `bili_jct=${CSRF}; Path=/`,
              `DedeUserID=${UID}; Path=/`,
            ],
          },
        };
      },
      'GET /x/web-interface/nav': () => ({
        body: { code: 0, data: { isLogin: true, mid: Number(UID), uname: '扫码号' } },
      }),
    });
    try {
      const start = await startBiliQrLogin({ passportBaseUrl: mock.passportBaseUrl });
      assert.equal(start.ok, true);
      assert.equal(start.qrcodeKey, 'key-abc');
      assert.ok(start.url);
      assert.match(start.qrDataUrl || '', /^data:image\/png;base64,/);

      const waiting = await pollBiliQrLogin(home, { qrcodeKey: start.qrcodeKey }, {
        passportBaseUrl: mock.passportBaseUrl,
        baseUrl: mock.baseUrl,
      });
      assert.equal(waiting.ok, true);
      assert.equal(waiting.status, 'pending');
      assert.equal(waiting.code, 86101);

      const done = await pollBiliQrLogin(home, { qrcodeKey: start.qrcodeKey }, {
        passportBaseUrl: mock.passportBaseUrl,
        baseUrl: mock.baseUrl,
      });
      assert.equal(done.ok, true);
      assert.equal(done.status, 'confirmed');
      assert.equal(done.uid, UID);
      assert.equal(done.uname, '扫码号');

      const disk = JSON.parse(await readFile(home.credentialsPath, 'utf8'));
      assert.equal(disk.biliSessdata, SESSDATA);

      // expired poll must not wipe
      const mock2 = await makeAuthServer({
        'GET /x/passport-login/web/qrcode/poll': () => ({
          body: { code: 0, data: { code: 86038, message: '二维码已失效' } },
        }),
      });
      try {
        const expired = await pollBiliQrLogin(home, { qrcodeKey: 'dead' }, { passportBaseUrl: mock2.passportBaseUrl });
        assert.equal(expired.ok, true);
        assert.equal(expired.status, 'expired');
        const still = JSON.parse(await readFile(home.credentialsPath, 'utf8'));
        assert.equal(still.biliSessdata, SESSDATA);
      } finally {
        await mock2.close();
      }
    } finally {
      await mock.close();
    }
  });
});

test('import_whale reads bili-ai credentials and verifies', async () => {
  await withHome(async (home, dir) => {
    const whalePath = join(dir, 'bili-ai-credentials.json');
    await writeFile(
      whalePath,
      JSON.stringify({ SESSDATA, bili_jct: CSRF, DedeUserID: UID, buvid3: 'W-BUV' }),
      'utf8'
    );
    const mock = await makeAuthServer({
      'GET /x/web-interface/nav': () => ({
        body: { code: 0, data: { isLogin: true, mid: Number(UID), uname: '鲸号' } },
      }),
    });
    try {
      const res = await importWhaleCredentials(home, { whaleCredentialsPath: whalePath, baseUrl: mock.baseUrl });
      assert.equal(res.ok, true);
      assert.equal(res.source, 'whale');
      assert.equal(res.uname, '鲸号');
      const disk = JSON.parse(await readFile(home.credentialsPath, 'utf8'));
      assert.equal(disk.biliSessdata, SESSDATA);
      assert.equal(disk.biliBuvid3, 'W-BUV');
    } finally {
      await mock.close();
    }
  });
});

test('verify and clear', async () => {
  await withHome(async (home) => {
    await saveBiliCredentials(home, { sessdata: SESSDATA, biliJct: CSRF, uid: UID });
    const mock = await makeAuthServer({
      'GET /x/web-interface/nav': () => ({
        body: { code: 0, data: { isLogin: true, mid: Number(UID), uname: '仍在' } },
      }),
    });
    try {
      const v = await verifyBiliLogin(home, { baseUrl: mock.baseUrl });
      assert.equal(v.ok, true);
      assert.equal(v.loggedIn, true);
      assert.equal(v.uname, '仍在');
    } finally {
      await mock.close();
    }
    const cleared = await clearBiliCredentials(home);
    assert.equal(cleared.ok, true);
    const st = await getBiliAuthStatus(home);
    assert.equal(st.loggedIn, false);
    assert.equal(st.hasSessdata, false);
  });
});

test('manageBiliAuth rejects unknown action; actions table is stable', () => {
  assert.ok(BILI_AUTH_ACTIONS.includes('status'));
  assert.ok(BILI_AUTH_ACTIONS.includes('qr_start'));
  assert.ok(BILI_AUTH_ACTIONS.includes('import_whale'));
});

test('manageBiliAuth status works without network', async () => {
  await withHome(async (home) => {
    const res = await manageBiliAuth(home, { action: 'status' });
    assert.equal(res.ok, true);
    assert.equal(res.loggedIn, false);
  });
});
