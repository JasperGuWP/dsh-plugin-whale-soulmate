import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WAKE_BUBBLE_MARK, isWakeBubbleText } from '../packages/soulmate-core/chat-home.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('wake mark: browser copy stays in sync with core', () => {
  const browserSrc = readFileSync(
    path.join(HERE, '../browser/wake-bubble-hide.mjs'),
    'utf8',
  );
  assert.match(browserSrc, /WAKE_BUBBLE_MARK\s*=\s*'\\u2063\\u2063soulmate-wake\\u2063\\u2063'/);
  assert.equal(WAKE_BUBBLE_MARK, '\u2063\u2063soulmate-wake\u2063\u2063');
  assert.equal(isWakeBubbleText(WAKE_BUBBLE_MARK + '想打招呼'), true);
  assert.equal(isWakeBubbleText('想打招呼'), false);
});
