import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser as LinkeDOMParser } from 'linkedom';
import { render, fragmentData } from '../site/scripts/cf-render.js';
import { fieldMap, valuesFromBlock } from '../site/tools/content-fragments/writeback.js';

// browsers wrap a bare fragment in <body>; linkedom does not
class DOMParser extends LinkeDOMParser {
  parseFromString(html, type) {
    return super.parseFromString(/<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`, type);
  }
}

// AEMXSC/frescopa26 tools/content-fragments/templates/frescopa-product.html
const TEMPLATE = `<div class="cf-product">
  <div><div><p>{{season}} · {{category}}</p><h2>{{name}}</h2><p>{{format}} · {{sku}}</p></div></div>
  {{#heroImage}}<div><div><picture><img src="{{heroImage}}" alt="{{name}}"></picture></div></div>{{/heroImage}}
  <div><div><p>{{description}}</p></div></div>
  <div><div><p>MSRP</p><p>\${{msrp}}</p></div><div><p>Availability</p><p>{{availability}}</p></div></div>
</div>`;

const F = (name, type, value) => ({ name, type, values: [value] });
const fields = [
  F('season', 'enumeration', 'FW26'), F('category', 'text', 'Machine · Bean-to-cup'), F('name', 'text', 'The Atelier Mini'),
  F('format', 'text', 'Brushed steel'), F('sku', 'text', 'FRS-MCH-ATM-01'), F('heroImage', 'content-reference', '/content/dam/x.png'),
  F('description', 'long-text', 'Bean-to-cup heart.'), F('msrp', 'number', '799'), F('availability', 'text', 'Pre-order · Nov 16'),
];
const renderData = (data) => render(TEMPLATE, fragmentData(data, { path: '/content/dam/p', variation: 'master' }));
const block = (html) => new DOMParser().parseFromString(html, 'text/html').body.firstElementChild;
const page = (edit) => block(edit(renderData({ fields })));
const aem = () => page((h) => h);

test('fieldMap: one element per field (with literal text around it), shared elements reported', () => {
  const map = fieldMap(renderData, fields, DOMParser);
  const byName = Object.fromEntries(map.fields.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(byName).sort(), ['availability', 'description', 'msrp', 'name']);
  assert.equal(byName.msrp.prefix, '$');
  assert.deepEqual(map.shared.map((s) => s.name).sort(), ['category', 'format', 'season', 'sku']);
});

test('valuesFromBlock: the "!!!" case saves the name, nothing else', () => {
  const map = fieldMap(renderData, fields, DOMParser);
  const r = valuesFromBlock(map, page((h) => h.replace('The Atelier Mini</h2>', 'The Atelier Mini!!!</h2>')), fields, aem());
  assert.deepEqual(r, { changes: { name: 'The Atelier Mini!!!' }, unmappable: [] });
});

test('valuesFromBlock: a changed price (number field) is reported, not saved; an unchanged page gives nothing', () => {
  const map = fieldMap(renderData, fields, DOMParser);
  assert.deepEqual(valuesFromBlock(map, page((h) => h.replace('$799', '$749')), fields, aem()), { changes: {}, unmappable: ['msrp'] });
  assert.deepEqual(valuesFromBlock(map, page((h) => h), fields, aem()), { changes: {}, unmappable: [] });
});

test('valuesFromBlock: text whose literal prefix was deleted cannot be read, so it is reported', () => {
  const map = fieldMap(renderData, fields, DOMParser);
  assert.deepEqual(valuesFromBlock(map, page((h) => h.replace('$799', '799')), fields, aem()).unmappable, ['msrp']);
});

test('valuesFromBlock: a line holding two fields is reported only when the page changed it', () => {
  const map = fieldMap(renderData, fields, DOMParser);
  const r = valuesFromBlock(map, page((h) => h.replace('Brushed steel', 'Matte steel')), fields, aem());
  assert.deepEqual(r, { changes: {}, unmappable: ['format', 'sku'] });
});
