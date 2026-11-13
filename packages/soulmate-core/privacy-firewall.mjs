// Soulmate privacy firewall: secret detection, PII scrubbing, E2EE, outbound audit ledger.
// Pure Node ESM, zero external dependencies.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const API_KEY_REASON = 'Detected API secret key';

const SECRET_RULES = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/, reason: 'Detected private key block' },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{2,}/, reason: 'Detected JWT token' },
  { re: /\bsk-[A-Za-z0-9_-]{16,}/, reason: `${API_KEY_REASON} (OpenAI/DeepSeek/Anthropic sk-...)` },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, reason: `${API_KEY_REASON} (AWS access key)` },
  {
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/,
    reason: `${API_KEY_REASON} (GitHub token)`,
  },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, reason: `${API_KEY_REASON} (Slack token)` },
  {
    re: /\b(?:SESSDATA|bili_jct|DedeUserID__ckMd5)\s*=\s*[^\s;]+/i,
    reason: 'Detected web login cookie (SESSDATA/bili_jct)',
  },
  { re: /^\s*(?:Set-)?Cookie:\s*\S+/im, reason: 'Detected Cookie header' },
  {
    re: /\b(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?[^\s"';,]{4,}/i,
    reason: 'Detected password/secret assignment',
  },
  { re: /(?:密码|密钥|口令|秘钥)\s*[:：=]\s*\S{2,}/, reason: 'Detected password/secret assignment (密码/密钥)' },
  {
    re: /\b[A-Z][A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*\s*=\s*\S+/,
    reason: 'Detected .env credential assignment',
  },
  {
    re: /(?:\b(?:cat|type|source|load|read|dotenv)\s+|读取|加载)\S*\.env(?:\.[\w-]+)?\b/i,
    reason: 'Detected .env credential file reference',
  },
  {
    re: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/,
    reason: 'Detected mainland ID number (18-digit)',
  },
];

/** Returns a human-readable reason when `text` contains a high-risk secret, else null. */
export function detectHighRiskSecret(text) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  for (const { re, reason } of SECRET_RULES) {
    if (re.test(s)) return reason;
  }
  return null;
}

/** Replace local identifiers with placeholders. Returns { scrubbedText, redactions }. */
export function scrubText(text) {
  let out = typeof text === 'string' ? text : String(text ?? '');
  const redactions = [];
  const note = (name) => {
    if (!redactions.includes(name)) redactions.push(name);
  };

  // Windows home: C:\Users\<name>\rest -> <HOME>/rest
  out = out.replace(
    /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>|:*?，。；、]+((?:[\\/]+[^\s"'<>|*?，。；、]*)?)/gi,
    (_m, rest) => {
      note('path');
      return `<HOME>${String(rest).replace(/[\\/]+/g, '/')}`;
    }
  );
  // POSIX home: /Users/<name>/rest or /home/<name>/rest -> <HOME>/rest
  out = out.replace(/(?<![\w.<>-])\/(?:Users|home)\/[^/\s"'<>:，。；、]+/g, () => {
    note('path');
    return '<HOME>';
  });
  // Emails
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, () => {
    note('email');
    return '<EMAIL>';
  });
  // Mainland mobile numbers
  out = out.replace(/(?<![\d.])(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, () => {
    note('phone');
    return '<PHONE>';
  });
  // Private LAN IPs
  out = out.replace(
    /(?<![\d.])(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])/g,
    () => {
      note('lan_ip');
      return '<LAN_IP>';
    }
  );

  return { scrubbedText: out, redactions };
}

/**
 * Outbound gate: hard-block secrets, otherwise scrub PII.
 * options: { blockSecrets = true, scrub = true }
 */
export function inspectAndScrub(text, options = {}) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  if (options.blockSecrets !== false) {
    const blockedReason = detectHighRiskSecret(raw);
    if (blockedReason) {
      return { allowed: false, blockedReason, scrubbedText: '', redactions: [] };
    }
  }
  if (options.scrub === false) {
    return { allowed: true, blockedReason: null, scrubbedText: raw, redactions: [] };
  }
  const { scrubbedText, redactions } = scrubText(raw);
  return { allowed: true, blockedReason: null, scrubbedText, redactions };
}

const KDF_ITERATIONS = 210_000;

function deriveKey(passphrase, salt, iterations) {
  return pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256');
}

/** AES-256-GCM with a PBKDF2-SHA256 derived key. All binary fields are base64. */
export function encryptPayload(plainText, passphrase) {
  if (typeof passphrase !== 'string' || !passphrase) {
    throw new Error('[soulmate] E2EE passphrase must be a non-empty string');
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt, KDF_ITERATIONS), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText ?? ''), 'utf8'), cipher.final()]);
  return {
    e2ee: true,
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: KDF_ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptPayload(envelope, passphrase) {
  if (!envelope || envelope.e2ee !== true || envelope.alg !== 'AES-256-GCM') {
    throw new Error('[soulmate] not an AES-256-GCM E2EE envelope');
  }
  if (typeof passphrase !== 'string' || !passphrase) {
    throw new Error('[soulmate] E2EE passphrase must be a non-empty string');
  }
  try {
    const salt = Buffer.from(envelope.salt, 'base64');
    const iv = Buffer.from(envelope.iv, 'base64');
    const key = deriveKey(passphrase, salt, Number(envelope.iterations) || KDF_ITERATIONS);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('[soulmate] E2EE decrypt failed: wrong passphrase or corrupted payload');
  }
}

/** Append one JSONL audit record: { timestamp, ...record }. */
export async function appendPrivacyAudit(home, record) {
  await mkdir(dirname(home.auditLogPath), { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...(record ?? {}) });
  await appendFile(home.auditLogPath, `${line}\n`, 'utf8');
}

/** Read the last `limit` audit records (chronological order). Missing log -> []. */
export async function readPrivacyAudit(home, limit = 50) {
  let raw;
  try {
    raw = await readFile(home.auditLogPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip a torn/corrupted line rather than failing the whole ledger
    }
  }
  const n = Math.max(0, Math.floor(Number(limit)) || 0);
  return n ? records.slice(-n) : [];
}
