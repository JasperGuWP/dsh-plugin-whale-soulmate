import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSoulmateHome,
  loadConfig,
  saveConfigAuto,
  loadCredentials,
  saveCredentials,
  maskKey,
} from '../packages/soulmate-core/state.mjs';
import {
  detectHighRiskSecret,
  scrubText,
  inspectAndScrub,
  encryptPayload,
  decryptPayload,
  appendPrivacyAudit,
  readPrivacyAudit,
} from '../packages/soulmate-core/privacy-firewall.mjs';

test('state: default config is zero-network opt-in and auto-saves patches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-state-'));
  try {
    const home = resolveSoulmateHome(dir);
    const cfg0 = await loadConfig(home);
    assert.equal(cfg0.cloud.consentGiven, false);
    assert.equal(cfg0.persona.name, '');
    const cfg1 = await saveConfigAuto(home, { persona: { name: '小汐', callUser: '阿澈' } });
    assert.equal(cfg1.persona.name, '小汐');
    assert.equal(cfg1.persona.callUser, '阿澈');

    await saveCredentials(home, { apiKey: 'ak_live_1234567890abcdef', userId: 'u_1' });
    const creds = await loadCredentials(home);
    assert.equal(creds.apiKey, 'ak_live_1234567890abcdef');
    assert.equal(maskKey(creds.apiKey), 'ak_l****cdef');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('state: home layout, ctx resolution, deviceId persistence and credential isolation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-state2-'));
  try {
    const home = resolveSoulmateHome(dir);
    assert.equal(home.rootDir, dir);
    assert.equal(home.privateNotesPath, join(dir, 'memory', 'private', 'local-notes.md'));
    assert.equal(home.auditLogPath, join(dir, 'logs', 'privacy-audit.jsonl'));
    assert.equal(home.wikiIndexPath, join(dir, 'memory', 'wiki', 'INDEX.md'));

    const ctxHome = resolveSoulmateHome({
      get: (name) => (name === 'dshHomePath' ? (sub) => join(dir, 'via-ctx', sub) : undefined),
    });
    assert.equal(ctxHome.rootDir, join(dir, 'via-ctx', 'soulmate'));

    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      assert.equal(resolveSoulmateHome().rootDir, join(dir, 'soulmate'));
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prev;
    }

    const cfg0 = await loadConfig(home);
    assert.match(cfg0.deviceId, /^dev_[0-9a-f]+$/);
    const cfg1 = await saveConfigAuto(home, { cloud: { consentGiven: true }, deviceId: 'hacked' });
    assert.equal(cfg1.deviceId, cfg0.deviceId);
    assert.equal(cfg1.cloud.consentGiven, true);
    assert.equal(cfg1.cloud.syncIntervalSec, 300, 'deep merge keeps untouched siblings');
    assert.equal((await loadConfig(home)).deviceId, cfg0.deviceId);

    await saveCredentials(home, { apiKey: 'ak_live_1234567890abcdef', e2eePassphrase: 'pp' });
    const configRaw = await readFile(home.configPath, 'utf8');
    assert.ok(!configRaw.includes('ak_live_1234567890abcdef'));
    assert.ok(!configRaw.includes('e2eePassphrase'));
    assert.equal(maskKey('short'), '****');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('privacy-firewall: blocks high-risk secrets and scrubs local paths/PII', async () => {
  const secretCheck = inspectAndScrub('my key is sk-testonly-privacy-firewall-sample-key06');
  assert.equal(secretCheck.allowed, false);
  assert.match(secretCheck.blockedReason, /API secret key/i);

  const cookieCheck = inspectAndScrub('SESSDATA=abc123456789; bili_jct=xyz');
  assert.equal(cookieCheck.allowed, false);

  const pathCheck = inspectAndScrub(
    '我在 C:\\Users\\Administrator\\projects\\secret-app 调试，邮箱 test@example.com'
  );
  assert.equal(pathCheck.allowed, true);
  assert.ok(!pathCheck.scrubbedText.includes('Administrator'));
  assert.ok(pathCheck.scrubbedText.includes('<HOME>/projects/secret-app'));
  assert.ok(pathCheck.scrubbedText.includes('<EMAIL>'));

  const enc = encryptPayload('绝密日记内容', 'my-passphrase');
  assert.equal(enc.e2ee, true);
  assert.notEqual(enc.ciphertext, '绝密日记内容');
  assert.equal(decryptPayload(enc, 'my-passphrase'), '绝密日记内容');

  const dir = await mkdtemp(join(tmpdir(), 'soulmate-audit-'));
  try {
    const home = resolveSoulmateHome(dir);
    await appendPrivacyAudit(home, { action: 'sync_scrub', redactions: ['path', 'email'] });
    const raw = await readFile(home.auditLogPath, 'utf8');
    assert.match(raw, /"action":"sync_scrub"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('privacy-firewall: detects every high-risk secret family', () => {
  // Assemble vendor-shaped fixtures at runtime so the repo never stores
  // literal token-looking strings that trip host push protection.
  const sk = (n) => ['sk', 'testonly', 'privacy', 'firewall', `sample-key${String(n).padStart(2, '0')}`].join('-');
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcDEF123'].join('.');
  const samples = {
    privateKey: ['-----BEGIN RSA PRIVATE KEY-----', 'MIIE...'].join('\n'),
    jwt: `token ${jwt}`,
    anthropic: sk(7),
    deepseek: sk(1),
    aws: ['AKIA', 'TESTONLYEXAMPLE0'].join(''),
    github: ['ghp', 'testonlyPrivacyFirewallSampleKey0001'].join('_'),
    slack: ['xox', 'b', '0000000000', 'testonlysample'].join('-').replace('xox-b-', 'xox' + 'b-'),
    cookie: 'bili_jct=0123abcd',
    password: 'password=hunter2xyz',
    cnSecret: '我的密钥：abcd1234',
    envAssign: 'OPENAI_API_KEY=abc',
    envFile: 'cat .env',
    idNumber: '身份证 11010519491231002X',
  };
  for (const [name, text] of Object.entries(samples)) {
    assert.ok(detectHighRiskSecret(text), `should block: ${name}`);
    assert.equal(inspectAndScrub(text).allowed, false, `inspect should block: ${name}`);
  }
  assert.equal(detectHighRiskSecret('今天天气不错，一起吃白米饭吧'), null);
  assert.equal(detectHighRiskSecret('订单号 123456789012345678901'), null);
});

test('privacy-firewall: scrubs POSIX/Windows paths, email, phone and LAN IPs', () => {
  const posix = scrubText('see /Users/alice/code/app and /home/bob/.config/x');
  assert.equal(posix.scrubbedText, 'see <HOME>/code/app and <HOME>/.config/x');
  assert.ok(posix.redactions.includes('path'));

  const win = scrubText('open C:\\Users\\Administrator\\a\\b.txt now');
  assert.equal(win.scrubbedText, 'open <HOME>/a/b.txt now');

  const pii = scrubText('联系 13812345678 或 a.b@corp.io，服务器 192.168.1.20 / 10.0.0.5，公网 8.8.8.8');
  assert.ok(pii.scrubbedText.includes('<PHONE>'));
  assert.ok(pii.scrubbedText.includes('<EMAIL>'));
  assert.equal(pii.scrubbedText.match(/<LAN_IP>/g).length, 2);
  assert.ok(pii.scrubbedText.includes('8.8.8.8'));
  assert.deepEqual([...pii.redactions].sort(), ['email', 'lan_ip', 'phone']);
});

test('privacy-firewall: E2EE rejects wrong passphrase and tampering', () => {
  const enc = encryptPayload('秘密', 'right');
  assert.equal(enc.alg, 'AES-256-GCM');
  assert.equal(Buffer.from(enc.salt, 'base64').length, 16);
  assert.equal(Buffer.from(enc.iv, 'base64').length, 12);
  assert.notEqual(encryptPayload('秘密', 'right').ciphertext, enc.ciphertext, 'random salt/iv');
  assert.throws(() => decryptPayload(enc, 'wrong'), /wrong passphrase/);
  const tampered = { ...enc, ciphertext: Buffer.from('xxxxxx').toString('base64') };
  assert.throws(() => decryptPayload(tampered, 'right'), /decrypt failed/);
  assert.throws(() => encryptPayload('x', ''), /passphrase/);
});

test('privacy-firewall: readPrivacyAudit returns latest records with timestamps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-audit2-'));
  try {
    const home = resolveSoulmateHome(dir);
    assert.deepEqual(await readPrivacyAudit(home), []);
    for (let i = 0; i < 5; i++) await appendPrivacyAudit(home, { action: 'blocked', n: i });
    const all = await readPrivacyAudit(home);
    assert.equal(all.length, 5);
    assert.ok(all.every((r) => !Number.isNaN(Date.parse(r.timestamp))));
    const last2 = await readPrivacyAudit(home, 2);
    assert.deepEqual(last2.map((r) => r.n), [3, 4]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
