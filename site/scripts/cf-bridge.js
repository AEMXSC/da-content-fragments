/*
 * cf-bridge: runs in the page preview inside Experience Workspace (same origin as the panel).
 * The Content Fragments panel renders a fragment's template with author content and posts the
 * result here; the bridge swaps it into the sections that reference that fragment + variation
 * (Section Metadata `Fragment` / `Variation`, or a Content Fragment block) and lets the site's
 * own block code decorate it again. Nothing is saved: reload the preview to see the stored page.
 *
 *   import('./cf-bridge.js').then((m) => m.default({ decorateButtons, decorateBlock, loadBlock }));
 *
 * Messages on BroadcastChannel `da-content-fragments`, scoped to this page path:
 *   { type: 'render', page, path, variation, html }  html = authored block markup, rows to replace
 *   { type: 'locate', page, path, variation }
 * Replies: { type: 'rendered' | 'located' | 'error', page, path, variation, count, message }
 */

const CHANNEL = 'da-content-fragments';
let authored; // the page's stored markup (.plain.html), for the blocks' undecorated rows

const page = () => window.location.pathname.replace(/\.html$/, '').replace(/\/index$/, '/');

async function plain() {
  if (!authored) {
    const p = page();
    const doc = p.endsWith('/') ? `${p}index` : p;
    const res = await fetch(`${doc}.plain.html`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Could not read the page markup (HTTP ${res.status}).`);
    authored = new DOMParser().parseFromString(await res.text(), 'text/html').body;
  }
  return authored;
}

function sectionsFor(path, variation) {
  const v = variation || 'master';
  return [...document.querySelectorAll('main > .section')].filter((s) => {
    if (s.dataset.fragment === path && (s.dataset.variation || 'master').toLowerCase() === v) return true;
    return [...s.querySelectorAll('.content-fragment')].some((b) => b.textContent.includes(path));
  });
}

function flash(section) {
  section.style.outline = '3px solid #3b63fb';
  section.style.outlineOffset = '4px';
  setTimeout(() => { section.style.outline = ''; section.style.outlineOffset = ''; }, 2500);
}

// the stored section with the same Fragment/Variation metadata (not by position: personalization
// can remove sections from the live DOM)
function storedSection(body, path, variation) {
  const v = variation || 'master';
  return [...body.children].find((sec) => {
    const meta = sec.querySelector(':scope > .section-metadata');
    if (meta) {
      const kv = Object.fromEntries([...meta.children].map((r) => [...r.children].map((c) => c.textContent.trim().toLowerCase())));
      if (kv.fragment === path.toLowerCase() && (kv.variation || 'master') === v) return true;
    }
    return [...sec.querySelectorAll(':scope > .content-fragment')].some((b) => b.textContent.includes(path));
  });
}

async function swap(section, html, hooks, path, variation) {
  const source = storedSection(await plain(), path, variation);
  const fresh = new DOMParser().parseFromString(html, 'text/html').body.firstElementChild;
  const current = section.querySelector('.block');
  if (!source || !fresh || !current) throw new Error('No block to update in this section.');
  const name = current.dataset.blockName;
  const original = [...source.children].find((el) => el.classList.contains(name));
  if (!original) throw new Error(`The stored page has no ${name} block here.`);
  // the template's rows replace the first rows of the stored block; the rest (e.g. tiles) stay
  const block = original.cloneNode(true);
  [...fresh.children].forEach((row, i) => {
    if (block.children[i]) block.children[i].replaceWith(row.cloneNode(true));
    else block.append(row.cloneNode(true));
  });
  const holder = document.createElement('div');
  holder.append(block);
  hooks.decorateButtons?.(holder);
  hooks.decorateIcons?.(holder);
  current.parentElement.replaceWith(holder);
  holder.className = `${name}-wrapper`;
  hooks.decorateBlock(block);
  await hooks.loadBlock(block);
  flash(section);
}

export default function startBridge(hooks = {}) {
  if (!hooks.decorateBlock || !hooks.loadBlock) throw new Error('cf-bridge needs decorateBlock and loadBlock.');
  if (window.self === window.top || typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  const reply = (msg) => channel.postMessage({ page: page(), ...msg });
  channel.addEventListener('message', async ({ data }) => {
    if (!data || data.page !== page() || !/^\/content\/dam\//.test(data.path || '')) return;
    const { path, variation } = data;
    const sections = sectionsFor(path, variation);
    try {
      if (data.type === 'locate') {
        if (sections[0]) {
          sections[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
          sections.forEach(flash);
        }
        reply({
          type: 'located', path, variation, count: sections.length,
        });
      } else if (data.type === 'render' && typeof data.html === 'string') {
        await Promise.all(sections.map((s) => swap(s, data.html, hooks, path, variation)));
        if (sections[0]) sections[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        reply({
          type: 'rendered', path, variation, count: sections.length,
        });
      }
    } catch (e) {
      reply({
        type: 'error', path, variation, message: e.message,
      });
    }
  });
  reply({ type: 'ready' });
}
