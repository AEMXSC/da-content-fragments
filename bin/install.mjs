#!/usr/bin/env node
/*
 * Install (or update) the Content Fragments extension in an Edge Delivery Services site repo.
 * Run it in the site repo's root:
 *
 *   npx github:AEMXSC/da-content-fragments install [--dry-run] [--org <org> --site <site>] [--no-library]
 *
 * 1. copies the panel, renderer, bridge and cf-card block from this package's site/ folder
 *    (a site's own templates/ folder is never touched);
 * 2. wires the bridge into scripts/scripts.js (or says what to add, when the file is not the
 *    boilerplate's shape);
 * 3. adds the panel folder to the site's lint ignore files;
 * 4. adds the `Content Fragments` row to the site's DA library (signs in with Adobe's
 *    da-auth-helper; the token is never printed or stored here).
 * Safe to run again: unchanged files and rows are left as they are.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SITE_FILES, PANEL_PATH, IGNORE_ENTRY, siteFrom, patchScripts, withIgnore, flatConfigIgnores, withLibraryRow,
} from './lib.mjs';

const PKG_SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../site');
const ROOT = process.cwd();
const argv = process.argv.slice(2).filter((a) => a !== 'install');
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = flag('dry-run');
const log = (s = '') => process.stdout.write(`${s}\n`);
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const manual = [];

function write(file, text) {
  if (!DRY) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

if (flag('help')) {
  log('Usage: npx github:AEMXSC/da-content-fragments install [--dry-run] [--org <org> --site <site>] [--no-library]');
  process.exit(0);
}
if (!fs.existsSync(path.join(ROOT, 'scripts/aem.js')) || !fs.existsSync(path.join(ROOT, 'scripts/scripts.js'))) {
  log('Run this in the root of an Edge Delivery Services site repo (scripts/aem.js and scripts/scripts.js not found).');
  process.exit(1);
}
log(DRY ? 'Dry run: nothing is written.\n' : '');

// 1. files
const walk = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((n) => walk(path.join(p, n))) : [p]);
const counts = { added: 0, updated: 0, unchanged: 0 };
SITE_FILES.flatMap((f) => walk(path.join(PKG_SITE, f))).forEach((src) => {
  const dest = path.join(ROOT, path.relative(PKG_SITE, src));
  const next = fs.readFileSync(src);
  const before = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  // compare without line endings: Windows working trees may hold CRLF copies of the same files
  const same = before && before.toString().replace(/\r\n/g, '\n') === next.toString().replace(/\r\n/g, '\n');
  if (same) { counts.unchanged += 1; return; }
  counts[before ? 'updated' : 'added'] += 1;
  if (!DRY) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, next); }
});
log(`Files: ${counts.added} added, ${counts.updated} updated, ${counts.unchanged} unchanged.`);

// 2. scripts.js
const scriptsFile = path.join(ROOT, 'scripts/scripts.js');
const patched = patchScripts(read(scriptsFile), read(path.join(ROOT, 'scripts/aem.js')));
if (patched.manual) {
  manual.push(`scripts/scripts.js: ${patched.manual}. Add the bridge to loadDelayed() by hand (docs/getting-started.md, "Without the installer").`);
} else if (patched.changed) {
  write(scriptsFile, patched.code);
  log('scripts/scripts.js: bridge added to loadDelayed().');
} else {
  log('scripts/scripts.js: bridge already there.');
}

// 3. lint ignores
['.eslintignore', '.stylelintignore'].forEach((name) => {
  const file = path.join(ROOT, name);
  const text = read(file);
  const tool = name === '.eslintignore' ? /^\.eslintrc/ : /^\.stylelintrc|^stylelint\.config/;
  const usesTool = fs.readdirSync(ROOT).some((n) => tool.test(n));
  if (text === null && !usesTool) return;
  const next = withIgnore(text || '');
  if (next !== (text || '')) { write(file, next); log(`${name}: ${IGNORE_ENTRY} added.`); }
});
const flat = fs.readdirSync(ROOT).find((n) => /^eslint\.config\.(m?js|cjs)$/.test(n));
if (flat && !flatConfigIgnores(read(path.join(ROOT, flat)))) {
  manual.push(`${flat}: add '${IGNORE_ENTRY}**' to the ignores (the copied panel follows this package's lint rules, not the site's).`);
}

// 4. DA library row
async function addLibraryRow() {
  const remote = (() => { try { return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }); } catch { return ''; } })();
  const found = siteFrom({ fstab: read(path.join(ROOT, 'fstab.yaml')) || '', remote });
  const org = opt('org') || found?.org;
  const site = opt('site') || found?.site;
  if (!org || !site) {
    manual.push('DA library: could not tell the DA org and site from fstab.yaml or the git remote. Run again with --org <org> --site <site>.');
    return;
  }
  const where = `https://da.live/config#/${org}/${site}`;
  if (DRY) { log(`DA library: would add "Content Fragments" → ${PANEL_PATH} in ${where} if missing.`); return; }
  log(`DA library: signing in to DA for ${org}/${site} (a browser window may open)…`);
  let token;
  try {
    token = execFileSync('npx', ['-y', 'github:adobe-rnd/da-auth-helper', 'token'], {
      encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], shell: process.platform === 'win32',
    }).trim().split(/\s+/).pop();
    if (!/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new Error('no token');
  } catch {
    manual.push(`DA library: sign-in failed. Add the row by hand in ${where}: library → Content Fragments, ${PANEL_PATH}.`);
    return;
  }
  const url = `https://admin.da.live/config/${org}/${site}`;
  const headers = { Authorization: `Bearer ${token}` };
  const res = await fetch(url, { headers });
  if (!res.ok && res.status !== 404) {
    manual.push(`DA library: reading ${where} failed (HTTP ${res.status}). Check that you can edit the site's configuration, then run again.`);
    return;
  }
  const next = withLibraryRow(res.ok ? await res.json() : null);
  if (!next) { log('DA library: "Content Fragments" already there.'); return; }
  const body = new FormData();
  body.append('config', JSON.stringify(next));
  const put = await fetch(url, { method: 'POST', headers, body });
  if (!put.ok) {
    manual.push(`DA library: saving failed (HTTP ${put.status}); only people who can edit ${where} can add it. Nothing else in the configuration was changed.`);
    return;
  }
  log(`DA library: "Content Fragments" added in ${where} (the rest of the configuration is kept).`);
}

if (!flag('no-library')) await addLibraryRow();

log('');
if (manual.length) {
  log('To do by hand:');
  manual.forEach((m) => log(`  - ${m}`));
  log('');
}
log('Next: commit and push the site repo, open a page in Experience Workspace, open Content Fragments');
log('from the library, and run Setup (docs/getting-started.md, part 2).');
process.exitCode = manual.length ? 2 : 0;
