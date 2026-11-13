// Soulmate cloud gateway: device-flow auth, consent-gated bidirectional sync,
// dynamic AIGC capability mounting, server events, remote wipe.
// Pure Node ESM, zero external dependencies.
//
// Privacy guarantees (spec §7):
//  - syncNow() makes NO network call unless config.cloud.consentGiven === true.
//  - Every outgoing string passes inspectAndScrub (secrets -> item dropped, PII -> placeholders).
//  - Optional per-item AES-256-GCM E2EE; if E2EE is requested but no passphrase exists we refuse
//    rather than silently falling back to plaintext.
//  - Every outbound sync / capability call is written to the privacy audit ledger.
import { readFile } from 'node:fs/promises';
import {
  atomicWriteJson,
  loadConfig,
  loadCredentials,
  maskKey,
  saveConfigAuto,
  saveCredentials,
} from './state.mjs';
import { appendPrivacyAudit, decryptPayload, encryptPayload, inspectAndScrub } from './privacy-firewall.mjs';
import { applyRemoteSyncDelta, buildSyncableSnapshot } from './memory-engine.mjs';

const API = '/api/v1/soulmate';
const NO_CONSENT_REASON = 'User consent not given (cloud.consentGiven is false)';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const errMsg = (err) => (err instanceof Error ? err.message : String(err));

// Fields whose plaintext stays visible to the server (needed for LWW / tombstones) when E2EE is on.
const PLAIN_KEYS = {
  wiki: ['slug', 'updatedAt'],
  fact: ['id', 'updatedAt'],
  episode: ['date', 'kind', 'updatedAt'],
  ops: ['kind', 'id', 'keepId', 'dropId', 'at'],
};
// Free-text fields run through the outbound firewall.
const TEXT_FIELDS = {
  wiki: ['title', 'summary', 'content'],
  fact: ['text', 'topic', 'content'],
  episode: ['content'],
  ops: ['note', 'reason'],
};
const itemKey = (kind, item) =>
  kind === 'wiki' ? item.slug : kind === 'fact' ? item.id : `${item.date}-${item.kind}`;

/** Recursively scrub every string in `value`. Returns { allowed, blockedReason, value, redactions }. */
function scrubDeep(value) {
  const redactions = [];
  let blockedReason = null;
  const walk = (v) => {
    if (blockedReason) return v;
    if (typeof v === 'string') {
      const check = inspectAndScrub(v);
      if (!check.allowed) {
        blockedReason = check.blockedReason;
        return v;
      }
      redactions.push(...check.redactions);
      return check.scrubbedText;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value);
  return blockedReason
    ? { allowed: false, blockedReason, value: null, redactions: [] }
    : { allowed: true, blockedReason: null, value: out, redactions };
}

/** Scrub the free-text fields of one syncable item (never mutates the local copy). */
function scrubItem(kind, item) {
  const next = { ...item };
  const redactions = [];
  for (const field of TEXT_FIELDS[kind]) {
    if (typeof next[field] !== 'string') continue;
    const check = inspectAndScrub(next[field]);
    if (!check.allowed) return { allowed: false, blockedReason: check.blockedReason };
    next[field] = check.scrubbedText;
    redactions.push(...check.redactions);
  }
  if (Array.isArray(next.links)) next.links = next.links.map(String);
  return { allowed: true, item: next, redactions };
}

function sealItem(kind, item, passphrase) {
  const plain = {};
  const secret = {};
  for (const [k, v] of Object.entries(item)) (PLAIN_KEYS[kind].includes(k) ? plain : secret)[k] = v;
  return { ...plain, e2ee: true, payload: encryptPayload(JSON.stringify(secret), passphrase) };
}

function openItem(item, passphrase) {
  if (!isObject(item) || item.e2ee !== true || !item.payload) return { item };
  if (!passphrase) return { error: 'missing E2EE passphrase' };
  try {
    const { e2ee: _e, payload, ...plain } = item;
    return { item: { ...plain, ...JSON.parse(decryptPayload(payload, passphrase)) } };
  } catch (err) {
    return { error: errMsg(err) };
  }
}

export function createCloudGateway(home, options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15_000;

  /** Low-level JSON request. Never throws: network failures become { ok: false, reason }. */
  async function request(serverUrl, method, path, { apiKey, body, query } = {}) {
    const url = new URL(`${String(serverUrl).replace(/\/+$/, '')}${API}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    const headers = { accept: 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      const res = await doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      let data;
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      if (!isObject(data)) data = {};
      if (!res.ok && data.ok !== false) data.ok = false;
      if (data.ok === false) {
        data.status = res.status;
        data.reason ??= data.error || `HTTP ${res.status}`;
      }
      return data;
    } catch (err) {
      return { ok: false, reason: `Network error: ${errMsg(err)}` };
    }
  }

  /** Load config + credentials and validate what an authenticated call needs. */
  async function context({ needKey = true } = {}) {
    const config = await loadConfig(home);
    const creds = await loadCredentials(home);
    const serverUrl = options.serverUrl || config.cloud.serverUrl;
    if (!serverUrl) return { error: 'cloud.serverUrl is not configured' };
    if (needKey && !creds.apiKey) return { error: 'No API key (complete device authorization or enter a key first)' };
    return { config, creds, serverUrl };
  }

  // ---------------------------------------------------------------- auth
  async function startDeviceAuth() {
    const ctx = await context({ needKey: false });
    if (ctx.error) return { ok: false, reason: ctx.error };
    return request(ctx.serverUrl, 'POST', '/auth/device-code', { body: {} });
  }

  async function pollDeviceToken(deviceCode) {
    const ctx = await context({ needKey: false });
    if (ctx.error) return { ok: false, reason: ctx.error };
    const res = await request(ctx.serverUrl, 'POST', '/auth/device-token', { body: { deviceCode } });
    if (res.ok !== true) return res;
    await saveCredentials(home, { apiKey: res.apiKey, userId: res.user?.userId ?? '' });
    await saveConfigAuto(home, { cloud: { enabled: true } });
    // The raw key stays in credentials.json only.
    return { ok: true, user: res.user, apiKeyMasked: maskKey(res.apiKey) };
  }

  async function verifyConnection() {
    const ctx = await context();
    if (ctx.error) return { ok: false, reason: ctx.error };
    return request(ctx.serverUrl, 'GET', '/me', { apiKey: ctx.creds.apiKey });
  }

  // ---------------------------------------------------------------- sync
  let syncChain = Promise.resolve();
  const syncNow = () => {
    const run = syncChain.catch(() => {}).then(doSync);
    syncChain = run;
    return run;
  };

  async function doSync() {
    const ctx = await context();
    // Consent is checked first: no network (and no snapshot) without it.
    const consent = (await loadConfig(home)).cloud.consentGiven === true;
    if (!consent) return { ok: false, reason: NO_CONSENT_REASON };
    if (ctx.error) return { ok: false, reason: ctx.error };
    const { config, creds, serverUrl } = ctx;

    const useE2ee = config.cloud.e2ee === true;
    if (useE2ee && !creds.e2eePassphrase) {
      return { ok: false, reason: 'E2EE is enabled but no E2EE passphrase is stored; refusing to upload plaintext' };
    }

    try {
      // Pad by 1ms: anything written while this sync is in flight stays newer than the stored cursor.
      const startedAt = Date.now() - 1;
      const snapshot = await buildSyncableSnapshot(home, Number(config.cloud.lastCursor) || 0);

      // ---- outbound firewall ----
      const blocked = [];
      const redactions = new Set();
      const outbound = {};
      for (const [field, kind] of [
        ['wikiUpserts', 'wiki'],
        ['factUpserts', 'fact'],
        ['episodeUpserts', 'episode'],
        ['ops', 'ops'],
      ]) {
        outbound[field] = [];
        for (const item of snapshot[field]) {
          const checked = scrubItem(kind, item);
          if (!checked.allowed) {
            blocked.push({ kind, id: String(itemKey(kind, item)), reason: checked.blockedReason });
            continue;
          }
          checked.redactions.forEach((r) => redactions.add(r));
          outbound[field].push(useE2ee ? sealItem(kind, checked.item, creds.e2eePassphrase) : checked.item);
        }
      }

      const uploaded = {
        wiki: outbound.wikiUpserts.length,
        facts: outbound.factUpserts.length,
        episodes: outbound.episodeUpserts.length,
        tombstones: snapshot.tombstones.length,
          ops: (snapshot.ops ?? []).length,
        blocked: blocked.length,
      };

      await appendPrivacyAudit(home, {
        action: 'cloud_sync',
        direction: 'outbound',
        server: serverUrl,
        deviceId: config.deviceId,
        e2ee: useE2ee,
        uploaded,
        blocked,
        redactions: [...redactions],
      });

      const res = await request(serverUrl, 'POST', '/sync', {
        apiKey: creds.apiKey,
        body: {
          deviceId: config.deviceId,
          sinceCursor: Number(config.cloud.lastCursor) || 0,
          e2ee: useE2ee,
          persona: null,
          state: null,
          appearance: null,
          wikiUpserts: outbound.wikiUpserts,
          factUpserts: outbound.factUpserts,
          episodeUpserts: outbound.episodeUpserts,
          tombstones: snapshot.tombstones,
          ops: outbound.ops,
        },
      });
      if (res.ok !== true) return { ok: false, reason: res.reason || 'sync failed', status: res.status };

      // ---- inbound: decrypt (if needed) then LWW-merge ----
      let undecryptable = 0;
      const open = (items) =>
        list(items).flatMap((it) => {
          const opened = openItem(it, creds.e2eePassphrase);
          if (opened.error) {
            undecryptable++;
            return [];
          }
          return [opened.item];
        });
      const delta = {
        remoteWikiUpserts: open(res.remoteWikiUpserts),
        remoteFactUpserts: open(res.remoteFactUpserts),
        remoteEpisodeUpserts: open(res.remoteEpisodeUpserts),
        remoteTombstones: list(res.remoteTombstones),
        remoteOps: list(res.remoteOps),
      };
      const merged = await applyRemoteSyncDelta(home, delta);

      const nextCursor = Number(res.nextCursor) || startedAt;
      await saveConfigAuto(home, {
        cloud: { lastCursor: Math.min(nextCursor, startedAt), lastSyncAt: new Date().toISOString() },
      });

      return {
        ok: true,
        nextCursor,
        uploaded,
        downloaded: { ...merged.applied, skipped: merged.skipped, undecryptable },
      };
    } catch (err) {
      // A failed sync must never break local use; local data is untouched and retried next time.
      return { ok: false, reason: `Sync failed: ${errMsg(err)}` };
    }
  }

  // ---------------------------------------------------------------- capabilities
  let mementoChain = Promise.resolve();
  function appendMemento(memento) {
    const run = mementoChain
      .catch(() => {})
      .then(async () => {
        let existing = [];
        try {
          const parsed = JSON.parse(await readFile(home.mementosPath, 'utf8'));
          existing = Array.isArray(parsed) ? parsed : list(parsed?.mementos);
        } catch (err) {
          if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
        }
        existing.push(memento);
        await atomicWriteJson(home.mementosPath, existing);
      });
    mementoChain = run;
    return run;
  }

  function buildToolDef(cap) {
    return {
      name: cap.name,
      description: cap.description || cap.title || cap.name,
      parameters: cap.parameters ?? {},
      async execute(args = {}) {
        const ctx = await context();
        if (ctx.error) return { ok: false, reason: ctx.error };
        if (ctx.config.cloud.consentGiven !== true) return { ok: false, reason: NO_CONSENT_REASON };

        const checked = scrubDeep(isObject(args) ? args : {});
        if (!checked.allowed) {
          await appendPrivacyAudit(home, {
            action: 'cloud_capability_blocked',
            capability: cap.name,
            reason: checked.blockedReason,
          });
          return { ok: false, blockedReason: checked.blockedReason, reason: checked.blockedReason };
        }
        await appendPrivacyAudit(home, {
          action: 'cloud_capability_invoke',
          direction: 'outbound',
          capability: cap.name,
          redactions: [...new Set(checked.redactions)],
        });

        const res = await request(ctx.serverUrl, 'POST', `/capabilities/${encodeURIComponent(cap.name)}/invoke`, {
          apiKey: ctx.creds.apiKey,
          body: { args: checked.value },
        });
        if (res.ok === true && isObject(res.memento)) {
          // Hang the souvenir on the 3D home photo wall.
          await appendMemento({ source: 'cloud', capability: cap.name, ...res.memento });
        }
        return res;
      },
    };
  }

  async function fetchAndMountCapabilities(registerDynamicTool) {
    if (typeof registerDynamicTool !== 'function') {
      throw new TypeError('[soulmate] fetchAndMountCapabilities requires a registerDynamicTool(toolDef) function');
    }
    const ctx = await context();
    if (ctx.error) return { ok: false, reason: ctx.error, mounted: [], dispose() {} };
    const res = await request(ctx.serverUrl, 'GET', '/capabilities', { apiKey: ctx.creds.apiKey });
    if (res.ok !== true) return { ok: false, reason: res.reason, mounted: [], dispose() {} };

    const mounted = [];
    const disposers = [];
    for (const cap of list(res.capabilities)) {
      if (!isObject(cap) || !/^[A-Za-z0-9_-]{1,64}$/.test(String(cap.name ?? ''))) continue;
      const disposer = registerDynamicTool(buildToolDef(cap));
      if (typeof disposer === 'function') disposers.push(disposer);
      mounted.push(cap.name);
    }
    return {
      ok: true,
      mounted,
      capabilities: list(res.capabilities),
      dispose() {
        while (disposers.length) disposers.pop()();
      },
    };
  }

  // ---------------------------------------------------------------- events / wipe
  async function pollEvents(afterId = 0) {
    const ctx = await context();
    if (ctx.error) return { ok: false, reason: ctx.error, events: [] };
    const res = await request(ctx.serverUrl, 'GET', '/events', {
      apiKey: ctx.creds.apiKey,
      query: { afterId: Number(afterId) || 0 },
    });
    return res.ok === true ? { ...res, events: list(res.events) } : { ...res, events: [] };
  }

  async function wipeRemoteData() {
    const ctx = await context();
    if (ctx.error) return { ok: false, reason: ctx.error };
    const res = await request(ctx.serverUrl, 'DELETE', '/me/data', { apiKey: ctx.creds.apiKey });
    if (res.ok !== true) return res;
    // Withdrawn authorization: stop syncing and force a full re-upload if the user ever opts in again.
    await saveConfigAuto(home, { cloud: { consentGiven: false, enabled: false, lastCursor: 0, lastSyncAt: '' } });
    await appendPrivacyAudit(home, { action: 'cloud_wipe', direction: 'outbound', wipedAt: res.wipedAt });
    return res;
  }

  return {
    startDeviceAuth,
    pollDeviceToken,
    verifyConnection,
    syncNow,
    fetchAndMountCapabilities,
    pollEvents,
    wipeRemoteData,
  };
}
