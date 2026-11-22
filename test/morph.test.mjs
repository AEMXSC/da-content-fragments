import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<html><body></body></html>');
globalThis.Node = window.Node;
const { morph } = await import('../site/scripts/cf-bridge.js');
const frag = (html) => { const d = window.document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };

test('morph keeps the block element and the editor attributes on matching text elements', () => {
  const live = frag('<div class="cohort-hero block" data-block-index="57" data-block-status="loaded"><div class="cohort-hero-text"><div><p data-prose-index="400">Eyebrow</p><h2 data-prose-index="412">Old title</h2><ul><li>a</li></ul></div></div></div>');
  const h2 = live.querySelector('h2');
  const next = frag('<div class="cohort-hero block"><div class="cohort-hero-text"><div><p>Eyebrow</p><p>New lede</p><h2>New title</h2><p>Body</p></div></div></div>');
  morph(live, next);
  assert.equal(live.getAttribute('data-block-index'), '57');
  assert.equal(live.getAttribute('data-block-status'), 'loaded');
  assert.equal(live.querySelector('h2'), h2, 'the h2 is the same element');
  assert.equal(h2.getAttribute('data-prose-index'), '412');
  assert.equal(h2.textContent, 'New title');
  assert.equal(live.querySelector('.cohort-hero-text > div').innerHTML.replace(/ data-prose-index="\d+"/g, ''), '<p>Eyebrow</p><p>New lede</p><h2>New title</h2><p>Body</p>');
});
