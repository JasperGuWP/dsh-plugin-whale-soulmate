import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSoulmateHome,
  saveConfigAuto,
  saveCredentials,
  loadConfig,
  loadCredentials,
} from '../packages/soulmate-core/state.mjs';
import { retainFact, recallMemory, updatePromise } from '../packages/soulmate-core/memory-engine.mjs';
import { readPrivacyAudit } from '../packages/soulmate-core/privacy-firewall.mjs';
import { startMockAigcServer } from '../server-mock/aigc-mock-server.mjs';
import { createCloudGateway } from '../packages/soulmate-core/cloud-gateway.mjs';

test('cloud-gateway: refuses sync without consent, isolates multi-tenant keys, roams across devices, and mounts remote capabilities', async () => {
  const server = await startMockAigcServer(0);
  const dirA1 = await mkdtemp(join(tmpdir(), 'soulmate-devA1-'));
  const dirA2 = await mkdtemp(join(tmpdir(), 'soulmate-devA2-'));
  const dirB = await mkdtemp(join(tmpdir(), 'soulmate-devB-'));
  try {
    const homeA1 = resolveSoulmateHome(dirA1);
    const gwA1 = createCloudGateway(homeA1);

    // 1. Without consent -> refuses network sync
    await retainFact(homeA1, { topic: 'A的秘密爱好', content: '喜欢收集复古机械键盘' });
    const noConsentRes = await gwA1.syncNow();
    assert.equal(noConsentRes.ok, false);
    assert.match(noConsentRes.reason, /consent/i);

    // 2. Device flow auth + consent for User A on Device 1
    await saveConfigAuto(homeA1, { cloud: { serverUrl: server.baseUrl, consentGiven: true } });
    const devFlow = await gwA1.startDeviceAuth();
    assert.ok(devFlow.deviceCode);
    server.approveDeviceCode(devFlow.deviceCode, 'ak_userA_secret_key_1111', { nickname: 'Alice' });
    const tokenRes = await gwA1.pollDeviceToken(devFlow.deviceCode);
    assert.equal(tokenRes.ok, true);

    const sync1 = await gwA1.syncNow();
    assert.equal(sync1.ok, true);

    // 3. User B with a different key must NOT see User A's memories
    const homeB = resolveSoulmateHome(dirB);
    await saveConfigAuto(homeB, { cloud: { serverUrl: server.baseUrl, consentGiven: true } });
    await saveCredentials(homeB, { apiKey: 'ak_userB_secret_key_2222' });
    const gwB = createCloudGateway(homeB);
    await gwB.syncNow();
    const recallB = await recallMemory(homeB, '机械键盘');
    assert.equal(recallB.facts.length, 0);

    // 4. User A on Device 2 with same key roams and gets User A's memories
    const homeA2 = resolveSoulmateHome(dirA2);
    await saveConfigAuto(homeA2, { cloud: { serverUrl: server.baseUrl, consentGiven: true } });
    await saveCredentials(homeA2, { apiKey: 'ak_userA_secret_key_1111' });
    const gwA2 = createCloudGateway(homeA2);
    await gwA2.syncNow();
    const recallA2 = await recallMemory(homeA2, '机械键盘');
    assert.equal(recallA2.facts.length, 1);

    // 5. Dynamic capability discovery & invocation
    const mountedTools = [];
    await gwA1.fetchAndMountCapabilities(toolDef => {
      mountedTools.push(toolDef);
      return () => {};
    });
    assert.ok(mountedTools.some(t => t.name === 'soulmate_cloud_draw_selfie'));
    const drawTool = mountedTools.find(t => t.name === 'soulmate_cloud_draw_selfie');
    const invokeRes = await drawTool.execute({ scene: '端着铁盆在星空窗前吃白米饭' });
    assert.equal(invokeRes.ok, true);
    assert.ok(invokeRes.memento?.imageUrl);

    // 6. Remote data wipe
    const wipeRes = await gwA1.wipeRemoteData();
    assert.equal(wipeRes.ok, true);
  } finally {
    await server.close();
    await rm(dirA1, { recursive: true, force: true });
    await rm(dirA2, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test('cloud-gateway: no consent means zero network calls; consent+key+url preconditions are enforced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-noconsent-'));
  try {
    const home = resolveSoulmateHome(dir);
    let calls = 0;
    const gw = createCloudGateway(home, {
      fetch: async () => {
        calls++;
        throw new Error('network must not be touched');
      },
    });
    await saveConfigAuto(home, { cloud: { serverUrl: 'http://127.0.0.1:9', consentGiven: false } });
    await saveCredentials(home, { apiKey: 'ak_whatever_key_0000' });
    const res = await gw.syncNow();
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'User consent not given (cloud.consentGiven is false)');
    assert.equal(calls, 0);

    // consent given but no key -> still no network
    await saveConfigAuto(home, { cloud: { consentGiven: true } });
    await saveCredentials(home, { apiKey: '' });
    const noKey = await gw.syncNow();
    assert.equal(noKey.ok, false);
    assert.match(noKey.reason, /API key/i);
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cloud-gateway: unauthorized requests are rejected by the server and surfaced by the gateway', async () => {
  const server = await startMockAigcServer(0);
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-unauth-'));
  try {
    for (const headers of [{}, { authorization: '' }, { authorization: 'Bearer ' }, { authorization: 'Bearer    ' }]) {
      for (const [method, path] of [
        ['GET', '/me'],
        ['POST', '/sync'],
        ['GET', '/capabilities'],
        ['POST', '/capabilities/soulmate_cloud_draw_selfie/invoke'],
        ['GET', '/events'],
        ['DELETE', '/me/data'],
      ]) {
        const res = await fetch(`${server.baseUrl}/api/v1/soulmate${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          body: method === 'POST' ? '{}' : undefined,
        });
        assert.equal(res.status, 401, `${method} ${path}`);
        assert.deepEqual(await res.json(), { ok: false, error: 'Unauthorized' });
      }
    }

    // gateway with a valid-looking key can verify; /me exposes tier + quota
    const home = resolveSoulmateHome(dir);
    await saveConfigAuto(home, { cloud: { serverUrl: server.baseUrl, consentGiven: true } });
    const gw = createCloudGateway(home);
    const noKey = await gw.verifyConnection();
    assert.equal(noKey.ok, false);

    await saveCredentials(home, { apiKey: 'ak_verify_key_3333' });
    const me = await gw.verifyConnection();
    assert.equal(me.ok, true);
    assert.equal(me.user.tier, 'pro');
    assert.deepEqual(me.quota, { memoryLimit: 10000, aigcCredits: 500 });
    assert.ok(me.serverTime);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cloud-gateway: device flow reports pending, then persists key + enables cloud (without leaking the key)', async () => {
  const server = await startMockAigcServer(0);
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-device-'));
  try {
    const home = resolveSoulmateHome(dir);
    await saveConfigAuto(home, { cloud: { serverUrl: server.baseUrl } });
    const gw = createCloudGateway(home);

    const flow = await gw.startDeviceAuth();
    assert.equal(flow.expiresIn, 300);
    assert.equal(flow.verificationUrl, `${server.baseUrl}/verify?code=${flow.userCode}`);

    const pending = await gw.pollDeviceToken(flow.deviceCode);
    assert.equal(pending.ok, false);
    assert.equal(pending.pending, true);
    assert.equal((await loadConfig(home)).cloud.enabled, false);

    assert.equal(server.approveDeviceCode(flow.deviceCode, 'ak_device_flow_key_4444', { nickname: 'Bob', userId: 'user_bob_001' }), true);
    const done = await gw.pollDeviceToken(flow.deviceCode);
    assert.equal(done.ok, true);
    assert.equal(done.user.nickname, 'Bob');
    assert.equal(done.user.tier, 'pro');
    assert.ok(!JSON.stringify(done).includes('ak_device_flow_key_4444'));

    const creds = await loadCredentials(home);
    assert.equal(creds.apiKey, 'ak_device_flow_key_4444');
    assert.equal(creds.userId, 'user_bob_001');
    assert.equal((await loadConfig(home)).cloud.enabled, true);

    const bad = await gw.pollDeviceToken('nope');
    assert.equal(bad.ok, false);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cloud-gateway: E2EE sync keeps plaintext off the server and roams only with the right passphrase', async () => {
  const server = await startMockAigcServer(0);
  const dirs = await Promise.all(['e1', 'e2', 'e3'].map((n) => mkdtemp(join(tmpdir(), `soulmate-${n}-`))));
  const apiKey = 'ak_e2ee_user_key_5555';
  try {
    const [h1, h2, h3] = dirs.map((d) => resolveSoulmateHome(d));
    for (const h of [h1, h2, h3]) {
      await saveConfigAuto(h, { cloud: { serverUrl: server.baseUrl, consentGiven: true, e2ee: true } });
    }
    await saveCredentials(h1, { apiKey, e2eePassphrase: 'correct horse battery staple' });
    await saveCredentials(h2, { apiKey, e2eePassphrase: 'correct horse battery staple' });
    await saveCredentials(h3, { apiKey, e2eePassphrase: 'wrong passphrase entirely' });

    await retainFact(h1, { topic: '宠物', content: '养了一只叫团子的橘猫' });
    const up = await createCloudGateway(h1).syncNow();
    assert.equal(up.ok, true);
    assert.equal(up.uploaded.facts, 1);

    // server only ever sees ciphertext
    const stored = server.inspectTenant(apiKey);
    assert.equal(stored.factMap.length, 1);
    assert.equal(stored.factMap[0].e2ee, true);
    assert.ok(stored.factMap[0].payload.ciphertext);
    const serialized = JSON.stringify(stored);
    assert.ok(!serialized.includes('团子'));
    assert.ok(!serialized.includes('橘猫'));

    // right passphrase -> roams
    const down = await createCloudGateway(h2).syncNow();
    assert.equal(down.ok, true);
    assert.equal(down.downloaded.facts, 1);
    assert.equal((await recallMemory(h2, '团子')).facts.length, 1);

    // wrong passphrase -> nothing imported, reported as undecryptable
    const bad = await createCloudGateway(h3).syncNow();
    assert.equal(bad.ok, true);
    assert.equal(bad.downloaded.undecryptable, 1);
    assert.equal((await recallMemory(h3, '团子')).facts.length, 0);

    // E2EE requested but passphrase missing -> refuse rather than leak plaintext
    await saveCredentials(h1, { e2eePassphrase: '' });
    const refused = await createCloudGateway(h1).syncNow();
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /passphrase/i);
  } finally {
    await server.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  }
});

test('cloud-gateway: plain sync is audited, advances the cursor and is incremental', async () => {
  const server = await startMockAigcServer(0);
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-audit-'));
  try {
    const home = resolveSoulmateHome(dir);
    await saveConfigAuto(home, { cloud: { serverUrl: server.baseUrl, consentGiven: true } });
    await saveCredentials(home, { apiKey: 'ak_audit_user_key_6666' });
    const gw = createCloudGateway(home);

    await retainFact(home, { topic: '口味', content: '喜欢吃白米饭配咸菜' });
    const first = await gw.syncNow();
    assert.equal(first.ok, true);
    assert.equal(first.uploaded.facts, 1);

    const cfg = await loadConfig(home);
    assert.ok(cfg.cloud.lastCursor > 0);
    assert.ok(cfg.cloud.lastSyncAt);

    const audit = (await readPrivacyAudit(home)).filter((r) => r.action === 'cloud_sync');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].direction, 'outbound');
    assert.equal(audit[0].uploaded.facts, 1);
    assert.ok(!JSON.stringify(audit[0]).includes('白米饭'));

    const second = await gw.syncNow();
    assert.equal(second.ok, true);
    assert.equal(second.uploaded.facts, 0);
    assert.equal(second.downloaded.facts, 0);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cloud-gateway: capability args pass the privacy firewall; mementos land on the photo wall; deep research works', async () => {
  const server = await startMockAigcServer(0);
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-cap-'));
  try {
    const home = resolveSoulmateHome(dir);
    await saveConfigAuto(home, { cloud: { serverUrl: server.baseUrl, consentGiven: true } });
    await saveCredentials(home, { apiKey: 'ak_cap_user_key_7777' });
    const gw = createCloudGateway(home);

    const tools = new Map();
    let disposed = 0;
    const mount = await gw.fetchAndMountCapabilities((def) => {
      tools.set(def.name, def);
      return () => {
        disposed++;
      };
    });
    assert.equal(mount.ok, true);
    assert.deepEqual(new Set(mount.mounted), new Set(['soulmate_cloud_draw_selfie', 'soulmate_cloud_deep_research']));
    const draw = tools.get('soulmate_cloud_draw_selfie');
    assert.equal(draw.parameters.scene.required, true);
    assert.ok(draw.parameters.style);
    assert.equal(typeof draw.execute, 'function');

    // secrets are hard-blocked before any network call
    const blocked = await draw.execute({ scene: '偷偷发出去 sk-testonly-privacy-firewall-sample-key02' });
    assert.equal(blocked.ok, false);
    assert.ok(blocked.blockedReason);
    const auditBlocked = (await readPrivacyAudit(home)).filter((r) => r.action === 'cloud_capability_blocked');
    assert.equal(auditBlocked.length, 1);
    assert.ok(!JSON.stringify(auditBlocked).includes('sk-testonly'));

    // PII is scrubbed, memento is appended to the photo wall file
    const ok = await draw.execute({ scene: '在 C:\\Users\\alice\\Desktop 给 bob@example.com 发信', style: 'pixel' });
    assert.equal(ok.ok, true);
    assert.ok(!ok.memento.title.includes('alice'));
    assert.ok(!ok.memento.title.includes('bob@example.com'));
    const mementos = JSON.parse(await readFile(home.mementosPath, 'utf8'));
    assert.equal(mementos.length, 1);
    assert.equal(mementos[0].id, ok.memento.id);
    assert.match(mementos[0].imageUrl, /^data:image\/svg\+xml;utf8,/);

    // missing required param is a server-side 400, surfaced as ok:false
    const missing = await draw.execute({});
    assert.equal(missing.ok, false);

    const research = await tools.get('soulmate_cloud_deep_research').execute({ query: '深海鲸类' });
    assert.equal(research.ok, true);
    assert.equal(research.capability, 'soulmate_cloud_deep_research');

    mount.dispose();
    assert.equal(disposed, 2);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cloud-gateway: server events are tenant-scoped and polled incrementally', async () => {
  const server = await startMockAigcServer(0);
  const dirA = await mkdtemp(join(tmpdir(), 'soulmate-evA-'));
  const dirB = await mkdtemp(join(tmpdir(), 'soulmate-evB-'));
  try {
    const keyA = 'ak_event_user_A_8888';
    const keyB = 'ak_event_user_B_9999';
    const homeA = resolveSoulmateHome(dirA);
    const homeB = resolveSoulmateHome(dirB);
    for (const [h, k] of [[homeA, keyA], [homeB, keyB]]) {
      await saveConfigAuto(h, { cloud: { serverUrl: server.baseUrl, consentGiven: true } });
      await saveCredentials(h, { apiKey: k });
    }
    const gwA = createCloudGateway(homeA);
    const gwB = createCloudGateway(homeB);

    assert.deepEqual((await gwA.pollEvents(0)).events, []);

    server.pushServerEvent(keyA, { type: 'announcement', message: '新功能上线' });
    server.pushServerEvent(keyA, { type: 'quota', message: '额度不足' });
    server.pushServerEvent(keyB, { type: 'announcement', message: '只给 B' });

    const all = await gwA.pollEvents(0);
    assert.equal(all.ok, true);
    assert.equal(all.events.length, 2);
    assert.deepEqual(all.events.map((e) => e.message), ['新功能上线', '额度不足']);

    const later = await gwA.pollEvents(all.events[0].id);
    assert.deepEqual(later.events.map((e) => e.message), ['额度不足']);
    assert.deepEqual((await gwA.pollEvents(all.events[1].id)).events, []);

    const bEvents = await gwB.pollEvents(0);
    assert.deepEqual(bEvents.events.map((e) => e.message), ['只给 B']);
  } finally {
    await server.close();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test('cloud-gateway: wipe physically deletes the tenant store and revokes local consent', async () => {
  const server = await startMockAigcServer(0);
  const dir = await mkdtemp(join(tmpdir(), 'soulmate-wipe-'));
  try {
    const apiKey = 'ak_wipe_user_key_0001';
    const home = resolveSoulmateHome(dir);
    await saveConfigAuto(home, { cloud: { serverUrl: server.baseUrl, consentGiven: true, enabled: true } });
    await saveCredentials(home, { apiKey });
    const gw = createCloudGateway(home);

    await retainFact(home, { topic: '日记', content: '今天吃了很多白米饭' });
    assert.equal((await gw.syncNow()).ok, true);
    assert.equal(server.inspectTenant(apiKey).factMap.length, 1);

    const wiped = await gw.wipeRemoteData();
    assert.equal(wiped.ok, true);
    assert.ok(wiped.wipedAt);
    assert.equal(server.inspectTenant(apiKey), undefined);

    const cfg = await loadConfig(home);
    assert.equal(cfg.cloud.consentGiven, false);
    assert.equal(cfg.cloud.enabled, false);
    assert.equal(cfg.cloud.lastCursor, 0);

    // consent is gone -> no more sync
    const after = await gw.syncNow();
    assert.equal(after.ok, false);
    assert.match(after.reason, /consent/i);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v3 sync (§10): ops replay + divergence parking
// ---------------------------------------------------------------------------

test('cloud-sync v3: promise transitions roam as ops, not as LWW rows', async () => {
  const server = await startMockAigcServer(0);
  const dirA = await mkdtemp(join(tmpdir(), 'soulmate-opsA-'));
  const dirB = await mkdtemp(join(tmpdir(), 'soulmate-opsB-'));
  try {
    const homeA = resolveSoulmateHome(dirA);
    const homeB = resolveSoulmateHome(dirB);
    for (const [home, key] of [[homeA, 'ak_opsA_key_0001'], [homeB, 'ak_opsA_key_0001']]) {
      await saveConfigAuto(home, { cloud: { serverUrl: server.baseUrl, consentGiven: true } });
      await saveCredentials(home, { apiKey: key });
    }
    const gwA = createCloudGateway(homeA);
    const gwB = createCloudGateway(homeB);
    const T0 = Date.parse('2026-11-10T08:00:00Z');
    const p = await retainFact(homeA, { kind: 'promise', text: '周五陪你看电影', nowMs: T0 });
    const kept = await updatePromise(homeA, { id: p.fact.id, action: 'keep', note: '爆米花我买', nowMs: T0 + 60_000 });
    assert.equal(kept.ok, true);
    assert.equal((await gwA.syncNow()).ok, true);
    assert.equal((await gwB.syncNow()).ok, true);
    const rows = (await readFile(join(dirB, 'memory', 'facts', 'facts.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const roamed = rows.find((r) => r.id === p.fact.id);
    assert.ok(roamed, 'the promise roamed to device B');
    assert.equal(roamed.promise.status, 'kept', 'the keep op replayed instead of losing to LWW');
    assert.equal(roamed.promise.note, '爆米花我买');
  } finally {
    await server.close();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test('cloud-sync: promise.note passes the outbound firewall (PII scrubbed, secrets block the item)', async () => {
  const server = await startMockAigcServer(0);
  const dirA = await mkdtemp(join(tmpdir(), 'soulmate-noteA-'));
  const dirB = await mkdtemp(join(tmpdir(), 'soulmate-noteB-'));
  try {
    const homeA = resolveSoulmateHome(dirA);
    const homeB = resolveSoulmateHome(dirB);
    for (const home of [homeA, homeB]) {
      await saveConfigAuto(home, { cloud: { serverUrl: server.baseUrl, consentGiven: true } });
      await saveCredentials(home, { apiKey: 'ak_note_key_00001' });
    }
    const gwA = createCloudGateway(homeA);
    const gwB = createCloudGateway(homeB);
    const T0 = Date.parse('2026-11-10T08:00:00Z');
    const p1 = await retainFact(homeA, { kind: 'promise', text: '给你打电话', nowMs: T0 });
    await updatePromise(homeA, { id: p1.fact.id, action: 'keep', note: '打 13812345678 找我', nowMs: T0 + 60_000 });
    const p2 = await retainFact(homeA, { kind: 'promise', text: '帮你部署', nowMs: T0 });
    await updatePromise(homeA, { id: p2.fact.id, action: 'keep', note: '用 sk-testonly-note-leak-key0001 部署', nowMs: T0 + 60_000 });
    assert.equal((await gwA.syncNow()).ok, true);
    assert.equal((await gwB.syncNow()).ok, true);
    const raw = await readFile(join(dirB, 'memory', 'facts', 'facts.jsonl'), 'utf8');
    const rows = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const roamed = rows.find((r) => r.id === p1.fact.id);
    assert.ok(roamed, 'the PII promise roamed');
    assert.equal(roamed.promise.note, '打 <PHONE> 找我', 'nested promise.note is scrubbed at egress');
    assert.equal(rows.find((r) => r.id === p2.fact.id), undefined, 'a secret in promise.note blocks the whole item');
    assert.ok(!raw.includes('13812345678'), 'raw phone never reaches device B');
    assert.ok(!raw.includes('sk-testonly-note-leak-key0001'), 'secret never reaches device B');
  } finally {
    await server.close();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test('cloud-sync v3: same-minute divergent edits park as a conflict instead of last-write-wins', async () => {
  const server = await startMockAigcServer(0);
  const dirA = await mkdtemp(join(tmpdir(), 'soulmate-divA-'));
  const dirB = await mkdtemp(join(tmpdir(), 'soulmate-divB-'));
  try {
    const homeA = resolveSoulmateHome(dirA);
    const homeB = resolveSoulmateHome(dirB);
    for (const home of [homeA, homeB]) {
      await saveConfigAuto(home, { cloud: { serverUrl: server.baseUrl, consentGiven: true } });
      await saveCredentials(home, { apiKey: 'ak_div_key_00001' });
    }
    const gwA = createCloudGateway(homeA);
    const gwB = createCloudGateway(homeB);
    // Stamps must stay ahead of the sync cursor (server Date.now()). Seed, sync both,
    // then edit with a fresh wall-clock time so the delta is actually uploaded.
    const T0 = Date.now();
    await retainFact(homeA, { id: 'f_shared', topic: '住址', content: '住在海淀', nowMs: T0 });
    await gwA.syncNow();
    await gwB.syncNow();
    // B edits the same memory moments later (same id, different text, within 60s conflict window).
    await retainFact(homeB, { id: 'f_shared', topic: '住址', content: '搬到昌平了', nowMs: Date.now() });
    await gwB.syncNow();
    const merged = await gwA.syncNow();
    assert.equal(merged.ok, true);
    const rows = (await readFile(join(dirA, 'memory', 'facts', 'facts.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const local = rows.find((r) => r.id === 'f_shared');
    const shadow = rows.find((r) => r.id.startsWith('f_shared~r'));
    assert.ok(shadow, 'the remote version survives as a shadow row');
    assert.equal(local.text, '住址：住在海淀', 'local text is never silently overwritten');
    assert.equal(shadow.text, '住址：搬到昌平了');
    assert.equal(local.conflictWith, shadow.id);
    assert.equal(shadow.conflictWith, local.id);
    assert.equal(local.confidence, 0.55, 'both sides drop to the hold floor until asked');
  } finally {
    await server.close();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});
