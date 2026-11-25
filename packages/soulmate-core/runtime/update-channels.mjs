// Remote update channels for self-update: npm registry + GitHub Releases.
// Both are read-only JSON probes; the install step downloads the tarball to a local
// cache and verifies it (npm sha512 integrity / GitHub asset byte size) before pnpm add.
// Network is injectable (fetchImpl) so everything is testable offline. On machines
// behind a proxy, plain fetch may fail — the caller surfaces that honestly and the
// local-sourceDir channel keeps working.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cmpVer } from './self-update.mjs';

export const NPM_REGISTRY_URL = 'https://registry.npmjs.org/dsh-plugin-whale-soulmate';
export const GH_RELEASES_URL = 'https://api.github.com/repos/JasperGuWP/dsh-plugin-whale-soulmate/releases?per_page=10';
const PROBE_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_TGZ_BYTES = 64 * 1024 * 1024;

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': 'soulmate-self-update' },
  });
  if (!res || !res.ok) throw new Error(`HTTP ${res?.status || '?'}`);
  return res.json();
}

/** npm: dist-tags.latest + that version's tarball URL and sha512 integrity. */
export async function probeNpm(fetchImpl, { registryUrl = NPM_REGISTRY_URL } = {}) {
  const doc = await getJson(fetchImpl, registryUrl);
  const latest = String(doc?.['dist-tags']?.latest || '').trim();
  const ver = doc?.versions?.[latest];
  const tarball = String(ver?.dist?.tarball || '').trim();
  if (!latest || !tarball) return { ok: false, error: 'npm: no latest version' };
  return {
    ok: true,
    channel: 'npm',
    version: latest,
    url: tarball,
    integrity: String(ver?.dist?.integrity || ''),
    bytes: 0,
  };
}

/** GitHub: newest non-draft release that carries the plugin tgz asset. */
export async function probeGithub(fetchImpl, { releasesUrl = GH_RELEASES_URL } = {}) {
  const list = await getJson(fetchImpl, releasesUrl);
  let best = null;
  for (const rel of Array.isArray(list) ? list : []) {
    if (rel?.draft) continue;
    const version = String(rel.tag_name || '').replace(/^v/, '');
    const asset = (rel.assets || []).find((a) => /^dsh-plugin-whale-soulmate-\d+(\.\d+)*\.tgz$/.test(String(a?.name || '')));
    if (!asset || !/^\d+(\.\d+)*$/.test(version)) continue;
    if (!best || cmpVer(version, best.version) > 0) {
      best = {
        ok: true,
        channel: 'github',
        version,
        url: String(asset.browser_download_url || ''),
        bytes: Number(asset.size) || 0,
        integrity: '',
      };
    }
  }
  return best || { ok: false, error: 'github: no release with a plugin tgz' };
}

/**
 * Probe every enabled remote channel; one failure never sinks the others.
 * Returns { candidates: [...ok results], errors: { channel: message } }.
 */
export async function probeRemoteChannels(fetchImpl, { npm = true, github = true } = {}) {
  const candidates = [];
  const errors = {};
  const jobs = [];
  if (npm) jobs.push(['npm', () => probeNpm(fetchImpl)]);
  if (github) jobs.push(['github', () => probeGithub(fetchImpl)]);
  const results = await Promise.all(jobs.map(async ([name, fn]) => {
    try { return [name, await fn()]; } catch (err) { return [name, { ok: false, error: `${name}: ${err?.message || err}` }]; }
  }));
  for (const [name, r] of results) {
    if (r.ok && r.url) candidates.push(r);
    else errors[name] = r.error || 'probe failed';
  }
  return { candidates, errors };
}

/** sha512 SRI (`sha512-<base64>`) check for npm tarballs. Empty integrity = skip. */
export function verifyIntegrity(bytes, integrity) {
  const m = /^sha512-(.+)$/.exec(String(integrity || ''));
  if (!m) return true;
  const actual = createHash('sha512').update(bytes).digest('base64');
  return actual === m[1];
}

/**
 * Download a remote tarball into cacheDir and verify it. Returns the local path.
 * npm: sha512 integrity must match. GitHub: byte size must match the asset record.
 */
export async function downloadUpdateTgz(fetchImpl, candidate, cacheDir) {
  if (!candidate?.url || !candidate.url.startsWith('https://')) {
    throw new Error('update download requires an https url');
  }
  const res = await fetchImpl(candidate.url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res || !res.ok) throw new Error(`update download failed: HTTP ${res?.status || '?'}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new Error('update download empty');
  if (bytes.length > MAX_TGZ_BYTES) throw new Error('update tarball too large');
  if (candidate.channel === 'npm' && candidate.integrity && !verifyIntegrity(bytes, candidate.integrity)) {
    throw new Error('npm tarball sha512 integrity mismatch');
  }
  if (candidate.channel === 'github' && candidate.bytes && bytes.length !== candidate.bytes) {
    throw new Error(`github asset size mismatch (${bytes.length} != ${candidate.bytes})`);
  }
  const file = join(cacheDir, `dsh-plugin-whale-soulmate-${candidate.version}.tgz`);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, bytes);
  return file;
}