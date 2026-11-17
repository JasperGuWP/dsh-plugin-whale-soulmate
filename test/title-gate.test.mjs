import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assessTitleWatchWorth,
  normalizeTitleForGate,
} from '../packages/soulmate-bili/title-gate.mjs';

test('normalizeTitleForGate unfolds unicode slash smuggling', () => {
  const t = normalizeTitleForGate('復楽園 - https：⧸⧸t.co⧸BREH9WIgH7 #1');
  assert.match(t, /https:\/\/t\.co\//i);
});

test('assessTitleWatchWorth rejects short-link / follow bait / keeps normal titles', () => {
  assert.equal(assessTitleWatchWorth('復楽園 - https：⧸⧸t.co⧸BREH9WIgH7 #1').ok, false);
  assert.equal(assessTitleWatchWorth('please biliBili team follow me I will you follow back').ok, false);
  assert.equal(assessTitleWatchWorth('Newest video is live, come join the crowd!').ok, false);
  assert.equal(assessTitleWatchWorth('Ehn (• •) - https://t.co/piF2fbikSo').ok, false);
  assert.equal(assessTitleWatchWorth('x.com/foo/status/123').ok, false);

  const good = assessTitleWatchWorth('不挑题材不挑档期，肖战凭《小城良方》再次证明超强国民度');
  assert.equal(good.ok, true);
  assert.equal(good.kind, 'ok');

  const tech = assessTitleWatchWorth('LangChain 接上 MCP 之后工具怎么管？多服务注册与失败隔离');
  assert.equal(tech.ok, true);
});
