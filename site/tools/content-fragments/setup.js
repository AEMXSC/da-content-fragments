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
  const area = el('textarea', { class: 'nx-input code', rows: 5, spellcheck: 'false', value: existing?.html || starterTemplate(model) });
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
    { class: 'model card' },
    el('label', { class: 'check' }, use, el('strong', { text: model.title || model.name })),
    el('p', { class: 'path', text: `${model.path} · ${fields}` }),
    keepFile ? el('p', { class: 'muted', text: `Uses the template file ${existing.template}. Tick to replace it with this one.` }) : null,
    el('details', { open: !keepFile }, el('summary', { text: 'Template' }), area, el('div', { class: 'actions' }, el('button', {
      type: 'button', class: 'nx-action-btn-quiet', text: 'Reset to starter', onclick: () => { area.value = starterTemplate(model); draw(); },
    }))),
    out,
  );
  return { card, value: () => (use.checked ? { model: model.path, label: model.title || model.name, html: area.value.trim() } : null) };
}

const INTRO_TEMPLATES = 'Each one gets a template: how its fragments render on the page. The starter is built from the model\'s fields; edit it here or later.';
const card = (...kids) => el('section', { class: 'card step' }, ...kids);
const fine = (text) => el('p', { class: 'muted', text });
/** one environment row: name, host, state; a hibernated environment cannot be picked */
function pickRow(a, current, pick) {
  const meta = `${a.id}${a.hibernated ? ' · hibernated' : ''}${current ? ' · current' : ''}`;
  return el('li', {}, el(
    'button',
    {
      type: 'button', class: 'pick', disabled: a.hibernated, 'aria-current': current ? 'true' : false, onclick: () => pick(a),
    },
    el('span', { class: 'pick-name', text: a.label }),
    el('span', { class: 'pick-meta', text: meta }),
  ));
}
const back = (onclick) => el('button', { type: 'button', class: 'nx-action-btn-quiet nx-btn-sm back', onclick }, 'Back');

/**
 * Setup in three cards, one at a time (the ew-monday connect flow):
 * 1. Connect AEM: the user's author environments as rows; 2. the fragment folder: the
 * environment's DAM folders as a type-to-filter field; 3. review the models and save.
 * @param {object} o
 * @param {object} o.sdk DA SDK { context, token }
 * @param {HTMLElement} o.host where the wizard renders
 * @param {object} o.raw the site's DA config JSON as read
 * @param {{ settings, models }} o.config parsed config
 * @param {(opts) => object} o.makeBroker ({ url, author }) → broker
 * @param {string} o.defaultBroker the shared broker deployment
 * @param {(msg, tone?) => void} o.say
 * @param {'first'|'edit'} [o.mode]
 */
export default async function runSetup({
  sdk, host, raw, config, makeBroker, defaultBroker, say, mode = 'first',
}) {
  const { context, token } = sdk;
  const s = config.settings;
  const state = {
    author: s.author || '',
    folder: s['advisor-folder'] || '',
    broker: s.broker || defaultBroker,
    tenant: s.tenant || '',
    linkBase: s['link-base'] || '',
  };
  const show = (...kids) => { host.replaceChildren(...kids); host.hidden = false; };
  const broker = () => makeBroker({ url: state.broker, author: state.author });
  let authors = [];
  const steps = {}; // the three cards; Back links between them

  // 3. review the models found in the folder, then save
  steps.models = async () => {
    say(`Reading ${state.folder}…`);
    const b = broker();
    const items = await b.list(state.folder, 50);
    const byModel = new Map();
    items.forEach((f) => { if (f.model?.id && !byModel.has(f.model.id)) byModel.set(f.model.id, f); });
    if (!byModel.size) throw new Error(`No Content Fragments in ${state.folder}. Pick another folder.`);
    const base = { linkBase: state.linkBase.replace(/\/$/, ''), assetBase: `https://${state.author.replace(/^author-/, 'publish-')}` };
    const models = await Promise.all([...byModel.keys()].map((id) => b.model(id)));
    const samples = [...byModel.values()];
    const existing = (m) => config.models.find((x) => x.model === m.path || x.model === m.id);
    const cards = models.map((m, i) => modelCard(m, samples[i], existing(m), b, base));
    say('');
    const save = el('button', { type: 'button', class: 'nx-btn-accent wide', text: 'Save setup' });
    save.onclick = async () => {
      save.disabled = true;
      save.textContent = 'Saving…';
      try {
        const settings = {
          broker: state.broker, author: state.author, tenant: state.tenant, 'link-base': state.linkBase, 'advisor-folder': state.folder,
        };
        await saveConfig(context, token, mergeConfig(raw, { settings, models: cards.map((c) => c.value()).filter(Boolean), panelPath: window.location.pathname }));
        say('Setup saved. Reloading…', 'ok');
        setTimeout(() => window.location.reload(), 800);
      } catch (e) { say(e.message, 'error'); save.disabled = false; save.textContent = 'Save setup'; }
    };
    show(card(
      back(() => steps.folder()),
      el('h2', { text: 'Review the templates' }),
      el('p', { text: `${models.length} model${models.length > 1 ? 's' : ''} in ${state.folder}. ${INTRO_TEMPLATES}` }),
      el('ul', { class: 'models' }, cards.map((c) => c.card)),
      save,
      fine(`Saves to the DA configuration of ${context.org}/${context.repo}. Existing rows and other sheets are kept.`),
    ));
  };

  // 2. the fragment folder in this environment
  steps.folder = async () => {
    say('');
    const input = el('input', {
      id: 'setup-folder', class: 'nx-input', list: 'setup-folders', autocomplete: 'off', spellcheck: 'false', value: state.folder || `/content/dam/${context.repo}`,
    });
    const options = el('datalist', { id: 'setup-folders' });
    const count = fine('Loading folders…');
    const go = el('button', { type: 'submit', class: 'nx-btn-accent wide', text: 'Find models' });
    const field = (id, label, value, placeholder, key) => {
      const i = el('input', {
        id, class: 'nx-input', value, placeholder, oninput: (e) => { state[key] = e.target.value.trim(); },
      });
      return [el('label', { for: id, text: label }), i];
    };
    const form = el(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          state.folder = input.value.trim().replace(/\/$/, '');
          if (!/^\/content\/dam\/\S/.test(state.folder)) { say('Pick a folder under /content/dam.', 'error'); return; }
          go.disabled = true;
          go.textContent = 'Finding models…';
          try { await steps.models(); } catch (err) { say(err.message, 'error'); go.disabled = false; go.textContent = 'Find models'; }
        },
      },
      el('label', { for: 'setup-folder', text: 'Content Fragment folder' }),
      input,
      options,
      count,
      el(
        'details',
        {},
        el('summary', { text: 'More settings' }),
        ...field('setup-broker', 'Broker (App Builder action URL)', state.broker, '', 'broker'),
        ...field('setup-tenant', 'Experience Cloud tenant, for "Open in AEM" links', state.tenant, 'optional', 'tenant'),
        ...field('setup-link-base', 'Link base: the site that serves root-relative fragment links', state.linkBase, 'optional, e.g. https://www.example.com', 'linkBase'),
      ),
      go,
    );
    const env = authors.find((a) => a.id === state.author);
    show(card(
      back(() => steps.author()),
      el('h2', { text: 'Choose the fragment folder' }),
      el('p', { text: `Where this site's Content Fragments live in ${env?.label || state.author}. Models are found there, and Content Advisor opens there.` }),
      form,
    ));
    try {
      const folders = await broker().folders('/content/dam');
      options.replaceChildren(...folders.map((f) => el('option', { value: f.path, label: f.title })));
      // preselect the folder named like the site, else keep what is there
      const match = folders.find((f) => f.path.toLowerCase() === `/content/dam/${context.repo}`.toLowerCase());
      if (!state.folder && match) input.value = match.path;
      count.textContent = `${folders.length} folders in this environment. Type to filter; you can type a subfolder too.`;
    } catch (e) { count.textContent = `Folders could not be listed (${e.message}). Type the folder path.`; }
  };

  // 1. connect AEM: pick the author environment
  steps.author = async () => {
    say('');
    show(card(el('h2', { text: 'Connect AEM' }), fine('Loading your AEM environments…')));
    if (!authors.length) authors = await listAuthors(token);
    if (!authors.length) throw new Error('Your account has no AEM Cloud Service author in repository discovery.');
    const pick = (a) => { state.author = a.id; steps.folder().catch((e) => say(e.message, 'error')); };
    const rows = (q) => authors
      .filter((a) => !q || `${a.label} ${a.program} ${a.id}`.toLowerCase().includes(q.toLowerCase()))
      .map((a) => pickRow(a, a.id === state.author, pick));
    const list = el('ul', { class: 'picks' }, rows(''));
    const onFilter = (e) => list.replaceChildren(...rows(e.target.value));
    const filter = authors.length > 6 ? el('input', {
      id: 'setup-filter', class: 'nx-input', type: 'search', placeholder: 'Filter environments', oninput: onFilter,
    }) : null;
    show(card(
      el('h2', { text: 'Connect AEM' }),
      el('p', { text: `Pick the AEM author with this site's Content Fragments. Everyone who opens the panel on ${context.repo} uses it.` }),
      filter ? el('label', { for: 'setup-filter', class: 'sr-only', text: 'Filter environments' }) : null,
      filter,
      list,
      fine('These are the AEM Cloud Service authors your Adobe account can reach. Fragments are read and saved with your own permissions.'),
      mode === 'edit' ? el('button', { type: 'button', class: 'nx-action-btn-quiet', text: 'Cancel', onclick: () => window.location.reload() }) : null,
    ));
  };

  await steps.author();
}
