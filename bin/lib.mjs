/*
 * The installer's pure parts (no file system, no network), unit-tested in test/install.test.mjs.
 */

/** the files a site gets, relative to this package's site/ folder and to the site repo */
export const SITE_FILES = ['tools/content-fragments', 'scripts/cf-render.js', 'scripts/cf-bridge.js', 'blocks/cf-card'];

export const PANEL_PATH = '/tools/content-fragments/index.html';
export const LIBRARY_TITLE = 'Content Fragments';
export const IGNORE_ENTRY = 'tools/content-fragments/';
const NEEDED = ['decorateButtons', 'decorateIcons', 'decorateBlock', 'loadBlock'];

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The DA org and site of a site repo: fstab.yaml's DA mountpoint first, then the git remote
 * (github.com/<owner>/<repo>, which is the site's org/site on aem.live). null when neither says.
 */
export function siteFrom({ fstab = '', remote = '' } = {}) {
  const m = /content\.da\.live\/([^/\s'"]+)\/([^/\s'"]+)/.exec(fstab)
    || /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!m) return null;
  const [org, site] = [m[1].toLowerCase(), m[2].toLowerCase()];
  return NAME.test(org) && NAME.test(site) ? { org, site } : null;
}

const REQUIRED = ['decorateBlock', 'loadBlock'];

const bridge = (names) => [
  '  // Experience Workspace preview only: the Content Fragments panel updates fragment sections live',
  '  // (da-content-fragments; Workspace serves the preview from *.preview.da.live)',
  '  if (window.self !== window.top && /\\.(aem\\.page|(stage-)?preview\\.da\\.live)$/.test(window.location.hostname)) {',
  "    import('./cf-bridge.js').then((m) => m.default({",
  `      ${names.join(', ')},`,
  '    }));',
  '  }',
].join('\n');

const AEM_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(['"])\.\/aem\.js\2;?/;

/** names a module exports: `export { a, b as c }`, `export function a`, `export const a` */
export function exportsOf(code = '') {
  const names = new Set();
  [...code.matchAll(/export\s*\{([^}]*)\}/g)].forEach((m) => m[1].split(',').forEach((s) => {
    const n = s.trim().split(/\s+as\s+/).pop();
    if (n) names.add(n);
  }));
  [...code.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)].forEach((m) => names.add(m[1]));
  return names;
}

/** names scripts.js already has: imported from aem.js, or its own functions and constants */
function namesIn(code) {
  const names = new Set();
  const m = AEM_IMPORT.exec(code);
  if (m) m[1].split(',').forEach((s) => { const n = s.trim().split(/\s+as\s+/).pop(); if (n) names.add(n); });
  [...code.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+|let\s+)([A-Za-z_$][\w$]*)/g)].forEach((x) => names.add(x[1]));
  return names;
}

/** add `missing` to the `import { … } from './aem.js'` statement */
function withImports(code, missing) {
  const m = AEM_IMPORT.exec(code);
  if (!missing.length) return code;
  const list = m[1];
  const multiline = list.includes('\n');
  const body = list.replace(/[\s,]*$/, '');
  const next = multiline
    ? `${body},\n${missing.map((n) => `  ${n},`).join('\n')}\n`
    : `${body}, ${missing.join(', ')} `;
  return code.slice(0, m.index) + m[0].replace(list, next) + code.slice(m.index + m[0].length);
}

/**
 * scripts.js with the bridge wired in: the aem.js imports it needs, and its loader at the start
 * of loadDelayed(). Each hook comes from scripts.js itself when it has one (the current
 * boilerplate defines decorateButtons there), else from aem.js when aem.js exports it; optional
 * hooks neither has are left out. { code, changed } or { manual: reason } when the file does not
 * follow the boilerplate closely enough to edit safely.
 */
export function patchScripts(code, aemCode) {
  if (code.includes('cf-bridge')) return { code, changed: false };
  if (!AEM_IMPORT.test(code)) return { manual: 'no `import { … } from \'./aem.js\'` statement found' };
  const fn = /(?:export\s+)?(?:async\s+)?function\s+loadDelayed\s*\([^)]*\)\s*\{[^\n]*\n/.exec(code);
  if (!fn) return { manual: 'no loadDelayed() function found' };
  const have = namesIn(code);
  const exported = exportsOf(aemCode);
  const toImport = NEEDED.filter((n) => !have.has(n) && exported.has(n));
  const available = NEEDED.filter((n) => have.has(n) || exported.has(n));
  const lacking = REQUIRED.filter((n) => !available.includes(n));
  if (lacking.length) return { manual: `${lacking.join(' and ')} not found in scripts.js or aem.js` };
  const eol = code.includes('\r\n') ? '\r\n' : '\n';
  const at = fn.index + fn[0].length;
  const patched = `${code.slice(0, at)}${bridge(available).replace(/\n/g, eol)}${eol}${code.slice(at)}`;
  return { code: withImports(patched, toImport).replace(/\r?\n/g, eol), changed: true };
}

/** an ignore file's text with the panel folder listed (unchanged when it already is) */
export function withIgnore(text = '') {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l.replace(/\/?\**$/, '') === IGNORE_ENTRY.replace(/\/$/, '') || l === 'tools/' || l === 'tools/**')) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return `${text}${text && !text.endsWith('\n') ? eol : ''}${IGNORE_ENTRY}${eol}`;
}

/** does a flat ESLint config already ignore the panel folder? */
export function flatConfigIgnores(text = '') {
  return /['"`]tools\/(?:content-fragments\/?)?\*\*(?:\/\*)?['"`]/.test(text);
}

/** the site's DA config with the panel's library row added; null when it is already there */
export function withLibraryRow(raw) {
  const rows = raw?.library?.data || [];
  if (rows.some((r) => String(r.title || '').trim() === LIBRARY_TITLE)) return null;
  const out = structuredClone(raw && raw[':names'] ? raw : { ':names': [], ':version': 3, ':type': 'multi-sheet' });
  const data = [...rows, { title: LIBRARY_TITLE, path: PANEL_PATH, experience: '' }];
  out.library = {
    ...out.library, total: data.length, limit: data.length, offset: 0, data,
  };
  if (!out[':names'].includes('library')) out[':names'] = [...out[':names'], 'library'];
  return out;
}
