import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function loadStage() {
  const src = await readFile(new URL('../browser/pet-stage.mjs', import.meta.url), 'utf8');
  const sandbox = {
    module: { exports: {} },
    exports: {},
    document: {
      createElement: (tag) => {
        const el = {
          tagName: String(tag).toUpperCase(),
          className: '',
          style: {},
          children: [],
          title: '',
          appendChild(child) { this.children.push(child); return child; },
          setAttribute() {},
          classList: { add() {}, remove() {}, contains() { return false; } },
        };
        return el;
      },
    },
  };
  vm.runInNewContext(src, sandbox, { filename: 'pet-stage.mjs' });
  return sandbox.module.exports;
}

test('pet-stage: setSize uses height and 16/9 width', async () => {
  const { createPetStage } = await loadStage();
  const sprite = { classList: { add() {} }, style: {}, className: '' };
  const stageApi = createPetStage({ spriteImg: sprite });
  const box = stageApi.setSize(180);
  assert.equal(box.height, 180);
  assert.equal(box.width, 320);
  assert.equal(stageApi.stage.style.height, '180px');
  assert.equal(stageApi.stage.style.width, '320px');
});

test('pet-stage: hit fractions stay inside the stage', async () => {
  const { HIT_FRAC } = await loadStage();
  assert.ok(HIT_FRAC.left >= 0 && HIT_FRAC.top >= 0);
  assert.ok(HIT_FRAC.left + HIT_FRAC.width <= 1);
  assert.ok(HIT_FRAC.top + HIT_FRAC.height <= 1);
});

test('pet-stage: setSpriteVisible toggles display', async () => {
  const { createPetStage } = await loadStage();
  const sprite = { classList: { add() {} }, style: { display: '' }, className: '' };
  const stageApi = createPetStage({ spriteImg: sprite });
  stageApi.setSpriteVisible(false);
  assert.equal(sprite.style.display, 'none');
  stageApi.setSpriteVisible(true);
  assert.equal(sprite.style.display, '');
});
