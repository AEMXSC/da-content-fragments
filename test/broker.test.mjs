import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { main, _test } = require('../actions/cf/index.js');
const { plan, originAllowed } = require('../actions/cf/lib.js');

const AUTHOR = 'author-p1-e2.adobeaemcloud.com';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.test-token-value.signature';
const ID = '11111111-2222-3333-4444-555555555555';
const ORIGIN = 'https://main--site--org.aem.page';

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) return new Response('{}', { status: 599 });
    const [, status, body, headers] = hit;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  return calls;
}
const discovery = (host = AUTHOR) => [/aem-discovery/, 200, { children: [{ _embedded: { 'http://ns.adobe.com/adobecloud/rel/primary': { 'repo:repositoryId': host, 'repo:owner': { type: 'org', id: 'ABC@AdobeOrg' } } } }] }];
const req = (body, extra = {}) => ({
  __ow_method: 'post', __ow_headers: { origin: ORIGIN, authorization: `Bearer ${TOKEN}`, ...extra }, ...body,
});

test.beforeEach(() => _test.discoveryCache.clear());

test('origins: da.live and EDS hosts only', () => {
  assert.ok(originAllowed('https://da.live'));
  assert.ok(originAllowed('https://main--tsc--aemxsc.aem.page'));
  assert.ok(originAllowed('http://localhost:3000'));
  assert.ok(originAllowed('https://main--tsc--aemxsc.preview.da.live'));
  assert.ok(originAllowed('https://main--tsc--aemxsc.stage-preview.da.live'));
  assert.ok(!originAllowed('https://preview.da.live.evil.com'));
  assert.ok(!originAllowed('https://x.preview.da.live'));
  assert.ok(!originAllowed('https://evil.example.com'));
  assert.ok(!originAllowed('https://da.live.evil.com'));
  assert.ok(!originAllowed('https://a.b--tsc--aemxsc.aem.page'));
});

test('preflight: allowed origin gets CORS, others 403', async () => {
  const ok = await main({ __ow_method: 'options', __ow_headers: { origin: ORIGIN } });
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.headers['Access-Control-Allow-Origin'], ORIGIN);
  const no = await main({ __ow_method: 'options', __ow_headers: { origin: 'https://evil.example.com' } });
  assert.equal(no.statusCode, 403);
});

test('reads a fragment variation with the user token', async () => {
  const calls = mockFetch([discovery(), [/\/variations\/cardholder/, 200, { name: 'cardholder', fields: [] }, { ETag: '"abc"' }]]);
  const r = await main(req({ op: 'get', author: AUTHOR, id: ID, variation: 'cardholder' }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.data.name, 'cardholder');
  assert.equal(r.body.etag, '"abc"');
  const aem = calls.find((c) => c.url.includes(AUTHOR));
  assert.equal(aem.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.match(aem.url, /references=direct-hydrated/);
});

test('refuses an author host the token cannot reach (no call made)', async () => {
  const calls = mockFetch([discovery('author-p9-e9.adobeaemcloud.com')]);
  const r = await main(req({ op: 'get', author: AUTHOR, id: ID }));
  assert.equal(r.statusCode, 403);
  assert.ok(!calls.some((c) => c.url.includes(AUTHOR)));
});

test('refuses non-author hosts before any call', async () => {
  const calls = mockFetch([discovery()]);
  const r = await main(req({ op: 'get', author: 'evil.example.com', id: ID }));
  assert.equal(r.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('write: needs a strong ETag, sends If-Match and CSRF', async () => {
  mockFetch([discovery()]);
  const weak = await main(req({ op: 'patch', author: AUTHOR, id: ID, etag: 'W/"x"', ops: [{ op: 'replace', path: '/fields/0/values', value: ['a'] }] }));
  assert.equal(weak.statusCode, 428);
  const calls = mockFetch([discovery(), [/csrf/, 200, { token: 'csrf-1' }], [/\/fragments\//, 200, { ok: true }, { ETag: '"new"' }]]);
  const r = await main(req({ op: 'patch', author: AUTHOR, id: ID, variation: 'cardholder', etag: '"old"', ops: [{ op: 'replace', path: '/fields/0/values', value: ['a'] }] }));
  assert.equal(r.statusCode, 200);
  const patch = calls.find((c) => c.init.method === 'PATCH');
  assert.equal(patch.init.headers['If-Match'], '"old"');
  assert.equal(patch.init.headers['CSRF-Token'], 'csrf-1');
  assert.match(patch.url, /variations\/cardholder$/);
});

test('write conflict maps to 409, no overwrite', async () => {
  mockFetch([discovery(), [/csrf/, 200, { token: 'c' }], [/\/fragments\//, 412, {}]]);
  const r = await main(req({ op: 'patch', author: AUTHOR, id: ID, etag: '"old"', ops: [{ op: 'replace', path: '/fields/0/values', value: ['a'] }] }));
  assert.equal(r.statusCode, 409);
});

test('patch may only touch fields, title, description', () => {
  assert.throws(() => plan({ op: 'patch', id: ID, ops: [{ op: 'replace', path: '/model', value: 'x' }] }));
  assert.throws(() => plan({ op: 'patch', id: ID, ops: [] }));
  assert.throws(() => plan({ op: 'list', path: '/content/dam/../etc' }));
  assert.throws(() => plan({ op: 'get', id: 'not-a-uuid' }));
  assert.throws(() => plan({ op: 'get', id: ID, variation: '../x' }));
  assert.throws(() => plan({ op: 'delete', id: ID }));
});

test('no token: 401 without calling anything', async () => {
  const calls = mockFetch([]);
  const r = await main({ __ow_method: 'post', __ow_headers: { origin: ORIGIN }, op: 'get', author: AUTHOR, id: ID });
  assert.equal(r.statusCode, 401);
  assert.equal(calls.length, 0);
});
