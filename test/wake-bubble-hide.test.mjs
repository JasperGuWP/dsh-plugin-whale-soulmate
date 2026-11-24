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
  assert.match(browserSrc, /isVisionDumpText/);
  assert.match(browserSrc, /你是视频内容分析助手/);
});

test('wake hide: a sparse session never hides the layout container (white-screen regression)', async () => {
  const vm = await import('node:vm');
  const src = readFileSync(path.join(HERE, '../browser/wake-bubble-hide.mjs'), 'utf8');
  class El {
    constructor(tag){ this.tagName=tag; this.children=[]; this.parentElement=null; this.style={}; this.attrs={}; this._text=''; }
    appendChild(c){ c.parentElement=this; this.children.push(c); return c; }
    get textContent(){ return this._text + this.children.map(c=>c.textContent).join(''); }
    setAttribute(k,v){ this.attrs[k]=v; }
    getAttribute(k){ return this.attrs[k] ?? null; }
    get nodeType(){ return 1; }
  }
  class Text {
    constructor(v){ this.nodeValue=v; this.parentElement=null; this.nodeType=3; }
    get textContent(){ return this.nodeValue; }
  }
  const bodyEl = new El('body');
  const main = new El('main'); bodyEl.appendChild(main);
  const thread = new El('div'); main.appendChild(thread);
  const bubble = new El('div'); thread.appendChild(bubble);
  bubble.appendChild(new Text(WAKE_BUBBLE_MARK + '小海想跟你打个招呼'));
  const composer = new El('div'); main.appendChild(composer);
  composer.appendChild(new Text('输入消息…'));
  const documentStub = {
    body: bodyEl,
    createTreeWalker: (root) => {
      const texts = [];
      const walk = (el) => { for (const c of el.children||[]) { if (c.nodeType===3) texts.push(c); else walk(c); } };
      walk(root);
      let idx = 0;
      return { nextNode: () => texts[idx++] || null };
    },
  };
  const sandbox = { module:{exports:{}}, exports:{}, document: documentStub, NodeFilter:{SHOW_TEXT:4}, MutationObserver: class { observe(){} disconnect(){} }, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, {filename:'wake-bubble-hide.mjs'});
  sandbox.module.exports.scanWakeBubbles(bodyEl);
  assert.notEqual(main.style.display, 'none', 'main must never be hidden');
  assert.notEqual(bodyEl.style.display, 'none');
  assert.notEqual(thread.style.display, 'none', 'thread container must survive');
});
