import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  siteFrom, patchScripts, exportsOf, withIgnore, flatConfigIgnores, withLibraryRow, withPermissionRow,
} from '../bin/lib.mjs';

test('siteFrom: fstab DA mountpoint first, then the git remote, lowercased', () => {
  assert.deepEqual(siteFrom({ fstab: 'mountpoints:\n  /: https://content.da.live/Acme/web-site/\n', remote: 'https://github.com/other/repo.git' }), { org: 'acme', site: 'web-site' });
  assert.deepEqual(siteFrom({ remote: 'https://github.com/AcmeCorp/Site.git\n' }), { org: 'acmecorp', site: 'site' });
  assert.deepEqual(siteFrom({ remote: 'git@github.com:acme/site.git' }), { org: 'acme', site: 'site' });
  assert.equal(siteFrom({ remote: 'https://gitlab.com/acme/site.git' }), null);
  assert.equal(siteFrom({}), null);
});

const aem = 'export {\n  decorateBlock,\n  decorateIcons,\n  loadBlock,\n  loadHeader,\n};\n';

// the current boilerplate: decorateButtons is scripts.js's own function, not an aem.js export
const boilerplate = `import {
  loadHeader,
  decorateIcons,
} from './aem.js';

function decorateButtons(main) {
  return main;
}

function loadDelayed() {
  // eslint-disable-next-line import/no-cycle
  window.setTimeout(() => import('./delayed.js'), 3000);
}
`;

test('patchScripts: imports only what aem.js exports and scripts.js lacks; bridge first in loadDelayed()', () => {
  const { code, changed } = patchScripts(boilerplate, aem);
  assert.equal(changed, true);
  assert.match(code, /loadHeader,\n {2}decorateIcons,\n {2}decorateBlock,\n {2}loadBlock,\n\} from '\.\/aem\.js';/);
  assert.doesNotMatch(code.slice(0, code.indexOf("from './aem.js'")), /decorateButtons/);
  assert.match(code, /m\.default\(\{\n {6}decorateButtons, decorateIcons, decorateBlock, loadBlock,\n/);
  assert.ok(code.indexOf("import('./cf-bridge.js')") > code.indexOf('function loadDelayed() {'));
  assert.ok(code.indexOf("import('./cf-bridge.js')") < code.indexOf("import('./delayed.js')"));
});

test('patchScripts: an older aem.js that exports decorateButtons; a second run changes nothing', () => {
  const once = patchScripts(
    "import { loadBlock } from './aem.js';\nexport function loadDelayed() {\n}\n",
    'export function decorateButtons() {}\nexport { decorateBlock, decorateIcons, loadBlock };',
  );
  assert.match(once.code, /import \{ loadBlock, decorateButtons, decorateIcons, decorateBlock \} from '\.\/aem\.js';/);
  assert.deepEqual(patchScripts(once.code, ''), { code: once.code, changed: false });
});

test('patchScripts: optional hooks neither file has are left out; CRLF files stay CRLF', () => {
  const src = "import { decorateBlock, loadBlock } from './aem.js';\r\nfunction loadDelayed() {\r\n}\r\n";
  const { code } = patchScripts(src, 'export { decorateBlock, loadBlock };');
  assert.match(code, /m\.default\(\{\r\n {6}decorateBlock, loadBlock,\r\n/);
  assert.doesNotMatch(code, /[^\r]\n/);
});

test('patchScripts: says what is missing instead of guessing', () => {
  assert.match(patchScripts('function loadDelayed() {\n}\n', aem).manual, /aem\.js/);
  assert.match(patchScripts("import { a } from './aem.js';\n", aem).manual, /loadDelayed/);
  assert.match(patchScripts("import { a } from './aem.js';\nfunction loadDelayed() {\n}\n", 'export { decorateBlock };').manual, /loadBlock not found/);
});

test('exportsOf: export lists, functions and constants', () => {
  assert.deepEqual([...exportsOf('export { a, b as c };\nexport async function d() {}\nexport const e = 1;')], ['a', 'c', 'd', 'e']);
});

test('withIgnore: adds the panel folder once, keeps line endings', () => {
  assert.equal(withIgnore('helix-importer-ui\n'), 'helix-importer-ui\ntools/content-fragments/\n');
  assert.equal(withIgnore('a\r\nb'), 'a\r\nb\r\ntools/content-fragments/\r\n');
  assert.equal(withIgnore('tools/content-fragments/**\n'), 'tools/content-fragments/**\n');
  assert.equal(withIgnore(''), 'tools/content-fragments/\n');
});

test('flatConfigIgnores: recognises a tools/ or panel ignore', () => {
  assert.equal(flatConfigIgnores("ignores: ['tools/**/*', 'x']"), true);
  assert.equal(flatConfigIgnores("ignores: ['tools/content-fragments/**']"), true);
  assert.equal(flatConfigIgnores("ignores: ['plugins/**']"), false);
});

test('withLibraryRow: adds the row and keeps the rest, or null when present', () => {
  const raw = {
    ':names': ['data'], ':version': 3, ':type': 'multi-sheet', data: { data: [{ key: 'k', value: 'v' }] },
  };
  const out = withLibraryRow(raw);
  assert.deepEqual(out.data, raw.data);
  assert.deepEqual(out[':names'], ['data', 'library']);
  assert.deepEqual(out.library.data, [{ title: 'Content Fragments', path: '/tools/content-fragments/index.html', experience: '' }]);
  assert.equal(withLibraryRow(out), null);
  assert.equal(withLibraryRow(null).library.data.length, 1);
});

test('withPermissionRow: adds the technical account for every site once, keeps the rest', () => {
  const TECH = 'abc-123@techacct.adobe.com';
  const raw = {
    ':names': ['permissions', 'data'], permissions: { data: [{ path: 'CONFIG', groups: 'a@b.com', actions: 'write', comments: '' }] }, data: { data: [{ k: 1 }] },
  };
  const out = withPermissionRow(raw, TECH);
  assert.deepEqual(out.data, raw.data);
  assert.equal(out.permissions.data.length, 2);
  assert.deepEqual(out.permissions.data[1], {
    path: '/ + **', groups: TECH, actions: 'write', comments: 'da-content-fragments sync service (OAuth server to server)',
  });
  assert.equal(withPermissionRow(out, TECH), null);
  assert.equal(withPermissionRow(null, TECH).permissions.data.length, 1);
  assert.throws(() => withPermissionRow(raw, 'someone@example.com'));
});
