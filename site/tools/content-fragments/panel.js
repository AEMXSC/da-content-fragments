/*
 * Content Fragments panel for DA / Experience Workspace (inline library tool).
 * Generic: everything site-specific comes from the DA config sheets `content-fragments`
 * (broker, author, tenant) and `content-fragment-models` (model → template). Author content is
 * read and saved through the broker; the preview is updated through cf-bridge on the page.
 * Based on Mark Szulc's Fréscopa Content Fragment plugin (Apache-2.0).
 */
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import { readRefs, readConfig } from './refs.js';
import createBroker, { fieldPatch, editable, statusOf } from './broker.js';
import { render, fragmentData } from '../../scripts/cf-render.js';
import { applyToPage } from './apply.js';
import openAdvisor from './advisor.js';
import runSetup from './setup.js';
import { starterTemplate } from './starter.js';
import el, { icon } from './ui.js';

// the shared broker deployment (one App Builder action serves every site); setup can change it
const DEFAULT_BROKER = 'https://3635370-dacontentfragments-stage.adobeioruntime.net/api/v1/web/da-cf/cf';

const $ = (sel) => document.querySelector(sel);
const say = (msg, tone = '') => { const s = $('#status'); s.textContent = msg; s.dataset.tone = tone; };
const pageKey = (p) => String(p || '/').replace(/\.html$/, '').replace(/\/index$/, '/');
const templates = new Map();

let broker;
let config;
let page;
let sdk; // { context, token, actions }
let live; // the editor's live document: { html, selection: { blockIndex }, editable }

const linkBase = () => (config.settings['link-base'] || '').replace(/\/$/, '');
// images referenced by fragments load from AEM publish (setting `asset-base` overrides)
const assetBase = () => (config.settings['asset-base'] || `https://${broker.author.replace(/^author-/, 'publish-')}`).replace(/\/$/, '');

// the site's EDS redirects sheet (/redirects.json, same origin as this panel): a fragment link to a
// page already moved to this site resolves to the moved page, as the site's build does. Optional.
let redirects = null;
async function loadRedirects() {
  try {
    const res = await fetch('/redirects.json', { cache: 'no-store' });
    if (!res.ok) return;
    const json = await res.json();
    const rows = json?.data || json?.default?.data || [];
    redirects = Object.fromEntries(rows.filter((r) => r.Source && r.Destination).map((r) => [r.Source, r.Destination]));
  } catch { redirects = null; } // no sheet: links use the link base only
}

/** preview the page (EDS admin allows this origin), after the editor saved it */
async function previewPage() {
  const { org, repo } = sdk.context;
  const p = sdk.context.path.replace(/\/index$/, '/');
  const res = await fetch(`https://admin.hlx.page/preview/${org}/${repo}/main${p}`, {
    method: 'POST', headers: { Authorization: `Bearer ${sdk.token}`, 'x-content-source-authorization': `Bearer ${sdk.token}` },
  });
  if (!res.ok) throw new Error(`Applied in the editor, but preview returned HTTP ${res.status}.`);
}
// BroadcastChannel only connects documents of the same origin (this site's preview): no origin
// check is needed, and every message is still checked for this page and a /content/dam path
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('da-content-fragments') : null;

function post(msg) { channel?.postMessage({ page, ...msg }); }

/** the model's template: saved by setup (`html`), a template file, else the starter (cf-card) */
async function template(fragment) {
  const m = config.models.find((x) => [fragment.model?.path, fragment.model?.id, fragment.model?.name].includes(x.model)
    || (fragment.model?.path || '').endsWith(`/${x.model}`));
  if (m?.html) return m.html;
  if (!m?.template) {
    const id = fragment.model?.id;
    if (!id) return null;
    if (!templates.has(id)) templates.set(id, broker.model(id).then((model) => starterTemplate(model)));
    return templates.get(id);
  }
  if (!templates.has(m.template)) {
    templates.set(m.template, fetch(m.template, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`Template ${m.template} returned HTTP ${r.status}.`);
      return r.text();
    }));
  }
  return templates.get(m.template);
}

function editorUrl(id) {
  const u = new URL('https://experience.adobe.com/');
  u.searchParams.set('repo', broker.author);
  const tenant = config.settings.tenant ? `@${config.settings.tenant}/` : '';
  u.hash = `/${tenant}aem/cf/editor/editor/${encodeURIComponent(id)}`;
  return u.href;
}

async function openEditor(ref, fragment, host) {
  host.replaceChildren(el('p', { class: 'muted', text: 'Loading fields from AEM author…' }));
  const variations = [{ name: 'master', title: 'Main' }, ...await broker.variations(fragment.id)];
  let current = ref.variation;
  let snapshot;
  let draft = {};
  const tpl = await template(fragment).catch((e) => { say(e.message, 'error'); return null; });
  // one rendering for the live preview and for Apply: the same template and data
  const rendered = () => {
    const fields = snapshot.data.fields.map((f) => (f.name in draft ? { ...f, values: [draft[f.name]] } : f));
    return render(tpl, fragmentData({ ...snapshot.data, fields }, {
      path: ref.path, variation: current, linkBase: linkBase(), redirects, assetBase: assetBase(),
    }));
  };
  const preview = () => {
    if (!tpl) return;
    post({
      type: 'render', path: ref.path, variation: current, html: rendered(),
    });
  };
  const apply = el('button', {
    type: 'button', class: 'nx-btn-primary', text: 'Apply to page', hidden: true, title: 'Click inside this block in the editor first',
    onclick: async () => {
      apply.disabled = true;
      try {
        say(await applyToPage({
          actions: sdk.actions, live, ref: { ...ref, variation: current }, renderedHtml: rendered(), preview: previewPage,
        }), 'ok');
        apply.hidden = true;
      } catch (e) { say(e.message, 'error'); } finally { apply.disabled = false; }
    },
  });
  let timer;
  const draw = () => {
    const form = el('form', { class: 'fields', onsubmit: (e) => e.preventDefault() });
    snapshot.data.fields.forEach((f) => {
      const id = `f-${f.name}`;
      const value = f.name in draft ? draft[f.name] : (f.values?.[0] ?? '');
      let input;
      if (editable(f)) {
        input = el(f.type === 'long-text' ? 'textarea' : 'input', {
          id, name: f.name, class: 'nx-input', rows: f.type === 'long-text' ? 4 : null,
          oninput: (e) => { draft[f.name] = e.target.value; clearTimeout(timer); timer = setTimeout(preview, 350); },
        });
        input.value = value;
      } else {
        input = el('output', { id, class: 'readonly', text: Array.isArray(f.values) ? f.values.join(', ') : '' });
      }
      form.append(el('label', { for: id, text: f.label || f.name }), input);
    });
    const save = el('button', {
      type: 'button', class: 'nx-btn-accent', text: 'Save to AEM',
      onclick: async () => {
        const ops = fieldPatch(snapshot.data.fields, draft);
        if (!ops.length) { say('No changes to save.'); return; }
        save.disabled = true;
        try {
          const r = await broker.patch(fragment.id, current, snapshot.etag, ops);
          draft = {};
          snapshot = await broker.get(fragment.id, current); // fresh values and ETag
          if (r.etag && !snapshot.etag) snapshot.etag = r.etag;
          draw();
          apply.hidden = !tpl;
          const next = tpl ? ' To update this page: click inside the block in the editor, then "Apply to page".' : '';
          say(`Saved to ${current === 'master' ? 'Main' : current} on AEM author.${next} Publish in AEM to update the live fragment.`, 'ok');
        } catch (e) {
          say(e.message, 'error');
        } finally { save.disabled = false; }
      },
    });
    const reset = el('button', {
      type: 'button', class: 'nx-action-btn-quiet', text: 'Discard', onclick: () => { draft = {}; draw(); preview(); },
    });
    host.replaceChildren(
      el('div', { class: 'field' }, el('label', { for: 'variation', text: 'Variation' }), el('select', {
        id: 'variation', class: 'nx-input',
        onchange: async (e) => { current = e.target.value; draft = {}; snapshot = await broker.get(fragment.id, current); draw(); preview(); },
      }, variations.map((v) => el('option', { value: v.name, selected: v.name === current, text: v.title || v.name })))),
      form,
      el('div', { class: 'actions' }, save, apply, reset, el('a', {
        class: 'nx-action-btn', href: editorUrl(fragment.id), target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open in AEM (opens in a new tab)',
      }, icon('openin'), 'Open in AEM')),
      tpl ? el('p', { class: 'muted', text: 'The preview updates as you type. Nothing is saved until "Save to AEM".' })
        : el('p', { class: 'muted', text: 'This model has no template: preview updates are off.' }),
    );
  };
  snapshot = await broker.get(fragment.id, current);
  draw();
}

function row(ref) {
  const name = ref.path.split('/').pop();
  const light = el('span', { class: 'light', 'data-tone': 'unknown' }, el('i', { 'aria-hidden': 'true' }), el('span', { text: 'Checking…' }));
  const setLight = (tone, label, title) => {
    light.dataset.tone = tone;
    light.lastChild.textContent = label;
    if (title) light.title = title;
  };
  const body = el('div', { class: 'body', hidden: true });
  let fragment;
  const toggle = el('button', {
    type: 'button', class: 'name', 'aria-expanded': 'false',
    onclick: async () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      body.hidden = open;
      post({ type: 'locate', path: ref.path, variation: ref.variation });
      if (!open && fragment && !body.childElementCount) {
        openEditor(ref, fragment, body).catch((e) => { body.replaceChildren(el('p', { class: 'error', text: e.message })); });
      }
    },
  }, icon('chevrondown'), el('span', { class: 'name-text' }, el('strong', { text: name }), el('span', { class: 'variation', text: ref.variation === 'master' ? 'Main' : ref.variation })));
  broker.byPath(ref.path).then((f) => {
    fragment = f;
    if (!f) { setLight('off', 'Not found in AEM'); return; }
    const st = statusOf(f);
    setLight(st.tone, st.label, f.id);
  }).catch((e) => { setLight('unknown', 'Unavailable', e.message); say(e.message, 'error'); });
  return el('li', { class: 'ref' }, toggle, el('div', { class: 'meta' }, light, el('span', { class: 'path', text: ref.path })), body);
}

// the editor's live document, when the host sends one (within ~2 s of subscribing)
let onLive; // set once the list is drawn: redraws it when the page's fragments change
function liveDocument(actions) {
  return new Promise((resolve) => {
    if (!actions?.subscribeLiveDocument) { resolve(null); return; }
    let first = true;
    actions.subscribeLiveDocument((snapshot) => {
      live = snapshot;
      if (first) { first = false; resolve(snapshot); } else onLive?.(snapshot.html);
    });
    setTimeout(() => resolve(live || null), 2000);
  });
}

const refsKey = (refs) => refs.map((r) => `${r.path}#${r.variation}`).join('|');
let shownKey = '';
function drawRefs(refs) {
  shownKey = refsKey(refs);
  $('#count').textContent = refs.length;
  $('#refs').replaceChildren(...refs.map(row));
  say(refs.length ? '' : 'No Content Fragment on this page yet: place one with Content Advisor below, or add Fragment / Variation rows to a section\'s metadata.');
}

/** a fragment (or variation) rendered with its model's template: what Content Advisor inserts */
async function renderRef({ path, variation }) {
  const fragment = await broker.byPath(path);
  if (!fragment) throw new Error(`${path} was not found on ${broker.author}.`);
  const tpl = await template(fragment);
  if (!tpl) throw new Error(`The model of ${path} has no template. Open Setup (gear) to add one.`);
  const snap = await broker.get(fragment.id, variation);
  return render(tpl, fragmentData(snap.data, {
    path, variation, linkBase: linkBase(), redirects, assetBase: assetBase(),
  }));
}

async function init() {
  sdk = await DA_SDK;
  const { context, token, actions } = sdk;
  const getToken = () => token;
  page = pageKey(context.path);
  const headers = { Authorization: `Bearer ${token}` };
  const cfg = await fetch(`https://admin.da.live/config/${context.org}/${context.repo}`, { headers });
  if (!cfg.ok && cfg.status !== 404) throw new Error(`DA config returned HTTP ${cfg.status}.`);
  const raw = cfg.ok ? await cfg.json() : {}; // 404: the site has no config yet
  config = readConfig(raw);
  await loadRedirects();
  const setup = (mode) => {
    document.body.classList.add('setup-mode');
    return runSetup({
      sdk, host: $('#setup'), raw, config, makeBroker: (o) => createBroker({ ...o, getToken }), defaultBroker: DEFAULT_BROKER, say, mode,
    });
  };
  // first run on this site: the setup wizard instead of the list
  if (!config.settings.author || !config.settings.broker) {
    await setup('first');
    return;
  }
  $('#setup-open').hidden = false;
  $('#setup-open').onclick = () => setup('edit').catch((e) => say(e.message, 'error'));
  broker = createBroker({ url: config.settings.broker, author: config.settings.author, getToken });
  $('#author').textContent = broker.author;
  if (new URLSearchParams(window.location.search).get('advisor') === '1') {
    document.body.classList.add('advisor-mode');
    $('.title').textContent = 'Place Content Fragments';
    $('#advisor-hint').hidden = false;
    await openAdvisor({
      sdk, author: broker.author, folder: config.settings['advisor-folder'], renderRef, say,
    });
    return;
  }
  // what the author has open now (the live editor document), else the stored source
  let html = (await liveDocument(actions))?.html;
  if (!html) {
    const doc = await fetch(`https://admin.da.live/source/${context.org}/${context.repo}${context.path.replace(/\/$/, '/index')}.html`, { headers });
    if (!doc.ok) throw new Error(`The page source returned HTTP ${doc.status}.`);
    html = await doc.text();
  }
  drawRefs(readRefs(html));
  let timer;
  onLive = (next) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const refs = readRefs(next);
      if (refsKey(refs) !== shownKey) drawRefs(refs); // a fragment section was added or removed
    }, 600);
  };
  $('#browse').prepend(icon('add'));
  $('#browse').onclick = () => actions.showPanel?.('content-advisor');
  channel?.addEventListener('message', ({ origin, data }) => {
    if (origin !== window.location.origin || data?.page !== page) return;
    if (data.type === 'error') say(`Preview: ${data.message}`, 'error');
    if (data.type === 'rendered' && !data.count) say('This fragment is not visible in the current preview (another cohort or variation may be showing).');
  });
}

init().catch((e) => say(e.message, 'error'));
