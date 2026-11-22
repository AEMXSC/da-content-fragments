import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser as LinkeDOMParser } from 'linkedom';
import { readRefs } from '../site/tools/content-fragments/refs.js';
import { findBlock, mergeRows } from '../site/tools/content-fragments/apply.js';

// browsers wrap a bare fragment in <body>; linkedom does not
class DOMParser extends LinkeDOMParser {
  parseFromString(html, type) {
    return super.parseFromString(/<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`, type);
  }
}

const HERO = (text) => `<div class="cohort-hero"><div><div><h2>${text}</h2></div></div><div><div><ul><li>tile</li></ul></div></div></div>`;

// the stored DA document: Section Metadata blocks
const stored = `<body><main>
  <div><div class="hero"><div><div>default</div></div></div></div>
  <div>${HERO('Card')}<div class="section-metadata"><div><div><p>Fragment</p></div><div><p>/content/dam/x/hero</p></div></div><div><div><p>Variation</p></div><div><p>Cardholder</p></div></div></div></div>
</main></body>`;

// the editor's live document (DA prose2aem, live preview): metadata applied as data-* on the
// section and removed; every non-metadata block carries data-block-index (an editor position)
const live = `<body><header></header><main>
  <div><div class="hero" data-block-index="3"><div><div>default</div></div></div></div>
  <div data-slot="hero" data-fragment="/content/dam/x/hero" data-variation="cardholder">${HERO('Card').replace('class="cohort-hero"', 'class="cohort-hero" data-block-index="57"')}</div>
</main><footer></footer></body>`;

test('refs from the stored document and from the live document', () => {
  for (const html of [stored, live]) {
    assert.deepEqual(readRefs(html, DOMParser).map((r) => [r.path, r.variation]), [['/content/dam/x/hero', 'cardholder']]);
  }
});

test('findBlock in the live document: ordinal index, not the editor position', () => {
  const found = findBlock(live, { path: '/content/dam/x/hero', variation: 'cardholder' }, DOMParser);
  assert.equal(found.index, 1);
  assert.ok(found.block.classList.contains('cohort-hero'));
  assert.equal(findBlock(live, { path: '/content/dam/x/other', variation: 'cardholder' }, DOMParser), null);
});

test('mergeRows replaces the template rows and keeps later rows', () => {
  const found = findBlock(live, { path: '/content/dam/x/hero', variation: 'cardholder' }, DOMParser);
  const out = mergeRows(found.block, '<div class="cohort-hero"><div><div><h2>New</h2></div></div></div>', DOMParser);
  assert.match(out, /<h2>New<\/h2>/);
  assert.match(out, /<li>tile<\/li>/);
  assert.doesNotMatch(out, /data-block-index/);
});
