import test from 'node:test';
import assert from 'node:assert/strict';
import { starterTemplate, roles } from '../site/tools/content-fragments/starter.js';
import { mergeConfig } from '../site/tools/content-fragments/setup.js';
import { render, fragmentData } from '../site/scripts/cf-render.js';

// field lists as AEM's Management API returns them (Frescopa Product, TSC Category Tile)
const PRODUCT = {
  fields: [
    { name: 'sku', type: 'text', label: 'SKU' }, { name: 'name', type: 'text', label: 'Product name' },
    { name: 'category', type: 'text', label: 'Category' }, { name: 'msrp', type: 'number', label: 'MSRP' },
    { name: 'description', type: 'long-text', mimeType: 'text/plain', label: 'Description' },
    { name: 'heroImage', type: 'content-reference', label: 'Hero image' }, { name: 'flags', type: 'boolean', label: 'Flags' },
  ],
};
const TILE = { fields: [{ name: 'label', type: 'text', label: 'Label' }, { name: 'imageId', type: 'text', label: 'Scene7 image id' }, { name: 'url', type: 'text', label: 'Link' }] };

test('starter roles: title by name, image reference, link, the rest listed', () => {
  const r = roles(PRODUCT.fields);
  assert.equal(r.title.name, 'name');
  assert.equal(r.image.name, 'heroImage');
  assert.deepEqual(r.rest.map((f) => f.name), ['sku', 'category', 'msrp', 'description']);
  assert.equal(roles(TILE.fields).link.name, 'url');
});

test('starter template renders a cf-card from real values', () => {
  const tpl = starterTemplate(PRODUCT);
  const html = render(tpl, fragmentData({
    fields: [
      { name: 'sku', type: 'text', values: ['FRS-1'] }, { name: 'name', type: 'text', values: ['The <Atelier>'] },
      { name: 'category', type: 'text', values: [''] }, { name: 'msrp', type: 'number', values: [2199] },
      { name: 'description', type: 'long-text', values: ['Learns your coffee.'] },
      { name: 'heroImage', type: 'content-reference', values: ['/content/dam/f/a.jpg'] },
    ],
  }, { assetBase: 'https://publish-p1-e2.adobeaemcloud.com' }));
  assert.equal(html, '<div class="cf-card"><div><div><picture><img src="https://publish-p1-e2.adobeaemcloud.com/content/dam/f/a.jpg" alt="The &lt;Atelier&gt;"></picture></div>'
    + '<div><h3>The &lt;Atelier&gt;</h3><p><strong>SKU</strong> FRS-1</p><p><strong>MSRP</strong> 2199</p><p>Learns your coffee.</p></div></div></div>');
  // a title with a link: the heading links; without a value, a plain heading
  const tile = starterTemplate(TILE);
  assert.match(render(tile, { label: 'Fencing', url: '/x' }), /<h3><a href="\/x">Fencing<\/a><\/h3>/);
  assert.match(render(tile, { label: 'Fencing', url: '' }), /<h3>Fencing<\/h3>/);
  // a model label is literal text in the template, never a tag
  assert.doesNotMatch(starterTemplate({ fields: [{ name: 't', type: 'text' }, { name: 'n', type: 'number', label: '{{x}}<b>' }] }), /\{\{x\}\}|<b>/);
});

test('mergeConfig: settings and models upserted, library entries added, other sheets kept', () => {
  const raw = {
    ':names': ['library', 'content-fragment-models', 'other'],
    ':version': 3,
    ':type': 'multi-sheet',
    library: { data: [{ title: 'Cohorts', path: '/tools/cohorts/index.html', experience: '' }] },
    'content-fragment-models': { data: [{ model: '/conf/a', template: '/t/a.html', label: 'A' }] },
    other: { data: [{ x: '1' }] },
  };
  const out = mergeConfig(raw, {
    settings: { author: 'author-p1-e2.adobeaemcloud.com', broker: 'https://b/api/v1/web/p/a' },
    models: [{ model: '/conf/b', label: 'B', html: '<div class="cf-card"></div>' }],
    panelPath: '/tools/content-fragments/index.html',
  });
  assert.deepEqual(out.other, raw.other);
  assert.deepEqual(out['content-fragment-models'].data.map((r) => r.model), ['/conf/a', '/conf/b']);
  assert.equal(out['content-fragment-models'].data[0].template, '/t/a.html');
  assert.deepEqual(out.library.data.map((r) => r.title), ['Cohorts', 'Content Fragments', 'Content Advisor']);
  assert.equal(out.library.data[2].experience, 'fullsize-dialog');
  assert.equal(out['content-fragments'].data.find((r) => r.key === 'author').value, 'author-p1-e2.adobeaemcloud.com');
  assert.ok(out[':names'].includes('content-fragments'));
  assert.equal(raw.library.data.length, 1, 'input not mutated');
  assert.ok(mergeConfig({}, { settings: {}, models: [], panelPath: '/p' })[':names'].includes('library'));
});

test('folder browser: suggested folder and breadcrumb trail', async () => {
  const { suggests, trail } = await import('../site/tools/content-fragments/folders.js');
  assert.equal(suggests('frescopa', 'frescopa26'), true);
  assert.equal(suggests('tsc', 'tsc'), true);
  assert.equal(suggests('wknd', 'frescopa26'), false);
  assert.equal(suggests('fre', 'frescopa26'), false); // too short to be a prefix match
  assert.deepEqual(trail('/content/dam'), [['/content/dam', 'DAM']]);
  assert.deepEqual(trail('/content/dam/frescopa/fw26-intake'), [
    ['/content/dam', 'DAM'], ['/content/dam/frescopa', 'frescopa'], ['/content/dam/frescopa/fw26-intake', 'fw26-intake'],
  ]);
});
