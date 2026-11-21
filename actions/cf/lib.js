/*
 * The broker's pure parts: request validation, CORS, the AEM request each operation makes.
 * No network here, so every rule is unit-tested (test/broker.test.mjs).
 *
 * Why a broker: AEM author refuses browser calls from da.live and *.aem.page (no CORS) on every
 * environment unless each one deploys its own CORS policy. The broker calls author server to
 * server with the signed-in user's own IMS token, so AEM permissions still decide what they can
 * read and change, and CORS is configured once, here.
 */

const AUTHOR_HOST = /^author-p\d+-e\d+\.adobeaemcloud\.com$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DAM_PATH = /^\/content\/dam\/[A-Za-z0-9._\-/]+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const MODEL_ID = /^[A-Za-z0-9_-]{8,400}={0,2}$/;

// da.live (the editor) and EDS preview/live hosts (branch--repo--owner) and local `aem up`
const DEFAULT_ORIGINS = [
  '^https://da\\.live$',
  '^https://[a-z0-9-]+--[a-z0-9-]+--[a-z0-9-]+\\.aem\\.(page|live)$',
  '^http://localhost:\\d{2,5}$',
];

class BrokerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function originAllowed(origin, patterns = DEFAULT_ORIGINS) {
  if (typeof origin !== 'string' || !origin) return false;
  return patterns.some((p) => new RegExp(p).test(origin));
}

function corsHeaders(origin, patterns) {
  if (!originAllowed(origin, patterns)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '1800',
    Vary: 'Origin',
  };
}

function bearer(headers = {}) {
  const raw = headers.authorization || headers.Authorization || '';
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,})$/.exec(raw);
  if (!m) throw new BrokerError(401, 'Sign in to DA: the request carries no IMS token.');
  return m[1];
}

function need(value, re, what) {
  if (typeof value !== 'string' || !re.test(value)) throw new BrokerError(400, `Invalid ${what}.`);
  if (what === 'fragment path' && value.split('/').some((s) => s === '.' || s === '..')) {
    throw new BrokerError(400, 'Invalid fragment path.');
  }
  return value;
}

// JSON Patch on fields only: no structural edits through the broker
function checkPatch(ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 100) throw new BrokerError(400, 'Invalid patch.');
  ops.forEach((op) => {
    if (!op || !['replace', 'add', 'remove', 'test'].includes(op.op)
      || typeof op.path !== 'string' || !/^\/(fields|title|description)(\/|$)/.test(op.path)) {
      throw new BrokerError(400, 'Patch may only change fields, title or description.');
    }
  });
  return ops;
}

function checkMetadataPatch(ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 20) throw new BrokerError(400, 'Invalid metadata patch.');
  ops.forEach((op) => {
    if (!op || !['replace', 'add', 'test'].includes(op.op) || typeof op.path !== 'string' || !/^\/[A-Za-z0-9_:-]+(\/\d+|\/-)?$/.test(op.path)) {
      throw new BrokerError(400, 'Invalid metadata patch operation.');
    }
  });
  return ops;
}

/**
 * The AEM request for one broker operation.
 * @returns {{ method, path, write, body? , etag? }}
 */
function plan(params) {
  const op = params.op;
  const id = () => need(params.id, UUID, 'fragment id');
  const variation = () => (params.variation && params.variation !== 'master'
    ? `/variations/${encodeURIComponent(need(params.variation, NAME, 'variation'))}` : '');
  switch (op) {
    case 'list': {
      const path = need(params.path, DAM_PATH, 'fragment path');
      const limit = Math.min(Math.max(parseInt(params.limit, 10) || 20, 1), 50);
      return { method: 'GET', path: `/adobe/sites/cf/fragments?path=${encodeURIComponent(path)}&limit=${limit}` };
    }
    case 'get':
      return { method: 'GET', path: `/adobe/sites/cf/fragments/${id()}${variation()}?references=direct-hydrated` };
    case 'variations':
      return { method: 'GET', path: `/adobe/sites/cf/fragments/${id()}/variations?limit=50` };
    case 'model':
      return { method: 'GET', path: `/adobe/sites/cf/models/${need(params.model, MODEL_ID, 'model id')}` };
    case 'metadata':
      return { method: 'GET', path: `/adobe/sites/cf/fragments/${id()}/metadata` };
    case 'patch':
      return {
        method: 'PATCH', write: true, path: `/adobe/sites/cf/fragments/${id()}${variation()}`, body: checkPatch(params.ops), etag: params.etag,
      };
    case 'patch-metadata':
      return {
        method: 'PATCH', write: true, path: `/adobe/sites/cf/fragments/${id()}/metadata`, body: checkMetadataPatch(params.ops), etag: params.etag,
      };
    default:
      throw new BrokerError(400, 'Unknown operation.');
  }
}

/** The author repositories this token can reach, from Adobe's repository discovery. */
function reposFromDiscovery(json) {
  return (json?.children || [])
    .map((c) => c?._embedded?.['http://ns.adobe.com/adobecloud/rel/primary'])
    .filter((r) => r && typeof r['repo:repositoryId'] === 'string')
    .map((r) => ({ host: r['repo:repositoryId'], org: r['repo:owner']?.id || null }));
}

module.exports = {
  AUTHOR_HOST, DEFAULT_ORIGINS, BrokerError, originAllowed, corsHeaders, bearer, need, plan, reposFromDiscovery,
};
