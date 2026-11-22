import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser as LinkeDOMParser } from 'linkedom';
import { render, fragmentData } from '../site/scripts/cf-render.js';
import { deliveryToData, syncSite, modelPathOf } from '../actions/sync/lib.mjs';

// browsers wrap a bare fragment in <body>; linkedom does not
class DOMParser extends LinkeDOMParser {
  parseFromString(html, type) {
    return super.parseFromString(/<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`, type);
  }
}

const PATH = '/content/dam/frescopa/fw26-intake/products/frs-mch-atm-01';
const AUTHOR = 'author-p1-e2.adobeaemcloud.com';
const MODEL = Buffer.from('/conf/frescopa/settings/dam/cfm/models/frescopa-product').toString('base64url');
const TPL = '<div class="cf-product"><div><div><h2>{{name}}</h2><p>{{format}}</p></div></div>{{#heroImage}}<div><div><picture><img src="{{heroImage}}" alt="{{name}}"></picture></div></div>{{/heroImage}}</div>';
const config = { ':names': ['content-fragments', 'content-fragment-models'], 'content-fragments': { data: [] }, 'content-fragment-models': { data: [{ model: '/conf/frescopa/settings/dam/cfm/models/frescopa-product', html: TPL }] } };
const URN = 'urn:aaid:aem:1';
const delivery = (name, extra = {}) => ({
  path: PATH, title: 'The Atelier Mini', model: { id: MODEL }, fields: { name, format: 'Brushed steel', heroImage: URN, msrp: 799 },
  references: { [URN]: { type: 'asset', value: { path: '/content/dam/frescopa/atm.png' } } }, ...extra,
});
const block = (name, variation = 'master') => render(TPL, fragmentData(deliveryToData(delivery(name)), { path: PATH, variation, assetBase: 'https://publish-p1-e2.adobeaemcloud.com' }));
const meta = (v) => `<div class="section-metadata"><div><div>Fragment</div><div>${PATH}</div></div>${v ? `<div><div>Variation</div><div>${v}</div></div>` : ''}</div>`;
const page = (name, intro = 'Intro', v = '') => `<body><header></header><main><div><p>${intro}</p></div><div>${block(name)}${meta(v)}</div></main><footer></footer></body>`;

function io({ source, live, fragments = { master: delivery('The Atelier Mini!!') } }) {
  const calls = [];
  return {
    calls,
    pages: async () => ['/drafts/fw26-catalogue.html', '/drafts/other.html'],
    source: async (p) => (p.endsWith('fw26-catalogue.html') ? source : '<body><main><div><p>no fragments</p></div></main></body>'),
    write: async (p, html) => calls.push(['write', p, html]),
    preview: async (w) => calls.push(['preview', w]),
    publish: async (w) => calls.push(['publish', w]),
    live: async () => live,
    config: async () => config,
    file: async () => TPL,
    fragment: async (v) => fragments[v],
    redirects: async () => null,
    log: () => {},
  };
}
const run = (x) => syncSite(x, { path: PATH, author: AUTHOR, DOMParserImpl: DOMParser });

test('deliveryToData: flat publish fields → renderer fields; asset ids → /content/dam paths', () => {
  const d = deliveryToData(delivery('X'));
  assert.deepEqual(d.fields.find((f) => f.name === 'heroImage'), { name: 'heroImage', multiple: false, type: 'content-reference', values: ['/content/dam/frescopa/atm.png'] });
  assert.deepEqual(d.fields.find((f) => f.name === 'msrp'), { name: 'msrp', multiple: false, type: 'number', values: [799] });
  assert.equal(modelPathOf(MODEL), '/conf/frescopa/settings/dam/cfm/models/frescopa-product');
});

test('published fragment changed: the page is rewritten, previewed and published', async () => {
  const x = io({ source: page('The Atelier Mini'), live: page('The Atelier Mini') });
  const r = await run(x);
  assert.deepEqual(r, [{ page: '/drafts/fw26-catalogue', result: 'published' }]);
  assert.deepEqual(x.calls.map((c) => c[0]), ['write', 'preview', 'publish']);
  assert.match(x.calls[0][2], /<h2>The Atelier Mini!!<\/h2>/);
  assert.match(x.calls[0][2], /<p>Intro<\/p>/); // the rest of the page is kept
  assert.match(x.calls[0][2], /src="https:\/\/publish-p1-e2\.adobeaemcloud\.com\/content\/dam\/frescopa\/atm\.png"/);
});

test('page already shows AEM content: nothing is written', async () => {
  const x = io({ source: page('The Atelier Mini!!'), live: page('The Atelier Mini!!') });
  assert.deepEqual(await run(x), [{ page: '/drafts/fw26-catalogue', result: 'unchanged' }]);
  assert.equal(x.calls.length, 0);
});

test('page has other unpublished edits (or was never published): previewed, not published', async () => {
  const x = io({ source: page('The Atelier Mini', 'Intro, edited'), live: page('The Atelier Mini', 'Intro') });
  assert.match((await run(x))[0].result, /not published/);
  assert.deepEqual(x.calls.map((c) => c[0]), ['write', 'preview']);
  const y = io({ source: page('The Atelier Mini'), live: null });
  assert.match((await run(y))[0].result, /not published/);
});

test('a section showing a variation gets that variation', async () => {
  const x = io({
    source: page('The Atelier Mini', 'Intro', 'cafe_partners'),
    live: page('The Atelier Mini', 'Intro', 'cafe_partners'),
    fragments: { cafe_partners: delivery('Atelier Mini for cafés') },
  });
  await run(x);
  assert.match(x.calls[0][2], /<h2>Atelier Mini for cafés<\/h2>/);
});

test('long text from publish ({ value, mimeType }) renders as text', () => {
  const d = deliveryToData({ ...delivery('X'), fields: { description: { value: 'Bean-to-cup heart.', mimeType: 'text/plain' } } });
  assert.deepEqual(d.fields[0].values, ['Bean-to-cup heart.']);
});

test('a page DA rewrote (picture sources, lazy loading, spacing) still counts as unchanged', async () => {
  const daPicture = (h) => h.replace(/<picture><img src="([^"]+)" alt="([^"]*)"><\/picture>/, '<picture><source srcset="$1"><source srcset="$1" media="(min-width: 600px)"><img src="$1" alt="$2" loading="lazy"></picture>');
  const source = page('The Atelier Mini!!').replace('<p>Intro</p>', '<h1>FW26 collection</h1><p>Intro</p>');
  const x = io({ source: daPicture(source), live: source.replace('</h1><p>', '</h1>\n<p>') });
  assert.deepEqual(await run(x), [{ page: '/drafts/fw26-catalogue', result: 'unchanged' }]);
});
