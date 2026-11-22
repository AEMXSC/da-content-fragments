import test from 'node:test';
import assert from 'node:assert/strict';
import { render, fragmentData } from '../site/scripts/cf-render.js';
import { readConfig } from '../site/tools/content-fragments/refs.js';
import { fieldPatch, editable, statusOf } from '../site/tools/content-fragments/broker.js';

test('values are escaped, triple braces raw', () => {
  assert.equal(render('<p>{{t}}</p>{{{h}}}', { t: '<b>&', h: '<em>x</em>' }), '<p>&lt;b&gt;&amp;</p><em>x</em>');
});

test('sections, inverted sections, arrays, dotted paths, comments', () => {
  const tpl = '{{#cta}}<a href="{{cta.url}}">{{cta.label}}</a>{{/cta}}{{^note}}none{{/note}}{{! hidden }}<ul>{{#tags}}<li>{{.}}</li>{{/tags}}</ul>';
  assert.equal(render(tpl, { cta: { url: '/x', label: 'Go' }, tags: ['a', 'b'] }), '<a href="/x">Go</a>none<ul><li>a</li><li>b</li></ul>');
  assert.equal(render('{{#a}}[{{#a}}in{{/a}}]{{/a}}', { a: true }), '[in]');
  assert.throws(() => render('{{#a}}x', { a: 1 }));
});

test('fragmentData unwraps single values and keeps multi values', () => {
  const d = fragmentData({ path: '/content/dam/x', fields: [{ name: 'title', values: ['Hi'] }, { name: 'tags', multiple: true, values: ['a', 'b'] }] }, { variation: 'cardholder' });
  assert.deepEqual(d, {
    _path: '/content/dam/x', _variation: 'cardholder', _title: '', title: 'Hi', tags: ['a', 'b'],
  });
});

test('config sheets', () => {
  const { settings, models } = readConfig({
    ':names': ['content-fragments', 'content-fragment-models'],
    'content-fragments': { data: [{ key: 'Broker', value: 'https://x/api/v1/web/ns/pkg/cf ' }, { key: 'author', value: 'author-p1-e2.adobeaemcloud.com' }] },
    'content-fragment-models': { data: [{ model: 'tsc-cohort-hero', template: '/t.html', label: 'Hero' }, { model: '' }] },
  });
  assert.equal(settings.broker, 'https://x/api/v1/web/ns/pkg/cf');
  assert.equal(models.length, 1);
});

test('field patch: test + replace only for changed editable fields', () => {
  const fields = [{ name: 'a', type: 'text', values: ['1'] }, { name: 'b', type: 'text', values: ['2'] }];
  assert.deepEqual(fieldPatch(fields, { a: '1', b: 'x', zz: 'y' }), [
    { op: 'test', path: '/fields/1/name', value: 'b' }, { op: 'replace', path: '/fields/1/values', value: ['x'] }]);
  assert.ok(editable({ type: 'long-text', values: ['x'] }));
  assert.ok(!editable({ type: 'text', locked: true, values: ['x'] }));
  assert.ok(!editable({ type: 'content-reference', values: ['/x'] }));
  assert.equal(statusOf({ status: 'MODIFIED' }).tone, 'warn');
});

test('link base and labelled links', async () => {
  const d = fragmentData({ fields: [
    { name: 'ctaUrl', values: ['/tsc/sale'] }, { name: 'secondaryUrl', values: ['https://other.example/x'] },
    { name: 'body', values: ['Find a store: /tsc/store-locator. Weekly ad: /tsc/cms/digital-flyer.'] },
    { name: 'plain', values: ['Shop now: great deals. Nothing else.'] },
  ] }, { linkBase: 'https://www.example.com' });
  assert.equal(d.ctaUrl, 'https://www.example.com/tsc/sale');
  assert.equal(d.secondaryUrl, 'https://other.example/x');
  assert.deepEqual(d.body_links, [{ label: 'Find a store', href: 'https://www.example.com/tsc/store-locator' }, { label: 'Weekly ad', href: 'https://www.example.com/tsc/cms/digital-flyer' }]);
  assert.equal(d.body_haslinks, true);
  assert.equal(d.plain_links, undefined);
});

test('redirects: a moved page resolves locally, hash kept; others use the link base', () => {
  const redirects = { '/tsc/cms/credit': '/cms/credit' };
  const d = fragmentData({ fields: [
    { name: 'secondaryUrl', values: ['/tsc/cms/credit#creditOffers'] },
    { name: 'ctaUrl', values: ['/tsc/cms/credit-center'] },
    { name: 'body', values: ['Credit: /tsc/cms/credit/. Store: /tsc/store-locator.'] },
  ] }, { linkBase: 'https://www.example.com', redirects });
  assert.equal(d.secondaryUrl, '/cms/credit#creditOffers');
  assert.equal(d.ctaUrl, 'https://www.example.com/tsc/cms/credit-center');
  assert.deepEqual(d.body_links.map((l) => l.href), ['/cms/credit', 'https://www.example.com/tsc/store-locator']);
});
