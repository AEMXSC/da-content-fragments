/*
 * Setup wizard: the first person to open the panel on a site connects it, without editing
 * config sheets. 1. pick an AEM author (from the user's environments) and a content folder;
 * 2. review the models found there, each with a starter template (editable, previewed on a real
 * fragment); 3. save. Saving writes the site's DA config (sheets `content-fragments`,
 * `content-fragment-models`, and the two library entries); DA lets only config editors do it.
 */
import el from './ui.js';
import { listAuthors } from './discovery.js';
import { starterTemplate } from './starter.js';
import { render, fragmentData } from '../../scripts/cf-render.js';

const DAM = /^\/content\/dam\/[A-Za-z0-9._\-/]+$/;
const sheet = (rows) => ({
  total: rows.length, limit: rows.length, offset: 0, data: rows,
});

/** the site config with this setup merged in; every other sheet and row is kept */
export function mergeConfig(raw, { settings, models, panelPath }) {
  const out = structuredClone(raw && raw[':names'] ? raw : { ':names': [], ':version': 3, ':type': 'multi-sheet' });
  const names = new Set(out[':names']);
  const upsert = (name, rows, keyOf) => {
    const current = out[name]?.data || [];
    const byKey = new Map(current.map((r) => [keyOf(r), r]));
    rows.forEach((r) => byKey.set(keyOf(r), { ...byKey.get(keyOf(r)), ...r }));
    out[name] = { ...out[name], ...sheet([...byKey.values()]) };
    names.add(name);
  };
  upsert('content-fragments', Object.entries(settings).filter(([, v]) => v !== undefined)
    .map(([key, value]) => ({ key, value: String(value) })), (r) => r.key);
  upsert('content-fragment-models', models.map((m) => ({
    model: m.model, label: m.label || '', template: m.template || '', html: m.html || '',
  })), (r) => r.model);
  upsert('library', [
    { title: 'Content Fragments', path: panelPath, experience: '' },
    { title: 'Content Advisor', path: `${panelPath}?advisor=1`, experience: 'fullsize-dialog' },
  ], (r) => r.title);
  out[':names'] = [...names];
  return out;
}

async function saveConfig({ org, repo }, token, json) {
  const body = new FormData();
  body.append('config', JSON.stringify(json));
  const res = await fetch(`https://admin.da.live/config/${org}/${repo}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
  if (res.status === 401 || res.status === 403) throw new Error('Only people who can edit this site\'s DA configuration can finish setup. Ask a site admin to open this panel.');
  if (!res.ok) throw new Error(`Saving the DA config returned HTTP ${res.status}.`);
}

function previewFrame(html) {
  // sandboxed, no scripts: a look at the markup the template produces, unstyled by the site
  return el('iframe', {
    class: 'preview', sandbox: '', title: 'Sample', srcdoc: `<style>body{font:14px system-ui;margin:8px}img{max-width:100%;height:auto}</style>${html}`,
  });
}

function modelCard(model, sample, existing, broker, base) {
  const keepFile = !!existing?.template && !existing?.html;
  const use = el('input', { type: 'checkbox', checked: !keepFile });
  const area = el('textarea', { rows: 5, spellcheck: 'false', value: existing?.html || starterTemplate(model) });
  const out = el('div', { class: 'sample' });
  const draw = async () => {
    if (!sample) { out.replaceChildren(el('p', { class: 'muted', text: 'No fragment of this model in the folder to preview.' })); return; }
    try {
      const snap = await broker.get(sample.id);
      out.replaceChildren(previewFrame(render(area.value, fragmentData(snap.data, { path: sample.path, ...base }))));
    } catch (e) { out.replaceChildren(el('p', { class: 'error', text: e.message })); }
  };
  let timer;
  area.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(draw, 400); });
  draw();
  const fields = (model.fields || []).map((f) => f.label || f.name).join(', ');
  const card = el(
    'li',
    { class: 'model' },
    el('label', { class: 'row' }, use, el('strong', { text: model.title || model.name })),
    el('p', { class: 'path', text: `${model.path} · ${fields}` }),
    keepFile ? el('p', { class: 'muted', text: `Uses the template file ${existing.template}. Tick to replace it with this one.` }) : null,
    el('details', { open: !keepFile }, el('summary', { text: 'Template' }), area, el('div', { class: 'actions' }, el('button', {
      type: 'button', text: 'Reset to starter', onclick: () => { area.value = starterTemplate(model); draw(); },
    }))),
    out,
  );
  return { card, value: () => (use.checked ? { model: model.path, label: model.title || model.name, html: area.value.trim() } : null) };
}

/**
 * @param {object} o
 * @param {object} o.sdk DA SDK { context, token }
 * @param {HTMLElement} o.host where the wizard renders
 * @param {object} o.raw the site's DA config JSON as read
 * @param {{ settings, models }} o.config parsed config
 * @param {(opts) => object} o.makeBroker ({ url, author }) → broker
 * @param {string} o.defaultBroker the shared broker deployment
 * @param {(msg, tone?) => void} o.say
 */
export default async function runSetup({
  sdk, host, raw, config, makeBroker, defaultBroker, say, mode = 'first',
}) {
  const { context, token } = sdk;
  const s = config.settings;
  say('Loading your AEM environments…');
  const authors = await listAuthors(token);
  if (!authors.length) throw new Error('Your account has no AEM Cloud Service author in repository discovery.');
  say('');
  const author = el('select', { id: 'setup-author' }, authors.map((a) => el('option', {
    value: a.id, selected: a.id === s.author, disabled: a.hibernated, text: `${a.label}${a.hibernated ? ' (hibernated)' : ''}`,
  })));
  const folder = el('input', { id: 'setup-folder', value: s['advisor-folder'] || `/content/dam/${context.repo}` });
  const brokerUrl = el('input', { id: 'setup-broker', value: s.broker || defaultBroker });
  const tenant = el('input', { id: 'setup-tenant', value: s.tenant || '', placeholder: 'optional' });
  const linkBase = el('input', { id: 'setup-link-base', value: s['link-base'] || '', placeholder: 'optional, e.g. https://www.example.com' });
  const list = el('ul', { class: 'refs' });
  const save = el('button', { type: 'button', class: 'primary', text: 'Save setup', disabled: true });
  let cards = [];

  const find = el('button', {
    type: 'button',
    class: 'primary',
    text: 'Find models',
    onclick: async () => {
      if (!DAM.test(folder.value.trim())) { say('The folder must start with /content/dam/.', 'error'); return; }
      find.disabled = true;
      list.replaceChildren();
      try {
        const broker = makeBroker({ url: brokerUrl.value.trim(), author: author.value });
        say(`Reading ${folder.value.trim()} on ${author.value}…`);
        const items = (await broker.list(folder.value.trim(), 50)) || [];
        const byModel = new Map();
        items.forEach((f) => { if (f.model?.id && !byModel.has(f.model.id)) byModel.set(f.model.id, f); });
        if (!byModel.size) { say('No Content Fragments in this folder. Pick another folder.', 'error'); return; }
        const base = { linkBase: linkBase.value.trim().replace(/\/$/, ''), assetBase: `https://${author.value.replace(/^author-/, 'publish-')}` };
        const models = await Promise.all([...byModel.keys()].map((id) => broker.model(id)));
        cards = models.map((m, i) => modelCard(m, [...byModel.values()][i], config.models.find((x) => x.model === m.path || x.model === m.id), broker, base));
        list.replaceChildren(...cards.map((c) => c.card));
        save.disabled = false;
        say(`${models.length} model${models.length > 1 ? 's' : ''} found. Review the templates, then Save setup.`, 'ok');
      } catch (e) { say(e.message, 'error'); } finally { find.disabled = false; }
    },
  });

  save.onclick = async () => {
    save.disabled = true;
    try {
      const settings = {
        broker: brokerUrl.value.trim(),
        author: author.value,
        tenant: tenant.value.trim(),
        'link-base': linkBase.value.trim(),
        'advisor-folder': folder.value.trim(),
      };
      const models = cards.map((c) => c.value()).filter(Boolean);
      await saveConfig(context, token, mergeConfig(raw, { settings, models, panelPath: window.location.pathname }));
      say('Setup saved. Reloading…', 'ok');
      setTimeout(() => window.location.reload(), 800);
    } catch (e) { say(e.message, 'error'); save.disabled = false; }
  };

  host.replaceChildren(
    el('h2', { text: 'Set up Content Fragments' }),
    el('p', { class: 'muted', text: 'Connect this site to AEM once. Everyone who opens the panel afterwards uses this setup.' }),
    el('h3', { text: '1. AEM author' }),
    el('label', { for: 'setup-author', text: 'Environment' }),
    author,
    el('label', { for: 'setup-folder', text: 'Content Fragment folder' }),
    folder,
    el(
      'details',
      {},
      el('summary', { text: 'More settings' }),
      el('label', { for: 'setup-broker', text: 'Broker (App Builder action URL)' }),
      brokerUrl,
      el('label', { for: 'setup-tenant', text: 'Experience Cloud tenant, for "Open in AEM" links' }),
      tenant,
      el('label', { for: 'setup-link-base', text: 'Link base: the site that serves root-relative fragment links' }),
      linkBase,
    ),
    el('div', { class: 'actions' }, find),
    el('h3', { text: '2. Models and templates' }),
    list,
    el('h3', { text: '3. Save' }),
    el('div', { class: 'actions' }, save, mode === 'edit' ? el('button', {
      type: 'button', text: 'Cancel', onclick: () => window.location.reload(),
    }) : null),
  );
  host.hidden = false;
}
