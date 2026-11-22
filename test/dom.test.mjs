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

test('Content Advisor picks: master by default, variations expanded, bad input refused', async () => {
  const { picks } = await import('../site/tools/content-fragments/advisor.js');
  assert.deepEqual(picks([{ path: '/content/dam/x/a' }, { path: '/content/dam/x/b', variations: ['master', { name: 'member' }] }]), [
    { path: '/content/dam/x/a', variation: 'master' }, { path: '/content/dam/x/b', variation: 'master' }, { path: '/content/dam/x/b', variation: 'member' }]);
  assert.throws(() => picks([]));
  assert.throws(() => picks([{ path: '/etc/passwd' }]));
  assert.throws(() => picks([{ path: '/content/dam/x/a', variations: ['bad name'] }]));
});

test('inserted section: section breaks, the block as a table, Section Metadata with Fragment and Variation', async () => {
  const { sectionInsert } = await import('../site/tools/content-fragments/advisor.js');
  const html = sectionInsert('<div class="cohort-hero dark"><div><div><h2>Hi</h2></div></div><div><div>a</div><div>b</div></div></div>', { path: '/content/dam/x/a', variation: 'member' }, DOMParser);
  // the one-cell row spans both columns, so the editor does not pad it with an empty cell
  assert.ok(html.startsWith('<hr><table><tr><td colspan="2">cohort-hero (dark)</td></tr><tr><td colspan="2"><h2>Hi</h2></td></tr><tr><td>a</td><td>b</td></tr></table>'));
  assert.match(html, /<td colspan="2">section-metadata<\/td><\/tr><tr><td>Fragment<\/td><td>\/content\/dam\/x\/a<\/td><\/tr><tr><td>Variation<\/td><td>member<\/td><\/tr><\/table><hr>$/);
  assert.doesNotMatch(sectionInsert('<div class="hero"><div><div>x</div></div></div>', { path: '/content/dam/x/a', variation: 'master' }, DOMParser), /Variation/);
});
