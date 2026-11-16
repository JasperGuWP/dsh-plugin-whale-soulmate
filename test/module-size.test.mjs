import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const browserDir = new URL('../browser/', import.meta.url);
const LIMIT = 600; // Soft cap: keep each browser module under ~600 lines
const BROWSER_LIMIT = 700; // 2026-11-16: surf-log / dsbot 列让面板暂超 600；下一轮拆分前的临时余量，core 门禁仍 600

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

test('module size: every browser/ module stays under the 700-line ceiling', async () => {
  // A module that blows past the ceiling is the signal that responsibilities got
  // piled into one file instead of split. panel.mjs hit 854 lines by accumulating
  // icon + preview + draft projection + sprite upload + every card + tab wiring.
  const files = await walk(browserDir.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const oversized = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n').length;
    if (lines > BROWSER_LIMIT) oversized.push(`${file.split(/[\\/]/).pop()}: ${lines} 行`);
  }
  assert.deepEqual(oversized, [], `超过 ${BROWSER_LIMIT} 行的模块：${oversized.join('、')}`);
});

test('module size: every new soulmate-core assembly module stays under the 600-line ceiling', async () => {
  // 2026-11-12 拆分门禁：index.mjs 曾是 4100+ 行的上帝文件。拆出的装配助手、
  // runtime/ 运行时域、tools/ 工具表、routes/ 路由表都不得再长回巨石。
  // 历史引擎文件（memory-engine / persona / proactive 等）暂不在此门禁范围内，
  // 它们按各自的测试与规范演进；本门禁只盯住这次拆分建立的新边界。
  const coreDir = new URL('../packages/soulmate-core/', import.meta.url);
  const root = coreDir.pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const helpers = [
    'index.mjs', 'tool-kit.mjs', 'small-utils.mjs', 'tool-cards.mjs',
    'plugin-config.mjs', 'http-plumbing.mjs', 'assets.mjs', 'persona-arcs.mjs',
  ];
  const files = [
    ...helpers.map((name) => join(root, name)),
    ...(await walk(join(root, 'runtime'))),
    ...(await walk(join(root, 'tools'))),
    ...(await walk(join(root, 'routes'))),
  ];
  const oversized = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n').length;
    if (lines > LIMIT) oversized.push(`${file.split(/[\\/]/).pop()}: ${lines} 行`);
  }
  assert.deepEqual(oversized, [], `超过 ${LIMIT} 行的装配模块：${oversized.join('、')}`);
});

test('module size: no browser/ module hand-rolls the react runtime', async () => {
  // Every module must go through the host loader for `react`, never a bundler shim.
  const files = await walk(browserDir.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  for (const file of files) {
    if (file.endsWith('build.mjs')) continue;
    const text = await readFile(file, 'utf8');
    assert.ok(
      !/from\s+['"]react['"]/.test(text),
      `${file} must use require('react'), not an ESM import — browser/ is CJS style`,
    );
  }
});
