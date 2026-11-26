import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clampLiveFrameEverySec,
  liveFrameBudget,
  liveFramePublicUrl,
  pickPlayurlStream,
  probeFfmpeg,
  writeFakeLiveFrames,
  LIVE_FRAME_EVERY_SEC_MIN,
} from '../packages/soulmate-bili/live-frames.mjs';

test('clampLiveFrameEverySec: densest is 5s, fine-grained 5–120 integers', () => {
  assert.equal(clampLiveFrameEverySec(1), LIVE_FRAME_EVERY_SEC_MIN);
  assert.equal(clampLiveFrameEverySec(5), 5);
  assert.equal(clampLiveFrameEverySec(7), 7);
  assert.equal(clampLiveFrameEverySec(14), 14);
  assert.equal(clampLiveFrameEverySec(15), 15);
  assert.equal(clampLiveFrameEverySec(30), 30);
  assert.equal(clampLiveFrameEverySec(120), 120);
  assert.equal(clampLiveFrameEverySec(999), 120);
  assert.equal(clampLiveFrameEverySec(undefined), 15);
});

test('liveFrameBudget: duration / everySec with hard cap', () => {
  assert.deepEqual(liveFrameBudget(150, 15), { everySec: 15, requestedEverySec: 15, count: 10, truncated: false });
  assert.equal(liveFrameBudget(60, 30).count, 2);
  const long = liveFrameBudget(3600 * 3, 15); // 3h @ 15s → 720 raw → cap 240
  assert.equal(long.count, 240);
  assert.equal(long.truncated, true);
  // The cap must widen the interval, not stop at the first 20 minutes.
  assert.equal(long.everySec, 45);
  assert.ok(long.count * long.everySec >= 3600 * 3, 'covers the whole duration');
});

test('pickPlayurlStream prefers lowest dash bandwidth', () => {
  const picked = pickPlayurlStream({
    dash: {
      video: [
        { id: 80, bandwidth: 2_000_000, baseUrl: 'https://example.test/hi.m4s' },
        { id: 16, bandwidth: 200_000, baseUrl: 'https://example.test/lo.m4s' },
      ],
    },
  });
  assert.equal(picked.url, 'https://example.test/lo.m4s');
  assert.equal(picked.kind, 'dash');
  assert.equal(pickPlayurlStream({}), null);
  assert.equal(pickPlayurlStream({ durl: [{ url: 'https://example.test/a.mp4' }] }).kind, 'durl');
});

test('liveFramePublicUrl + fake frames land on disk', async () => {
  assert.equal(liveFramePublicUrl('BV1xx411c7mD', 0), '/dsh-soulmate/api/live-frame?bvid=BV1xx411c7mD&i=0');
  const root = await mkdtemp(join(tmpdir(), 'soulmate-live-'));
  const home = { rootDir: root };
  const { files } = await writeFakeLiveFrames(home, 'BV1xx411c7mD', 3);
  assert.equal(files.length, 3);
  const buf = await readFile(join(root, 'cache', 'live-frames', 'BV1xx411c7mD', files[0]));
  assert.ok(buf.length >= 2);
});

test('probeFfmpeg: reports readiness from PATH (or missing)', async () => {
  const ok = await probeFfmpeg({});
  // CI / this machine may or may not have ffmpeg; only assert shape.
  assert.equal(typeof ok.ok, 'boolean');
  if (ok.ok) assert.ok(ok.version);
  else assert.ok(ok.error);

  const missing = await probeFfmpeg({ ffmpegPath: join(tmpdir(), 'no-such-ffmpeg-binary-xyz') });
  assert.equal(missing.ok, false);
});
