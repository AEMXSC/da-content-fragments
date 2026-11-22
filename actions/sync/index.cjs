/*
 * da-content-fragments sync service: an App Builder action run by AEM's "Content Fragment published"
 * event (aem.sites.contentFragment.published). For each site in the DA org(s) (CF_SYNC_ORGS, default
 * "aemxsc") whose content-fragments config points at the event's author (found on every run), the
 * pages that show the fragment get AEM's published content: written to DA, previewed, and published
 * unless the page has other unpublished edits.
 *
 * Reads the fragment from AEM publish (public delivery API: no AEM credential). Writes DA with the
 * da-cf-sync technical account (OAuth server to server) and previews/publishes with an aem.live API key.
 * Inputs: CF_SYNC_CLIENT_ID, CF_SYNC_CLIENT_SECRET, CF_SYNC_SCOPES, AEM_LIVE_API_KEY, CF_SYNC_ORGS,
 * optional DRY_RUN. Logs outcomes only, never tokens or field values.
 */
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DAM = /^\/content\/dam(?:\/[A-Za-z0-9._\- ]+)+$/;
const SITE = /^[a-z0-9-]+\/[a-z0-9-]+$/;
const AUTHOR = /^author-p\d+-e\d+\.adobeaemcloud\.com$/;
const VARIATION = /^[A-Za-z0-9_-]{1,64}$/;

async function ok(res, what) {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  return res;
}

async function techToken(p) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials', client_id: p.CF_SYNC_CLIENT_ID, client_secret: p.CF_SYNC_CLIENT_SECRET, scope: p.CF_SYNC_SCOPES,
  });
  const res = await ok(await fetch('https://ims-na1.adobelogin.com/ims/token/v3', { method: 'POST', body }), 'IMS token');
  return (await res.json()).access_token;
}

const FRAGMENT_PUBLISHED = 'aem.sites.contentFragment.published';

/**
 * The event's fragment: { id, path, author }, or null for any other event (a model published,
 * a fragment modified…), which is acknowledged so AEM does not retry it. The environment comes
 * from the CloudEvent source (acct:aem-p123-e456@adobe.com); data.sourceUrl is the publish host.
 */
function eventOf(params) {
  const type = params.type || params.event?.type;
  if (type && type !== FRAGMENT_PUBLISHED) return null;
  const data = params.data || params.event?.data || params;
  const id = data.id || data.fragmentId;
  const path = data.path;
  if (!UUID.test(id || '') || !DAM.test(path || '') || path.split('/').includes('..')) throw new Error('The event has no valid fragment id and path.');
  const env = String(params.source || params.event?.source || data.sourceUrl || '').match(/p(\d+)-e(\d+)/);
  const time = Date.parse(params.time || params.event?.time || '');
  return {
    id, path, author: env ? `author-p${env[1]}-e${env[2]}.adobeaemcloud.com` : null, time: Number.isNaN(time) ? null : time,
  };
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * AEM publish's CDN can still serve the fragment as it was before the publish that sent the event:
 * a response whose Last-Modified is older than the event is stale, so ask again (uncached), every
 * 10 s for up to 90 s, rather than render old content and call the page unchanged.
 */
async function freshJson(url, since) {
  for (let i = 0; ; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await ok(await fetch(url, { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } }), 'AEM publish fragment');
    const modified = Date.parse(res.headers.get('last-modified') || '');
    // HTTP dates have whole seconds: allow the second the event falls in
    if (!since || Number.isNaN(modified) || modified >= Math.floor(since / 1000) * 1000 || i >= 9) return res.json();
    // eslint-disable-next-line no-await-in-loop
    await wait(10000);
  }
}

function ioFor({
  org, site, author, id, since, token, apiKey, dry,
}) {
  const da = (p) => `https://admin.da.live${p}`;
  const DA = { Authorization: `Bearer ${token}` };
  const ADMIN = { Authorization: `token ${apiKey}`, 'x-content-source-authorization': `Bearer ${token}` };
  const page = `https://main--${site}--${org}.aem.page`;
  const live = `https://main--${site}--${org}.aem.live`;
  const publish = `https://${author.replace(/^author-/, 'publish-')}`;
  const done = [];
  const walk = async (folder) => {
    const res = await ok(await fetch(da(`/list/${org}/${site}${folder}`), { headers: DA }), `DA list ${folder}`);
    const items = await res.json();
    const out = [];
    for (const it of items) {
      const p = it.path.replace(`/${org}/${site}`, '');
      // sequential: a site has tens to hundreds of pages
      // eslint-disable-next-line no-await-in-loop
      if (!it.ext) out.push(...await walk(p));
      else if (it.ext === 'html') out.push(p);
    }
    return out;
  };
  return {
    done,
    pages: () => walk(''),
    source: async (p) => { const r = await fetch(da(`/source/${org}/${site}${p}`), { headers: DA }); return r.ok ? r.text() : null; },
    write: async (p, html) => {
      if (dry) { done.push(['write', p]); return; }
      const body = new FormData();
      body.append('data', new Blob([html], { type: 'text/html' }));
      await ok(await fetch(da(`/source/${org}/${site}${p}`), { method: 'POST', headers: DA, body }), `DA write ${p}`);
    },
    preview: async (web) => {
      if (dry) { done.push(['preview', web]); return; }
      await ok(await fetch(`https://admin.hlx.page/preview/${org}/${site}/main${web}`, { method: 'POST', headers: ADMIN }), `preview ${web}`);
    },
    publish: async (web) => {
      if (dry) { done.push(['publish', web]); return; }
      await ok(await fetch(`https://admin.hlx.page/live/${org}/${site}/main${web}`, { method: 'POST', headers: ADMIN }), `publish ${web}`);
    },
    live: async (web) => {
      const r = await fetch(`${live}${web.endsWith('/') ? `${web}index` : web}.plain.html?cf-sync=${Date.now()}`);
      return r.ok ? r.text() : null;
    },
    config: async () => (await ok(await fetch(da(`/config/${org}/${site}`), { headers: DA }), 'site config')).json(),
    file: async (f) => (await ok(await fetch(`${page}${f}`), `template ${f}`)).text(),
    fragment: async (variation) => {
      if (!VARIATION.test(variation)) throw new Error('invalid variation');
      const v = variation === 'master' ? '' : `/variations/${encodeURIComponent(variation)}`;
      return freshJson(`${publish}/adobe/contentFragments/${id}${v}?references=direct`, since);
    },
    redirects: async () => {
      const r = await fetch(`${page}/redirects.json`);
      if (!r.ok) return null;
      const rows = (await r.json())?.data || [];
      return Object.fromEntries(rows.filter((x) => x.Source && x.Destination).map((x) => [x.Source, x.Destination]));
    },
    log: (o) => console.log(JSON.stringify({ site: `${org}/${site}`, ...o })), // outcomes only
  };
}

/**
 * The sites to update: every site in the DA org(s) whose Content Fragments setup points at the
 * event's AEM author (`author` in its content-fragments config sheet). New sites join by running
 * Setup; sites connected to another AEM environment are left alone. → [{ org, site, author }]
 */
async function connectedSites(orgs, eventAuthor, token) {
  const headers = { Authorization: `Bearer ${token}` };
  const names = String(orgs).split(',').map((o) => o.trim()).filter((o) => /^[a-z0-9-]+$/.test(o));
  const perOrg = await Promise.all(names.map(async (org) => {
    const items = await (await ok(await fetch(`https://admin.da.live/list/${org}`, { headers }), `DA list ${org}`)).json();
    const sites = items.filter((i) => !i.ext && SITE.test(`${org}/${i.name}`)).map((i) => i.name);
    return Promise.all(sites.map(async (site) => {
      const res = await fetch(`https://admin.da.live/config/${org}/${site}`, { headers });
      if (!res.ok) return null; // no config, or not readable
      const cfg = await res.json().catch(() => null);
      const author = (cfg?.['content-fragments']?.data || []).find((r) => r.key === 'author')?.value;
      if (!AUTHOR.test(author || '') || (eventAuthor && eventAuthor !== author)) return null;
      return { org, site, author };
    }));
  }));
  return perOrg.flat().filter(Boolean);
}

async function main(params = {}) {
  try {
    const { syncSite } = await import('./lib.mjs');
    const { DOMParser: Linke } = await import('linkedom');
    class DOMParser extends Linke {
      parseFromString(html, type) {
        return super.parseFromString(/<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`, type);
      }
    }
    const ev = eventOf(params);
    if (!ev) return { statusCode: 200, body: { ignored: params.type || params.event?.type } };
    const token = await techToken(params);
    const sites = await connectedSites(params.CF_SYNC_ORGS || 'aemxsc', ev.author, token);
    const report = [];
    for (const { org, site, author } of sites) {
      const s = `${org}/${site}`;
      const io = ioFor({
        org, site, author, id: ev.id, since: ev.time, token, apiKey: params.AEM_LIVE_API_KEY, dry: params.DRY_RUN === true || params.DRY_RUN === 'true',
      });
      // eslint-disable-next-line no-await-in-loop
      const results = await syncSite(io, { path: ev.path, author, DOMParserImpl: DOMParser });
      report.push({ site: s, results, dry: io.done });
    }
    return { statusCode: 200, body: { fragment: ev.path, report } };
  } catch (e) {
    console.error(`sync error: ${e.message}`); // message only
    return { statusCode: 500, body: { error: e.message } };
  }
}

module.exports = { main };
