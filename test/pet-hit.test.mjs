import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function loadHit() {
  const src = await readFile(new URL('../browser/pet-hit.mjs', import.meta.url), 'utf8');
  const sandbox = {
    module: { exports: {} },
    exports: {},
    document: {
      createElement: () => {
        const data = new Uint8ClampedArray([0, 0, 0, 0]);
        return {
          width: 1,
          height: 1,
          getContext: () => ({
            drawImage() {},
            getImageData: () => ({ data }),
          }),
        };
      },
    },
  };
  vm.runInNewContext(src, sandbox, { filename: 'pet-hit.mjs' });
  return sandbox.module.exports;
}

test('pet-hit: outside media box is transparent (alpha 0)', async () => {
  const { sampleMediaAlpha } = await loadHit();
  const media = {
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 200, bottom: 200, width: 100, height: 100 }),
    videoWidth: 100,
    videoHeight: 100,
    naturalWidth: 0,
    naturalHeight: 0,
  };
  assert.equal(sampleMediaAlpha(media, 50, 50), 0);
});

test('pet-hit: unreadably sized sprite fails closed by default', async () => {
  const { isOpaquePetPixel } = await loadHit();
  const spriteImg = {
    style: { visibility: '', display: '' },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }),
    naturalWidth: 0,
    naturalHeight: 0,
  };
  assert.equal(isOpaquePetPixel({ clientX: 5, clientY: 5, spriteImg }), false);
  assert.equal(isOpaquePetPixel({ clientX: 5, clientY: 5, spriteImg, failClosed: false }), true);
});

test('pet-hit: no media yet keeps a hit target (boot / canvas avatar)', async () => {
  const { isOpaquePetPixel } = await loadHit();
  assert.equal(isOpaquePetPixel({ clientX: 0, clientY: 0 }), true);
});
