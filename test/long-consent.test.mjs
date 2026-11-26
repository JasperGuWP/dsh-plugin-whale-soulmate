// User rule (2026-11-26): an extra-long Bilibili video is watched only after the user
// agrees. Auto-surf parks it in the consent queue; nothing about the video is consumed
// (frames / subtitles / ASR / vision / memory) until a human says yes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSoulmateHome } from '../packages/soulmate-core/state.mjs';
import {
  DEFAULT_LONG_VIDEO_CONSENT_MINUTES,
  listPendingLongConsents,
  longVideoConsentMinutes,
  needsLongVideoConsent,
  requestLongConsent,
  resolveLongConsent,
  settleLongConsent,
} from '../packages/soulmate-bili/long-consent.mjs';
import { watchAndRecordVideo } from '../packages/soulmate-bili/index.mjs';

const T0 = Date.parse('2026-11-26T03:00:00Z');

test('long consent: threshold defaults to 60 minutes; 0 disables the gate', () => {
  assert.equal(DEFAULT_LONG_VIDEO_CONSENT_MINUTES, 60);
  assert.equal(longVideoConsentMinutes({}), 60);
  assert.equal(longVideoConsentMinutes({ biliLongVideoConsentMinutes: 30 }), 30);
  assert.equal(longVideoConsentMinutes({ biliLongVideoConsentMinutes: 0 }), 0);
  assert.equal(needsLongVideoConsent(65 * 60, {}), true);
  assert.equal(needsLongVideoConsent(59 * 60, {}), false);
  assert.equal(needsLongVideoConsent(65 * 60, { biliLongVideoConsentMinutes: 0 }), false);
  assert.equal(needsLongVideoConsent(65 * 60, { biliLongVideoConsentMinutes: 90 }), false);
});

test('long consent: watch is held before any consumption; auto parks it for approval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-consent-'));
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    const service = { home, retainFact: async () => ({ ok: true }) };
    const digest = {
      ok: true,
      bvid: 'BVLONG65',
      title: '65分钟一口气吃透整个AI产业',
      author: '木子不写代码',
      durationSec: 65 * 60,
      url: 'https://www.bilibili.com/video/BVLONG65/',
      coverUrl: '',
    };

    // A model-initiated watch: no consent -> held, and NOT parked (it is asked in chat).
    const manual = await watchAndRecordVideo(service, { target: digest.bvid }, { digest, nowMs: T0 });
    assert.equal(manual.ok, false);
    assert.equal(manual.needsConsent, true);
    assert.equal(manual.held, true);
    assert.equal(manual.consent, null);
    assert.match(manual.error, /65/);

    // Auto-surf: same hold, but parked in the queue for the panel / chat to approve.
    const auto = await watchAndRecordVideo(service, { target: digest.bvid, source: 'popular' }, { digest, auto: true, nowMs: T0 });
    assert.equal(auto.needsConsent, true);
    assert.ok(auto.consent && auto.consent.bvid === 'BVLONG65');

    const pending = await listPendingLongConsents(home, { nowMs: T0 });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].title, digest.title);
    assert.equal(pending[0].durationSec, 65 * 60);

    // Duplicate auto find does not create a second pending row.
    await requestLongConsent(home, { ...digest, nowMs: T0 + 1000 });
    assert.equal((await listPendingLongConsents(home, { nowMs: T0 })).length, 1);

    // Decline removes it from pending.
    const declined = await resolveLongConsent(home, { bvid: 'BVLONG65', action: 'decline', nowMs: T0 + 2000 });
    assert.equal(declined.status, 'declined');
    assert.equal((await listPendingLongConsents(home, { nowMs: T0 + 3000 })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('long consent: approve -> settle leaves honest state; expired pending is hidden', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-consent2-'));
  try {
    const home = resolveSoulmateHome(join(dir, 'home'));
    await mkdir(home.rootDir, { recursive: true });
    await requestLongConsent(home, { bvid: 'BVA', title: 'A', durationSec: 3900, nowMs: T0 });
    await requestLongConsent(home, { bvid: 'BVB', title: 'B', durationSec: 4000, nowMs: T0 - 4 * 86_400_000 });
    assert.equal((await listPendingLongConsents(home, { nowMs: T0 })).length, 1, 'expired row hidden');

    const approved = await resolveLongConsent(home, { bvid: 'BVA', action: 'approve', nowMs: T0 + 1000 });
    assert.equal(approved.status, 'approved');
    assert.equal((await listPendingLongConsents(home, { nowMs: T0 + 1500 })).length, 0);

    const settled = await settleLongConsent(home, { bvid: 'BVA', status: 'watched', nowMs: T0 + 2000 });
    assert.equal(settled.status, 'watched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});