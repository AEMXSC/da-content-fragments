/*
 * da-content-fragments broker: an App Builder web action between DA panels and AEM author.
 *
 * POST { op, author, id?, variation?, path?, model?, ops?, etag? } with `Authorization: Bearer
 * <the DA user's IMS token>`. The action
 *   1. answers CORS only for da.live, *--*--*.aem.page|live and localhost (ALLOWED_ORIGINS input);
 *   2. checks, with Adobe's repository discovery and the user's own token, that `author` is an AEM
 *      author repository this user can reach (no other host is ever called);
 *   3. calls the Content Fragment management API on that author server to server, with the user's
 *      token (AEM permissions apply), a fresh CSRF token and the caller's ETag for writes;
 *   4. returns { data, etag } or { error }.
 * It stores nothing and never logs tokens.
 */
const crypto = require('crypto');
const {
  AUTHOR_HOST, DEFAULT_ORIGINS, BrokerError, originAllowed, corsHeaders, bearer, need, plan, reposFromDiscovery,
} = require('./lib');

const DISCOVERY = 'https://aem-discovery.adobe.io/repositories';
const CACHE_MS = 5 * 60 * 1000;
const discoveryCache = new Map(); // sha256(token) -> { at, hosts:Set } (warm containers only)

function patterns(params) {
  const raw = params.ALLOWED_ORIGINS;
  if (!raw) return DEFAULT_ORIGINS;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

async function reachableHosts(token) {
  const key = crypto.createHash('sha256').update(token).digest('hex');
  const hit = discoveryCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.hosts;
  const res = await fetch(DISCOVERY, { headers: { Authorization: `Bearer ${token}`, 'x-api-key': 'exc_app' } });
  if (res.status === 401) throw new BrokerError(401, 'Your Adobe sign-in has expired: reload DA.');
  if (!res.ok) throw new BrokerError(502, `AEM repository discovery returned HTTP ${res.status}.`);
  const hosts = new Set(reposFromDiscovery(await res.json()).map((r) => r.host));
  discoveryCache.set(key, { at: Date.now(), hosts });
  if (discoveryCache.size > 500) discoveryCache.delete(discoveryCache.keys().next().value);
  return hosts;
}

async function csrfToken(author, token) {
  const res = await fetch(`https://${author}/libs/granite/csrf/token.json`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new BrokerError(502, `AEM CSRF token returned HTTP ${res.status}.`);
  const { token: csrf } = await res.json();
  if (!csrf) throw new BrokerError(502, 'AEM returned no CSRF token.');
  return csrf;
}

function aemError(status, write) {
  if (status === 401) return new BrokerError(401, 'AEM refused the sign-in: reload DA, or check your access to this AEM environment.');
  if (status === 403) return new BrokerError(403, 'AEM denied access: your user has no permission for this fragment.');
  if (status === 404) return new BrokerError(404, 'Not found in AEM.');
  if (write && (status === 409 || status === 412)) return new BrokerError(409, 'The fragment changed in AEM since it was loaded: reload it before saving.');
  if (status === 422 || status === 400) return new BrokerError(422, 'AEM rejected the change (model validation).');
  return new BrokerError(502, `AEM returned HTTP ${status}.`);
}

async function call(params, token) {
  const author = need(params.author, AUTHOR_HOST, 'AEM author host');
  const hosts = await reachableHosts(token);
  if (!hosts.has(author)) throw new BrokerError(403, 'This AEM author is not one of your Adobe organization\'s repositories.');
  const req = plan(params);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (req.write) {
    if (typeof req.etag !== 'string' || !req.etag || req.etag === '*' || req.etag.startsWith('W/')) {
      throw new BrokerError(428, 'Saving needs the ETag of the version you edited: reload the fragment.');
    }
    headers['If-Match'] = req.etag;
    headers['Content-Type'] = 'application/json-patch+json';
    headers['CSRF-Token'] = await csrfToken(author, token);
  }
  const res = await fetch(`https://${author}${req.path}`, {
    method: req.method, headers, ...(req.body ? { body: JSON.stringify(req.body) } : {}),
  });
  if (!res.ok) throw aemError(res.status, req.write);
  const text = await res.text();
  return { data: text ? JSON.parse(text) : null, etag: res.headers.get('etag') };
}

async function main(params = {}) {
  const headers = params.__ow_headers || {};
  const origin = headers.origin || '';
  const allowed = patterns(params);
  const cors = corsHeaders(origin, allowed);
  const reply = (statusCode, body) => ({ statusCode, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body });
  if ((params.__ow_method || '').toLowerCase() === 'options') {
    return originAllowed(origin, allowed) ? { statusCode: 204, headers: cors } : { statusCode: 403 };
  }
  if (!originAllowed(origin, allowed)) return reply(403, { error: 'Origin not allowed.' });
  try {
    if ((params.__ow_method || 'post').toLowerCase() !== 'post') throw new BrokerError(405, 'Use POST.');
    const token = bearer(headers);
    return reply(200, await call(params, token));
  } catch (e) {
    const status = e instanceof BrokerError ? e.status : 500;
    if (status === 500) console.error(`broker error: ${e.message}`); // message only, never params or headers
    return reply(status, { error: status === 500 ? 'Unexpected broker error.' : e.message });
  }
}

module.exports = { main, _test: { discoveryCache } };
