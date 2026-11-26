// Desktop-pet bubble: two lines × 25 characters, animated dots for truncated replies,
// and a rect the widget unions into the click-through body box.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function loadBubble() {
  const src = await readFile(new URL('../browser/pet-bubble.mjs', import.meta.url), 'utf8');
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    setTimeout,
    clearTimeout,
    String,
    Number,
    Math,
    Array,
    Object,
  };
  vm.runInNewContext(src, sandbox, { filename: 'pet-bubble.mjs' });
  return sandbox.module.exports;
}

function fakeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: tag,
    style: {
      setProperty(k, v) { this[k] = v; },
    },
    children: [],
    attrs: {},
    parentNode: null,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      el.children = el.children.filter((x) => x !== child);
      child.parentNode = null;
    },
    setAttribute(k, v) { el.attrs[k] = v; },
    addEventListener() {},
    getBoundingClientRect() {
      return { left: 100, top: 80, right: 340, bottom: 140, width: 240, height: 60 };
    },
  };
  let text = '';
  Object.defineProperty(el, 'textContent', {
    get() { return text; },
    set(v) {
      text = String(v == null ? '' : v);
      // Real DOM replaces children when textContent is assigned.
      el.children = [];
    },
  });
  return el;
}

function fakeDoc() {
  return {
    createElement: fakeEl,
    createTextNode: (t) => ({ nodeType: 3, textContent: t, parentNode: null }),
  };
}

test('pet bubble: 25 chars per line, 2 lines max, truncated dots after the 50th', async () => {
  const { splitPetBubbleText, DEFAULT_LINE_CHARS, DEFAULT_LINES } = await loadBubble();
  assert.equal(DEFAULT_LINE_CHARS, 25);
  assert.equal(DEFAULT_LINES, 2);

  const short = splitPetBubbleText('早上好');
  assert.equal(short.lines.join('\n'), '早上好');
  assert.equal(short.truncated, false);

  const exactly = splitPetBubbleText('好'.repeat(50));
  assert.equal(exactly.lines.length, 2);
  assert.equal(exactly.lines[0].length, 25);
  assert.equal(exactly.lines[1].length, 25);
  assert.equal(exactly.truncated, false);

  const long = splitPetBubbleText('好'.repeat(80));
  assert.equal(long.lines.length, 2);
  assert.equal(long.lines[0].length, 25);
  assert.equal(long.lines[1].length, 25);
  assert.equal(long.truncated, true);
  assert.equal(long.fullLength, 80);

  // Emoji count as one character and never split mid-glyph.
  const emoji = splitPetBubbleText('🐳'.repeat(60));
  assert.equal(emoji.lines.length, 2);
  assert.equal(emoji.lines[0], '🐳'.repeat(25));
  assert.equal(emoji.truncated, true);

  // Newlines / runs of whitespace collapse to a single space.
  assert.equal(splitPetBubbleText('第一行\n\n第二行   第三行').lines.join('\n'), '第一行 第二行 第三行');
});

test('pet bubble: DOM shows two lines + 3 animated dots, dedupes the 2s state poll', async () => {
  const { createPetBubble } = await loadBubble();
  const doc = fakeDoc();
  const mount = fakeEl('div');
  const bubble = createPetBubble({ doc, mount, ttlMs: 0 });
  assert.ok(bubble);
  assert.equal(mount.children.length, 1);

  const text = '这是一段超过五十个字的回复'.repeat(6);
  assert.equal(bubble.show(text, { at: '2026-11-26T14:00:00Z', loading: true }), true);
  assert.equal(bubble.visible(), true);

  const el = bubble.el;
  const line1 = el.children[0];
  const line2 = el.children[1];
  assert.equal(line1.textContent, Array.from(text).slice(0, 25).join(''));
  assert.equal(line2.children.filter((c) => c.className === 'sm-pet-dots').length, 1);
  const dots = line2.children.find((c) => c.className === 'sm-pet-dots');
  assert.equal(dots.children.length, 3);
  assert.equal(dots.children[0].tagName, 'i');

  // Same at+text from the next poll does not restart the bubble timer.
  assert.equal(bubble.show(text, { at: '2026-11-26T14:00:00Z', loading: true }), false);
  // Settled reply: same long text, no animated dots any more.
  assert.equal(bubble.show(text, { at: '2026-11-26T14:00:01Z', loading: false }), true);
  assert.equal(line2.children.filter((c) => c.className === 'sm-pet-dots').length, 0, 'finished reply has no dots');
  // A new short reply updates it.
  assert.equal(bubble.show('新的一句回复', { at: '2026-11-26T14:00:02Z' }), true);
  assert.equal(line2.style.display, 'none', 'short reply needs one line');
  // Light Markdown is stripped from the preview text.
  assert.equal(bubble.show('今天能定的，就这几件。 **中美关税**：美方', { at: '2026-11-26T14:00:03Z' }), true);
  assert.equal(line1.textContent, '今天能定的，就这几件。 中美关税：美方');

  assert.equal(bubble.contains(120, 100), true);
  assert.equal(bubble.contains(20, 20), false);
  bubble.hide();
  assert.equal(bubble.visible(), false);
  assert.equal(bubble.rect(), null);
  bubble.dispose();
  assert.equal(mount.children.length, 0);
});
test('pet bubble: shifts back inside the viewport instead of clipping at a screen edge', async () => {
  const { createPetBubble } = await loadBubble();
  const doc = fakeDoc();
  doc.defaultView = { innerWidth: 400 };
  const mount = fakeEl('div');
  const bubble = createPetBubble({ doc, mount, ttlMs: 0 });

  bubble.el.getBoundingClientRect = () => ({ left: 300, right: 700, top: 80, bottom: 140, width: 400, height: 60 });
  bubble.show('边角测试', { at: 'right' });
  assert.equal(bubble.el.style['--sm-pet-bubble-shift'], '-308px');

  bubble.hide();
  bubble.el.getBoundingClientRect = () => ({ left: -50, right: 300, top: 80, bottom: 140, width: 350, height: 60 });
  bubble.show('左边测试', { at: 'left' });
  assert.equal(bubble.el.style['--sm-pet-bubble-shift'], '58px');
});

test('pet bubble: auto-hides after the factory TTL when show() passes no ttl', async () => {
  const { createPetBubble } = await loadBubble();
  const bubble = createPetBubble({ doc: fakeDoc(), mount: fakeEl('div'), ttlMs: 20 });
  bubble.show('短回复', { at: 'ttl' });
  assert.equal(bubble.visible(), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bubble.visible(), false);
});
