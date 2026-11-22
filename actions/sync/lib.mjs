/*
 * The sync service's logic, without network (every call is passed in), so it is tested with mocks
 * (test/sync.test.mjs). When a Content Fragment is published in AEM, the pages that show it get
 * AEM's published content: each section whose Section Metadata `Fragment` is that fragment has its
 * block re-rendered with the site's template, exactly as the panel renders it (same renderer, same
 * row merge), then the page is written to DA, previewed, and published unless it has other
 * unpublished edits.
 */
// the panel's own renderer and helpers (the deploy zip keeps this layout), so pages come out
// exactly as the panel renders them
import { render, fragmentData } from '../../site/scripts/cf-render.js';
import { mergeRows } from '../../site/tools/content-fragments/apply.js';
import { sectionMeta, readConfig } from '../../site/tools/content-fragments/refs.js';

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const lower = (s) => norm(s).toLowerCase().replace(/\s+/g, '-');
// what a block shows: its rows' text and its images (whitespace between elements varies by source)
const shown = (block) => [
  ...[...block.children].map((r) => r.textContent.replace(/\s+/g, '')),
  ...[...block.querySelectorAll('img')].map((i) => i.getAttribute('src')),
].join('|');

/** an AEM publish delivery fragment ({ fields: { name: value } }) → the shape the renderer takes */
export function deliveryToData(fragment) {
  const refs = fragment?.references || {};
  const assetPath = (v) => (typeof v === 'string' && refs[v]?.type === 'asset' ? refs[v].value?.path || v : v);
  const isAsset = (v) => typeof v === 'string' && refs[v]?.type === 'asset';
  // long and rich text arrive as { value, mimeType }; author gives the bare value
  const unwrap = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
  const fields = Object.entries(fragment?.fields || {}).map(([name, raw]) => {
    const multiple = Array.isArray(raw);
    const values = (multiple ? raw : [raw]).filter((v) => v !== null && v !== undefined).map(unwrap);
    const asset = values.some(isAsset);
    return {
      name, multiple, type: asset ? 'content-reference' : typeof values[0], values: asset ? values.map(assetPath) : values,
    };
  });
  return { title: fragment?.title || '', path: fragment?.path || '', fields };
}

/** the template for a fragment's model, from the site's DA config: { html } or { file }, else null */
export function templateFor(config, modelPath) {
  const { models } = readConfig(config);
  const m = models.find((x) => x.model === modelPath || modelPath.endsWith(`/${x.model}`));
  if (m?.html) return { html: m.html };
  if (m?.template) return { file: m.template };
  return null;
}

/** AEM's model id is the model path, base64url-encoded */
export const modelPathOf = (id) => Buffer.from(String(id || ''), 'base64url').toString('utf8');

/** sections of a page (DA source or .plain.html) that show `path`, with their variation */
export function fragmentSections(doc, path) {
  const main = doc.querySelector('main') || doc.body;
  return [...main.children].map((section) => {
    const meta = sectionMeta(section);
    if (lower(meta.fragment) !== lower(path)) return null;
    const block = [...section.children].find((c) => c.className && !c.classList.contains('section-metadata') && !c.classList.contains('metadata'));
    return block ? { section, block, variation: meta.variation ? lower(meta.variation) : 'master' } : null;
  }).filter(Boolean);
}

/**
 * The page with every block showing `path` re-rendered. `renderFor(variation)` returns the block
 * HTML for that variation. → { html, changed, count }
 */
export async function rerender(sourceHtml, path, renderFor, DOMParserImpl) {
  const doc = new DOMParserImpl().parseFromString(sourceHtml, 'text/html');
  const sections = fragmentSections(doc, path);
  let changed = false;
  for (const { block, variation } of sections) {
    // sequential: each variation is fetched once per page and pages are small
    // eslint-disable-next-line no-await-in-loop
    const fresh = mergeRows(block, await renderFor(variation), DOMParserImpl);
    const holder = doc.createElement('div');
    holder.innerHTML = fresh;
    const next = holder.firstElementChild;
    // text and image sources, not raw markup: DA's editor rewrites pictures (sources, lazy loading)
    if (shown(next) !== shown(block)) {
      block.replaceWith(next);
      changed = true;
    }
  }
  return { html: `<body>${doc.body.innerHTML}</body>`, changed, count: sections.length };
}

/** a page's text outside the sections showing `path` and outside metadata: to spot other edits */
export function otherText(html, path, DOMParserImpl) {
  const doc = new DOMParserImpl().parseFromString(html, 'text/html');
  fragmentSections(doc, path).forEach(({ section }) => section.remove());
  doc.querySelectorAll('.metadata, .section-metadata').forEach((n) => n.remove());
  // whitespace ignored: DA source and .plain.html space adjacent elements differently
  return (doc.querySelector('main') || doc.body).textContent.replace(/\s+/g, '');
}

/** the web path of a DA source path ('/drafts/x.html' → '/drafts/x'; '/a/index.html' → '/a/') */
export const webPath = (p) => p.replace(/\.html$/, '').replace(/\/index$/, '/');

/**
 * Sync one published fragment into one site.
 * @param {object} io { pages(), source(p), write(p, html), preview(web), publish(web), live(web) → html|null,
 *   config(), file(path) → text, fragment(variation) → delivery json, redirects() → map|null, log(obj) }
 * @param {object} o { path, author, DOMParserImpl }
 * @returns {Promise<object[]>} one result per page that shows the fragment
 */
export async function syncSite(io, { path, author, DOMParserImpl }) {
  const config = await io.config();
  const { settings } = readConfig(config);
  const linkBase = (settings['link-base'] || '').replace(/\/$/, '');
  const assetBase = (settings['asset-base'] || `https://${author.replace(/^author-/, 'publish-')}`).replace(/\/$/, '');
  const redirects = await io.redirects();
  const cache = new Map();
  let tpl;
  const renderFor = async (variation) => {
    if (!cache.has(variation)) cache.set(variation, io.fragment(variation));
    const delivery = await cache.get(variation);
    if (tpl === undefined) {
      const t = templateFor(config, modelPathOf(delivery?.model?.id));
      tpl = t?.html || (t?.file ? await io.file(t.file) : null);
    }
    if (!tpl) throw new Error('This model has no template in the site config.');
    return render(tpl, fragmentData(deliveryToData(delivery), {
      path, variation, linkBase, redirects, assetBase,
    }));
  };
  const results = [];
  for (const page of await io.pages()) {
    // sequential: the admin API allows ~10 requests a second per project
    /* eslint-disable no-await-in-loop */
    const source = await io.source(page);
    if (!source || !source.toLowerCase().includes(path.toLowerCase())) continue;
    const web = webPath(page);
    try {
      const { html, changed, count } = await rerender(source, path, renderFor, DOMParserImpl);
      if (!count) continue;
      if (!changed) { results.push({ page: web, result: 'unchanged' }); continue; }
      const live = await io.live(web);
      const pending = live === null || otherText(source, path, DOMParserImpl) !== otherText(live, path, DOMParserImpl);
      await io.write(page, html);
      await io.preview(web);
      if (pending) { results.push({ page: web, result: 'previewed; not published: the page has other unpublished edits' }); continue; }
      await io.publish(web);
      results.push({ page: web, result: 'published' });
    } catch (e) {
      results.push({ page: web, result: `error: ${e.message}` });
    }
    /* eslint-enable no-await-in-loop */
  }
  results.forEach((r) => io.log({ fragment: path, ...r }));
  return results;
}
