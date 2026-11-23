// Deploy the sync service (actions/sync) as da-cf-sync/fragment-published in the selected App Builder
// workspace (aio app use). The zip keeps the repo layout, so the action uses the panel's own renderer
// and helpers (site/...). Inputs (CF_SYNC_*, AEM_LIVE_API_KEY) go through a temporary parameter
// file, deleted after the update: secrets never appear on a command line.
// Command: node scripts/deploy-sync.mjs [orgs]   (reads .env in the current folder; DA orgs, default
// aemxsc: the action finds the sites in them that are connected to the event's AEM author)
// From code (bin/backend.mjs): deploySync({ inputs, orgs })
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SYNC_INPUTS = ['CF_SYNC_CLIENT_ID', 'CF_SYNC_CLIENT_SECRET', 'CF_SYNC_SCOPES', 'AEM_LIVE_API_KEY'];
const FILES = ['actions/sync/index.cjs', 'actions/sync/lib.mjs', 'site/package.json', 'site/scripts/cf-render.js',
  'site/tools/content-fragments/apply.js', 'site/tools/content-fragments/refs.js'];

export function readEnv(file = '.env') {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

export function deploySync({ inputs, orgs = 'aemxsc' }) {
  const missing = SYNC_INPUTS.filter((k) => !inputs[k]);
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
  const shell = process.platform === 'win32';
  const run = (cmd, args, cwd) => execFileSync(cmd, args, { stdio: 'inherit', shell, cwd });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'da-cf-sync-'));
  FILES.forEach((f) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const linkedom = pkg.dependencies?.linkedom || pkg.devDependencies?.linkedom || 'latest';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'da-cf-sync', main: 'actions/sync/index.cjs', dependencies: { linkedom } }));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], dir);
  const zip = path.join(os.tmpdir(), `da-cf-sync-${Date.now()}.zip`);
  // Windows: bsdtar writes standard zip entries (forward slashes); PowerShell 5.1 Compress-Archive
  // writes backslashes, and the runtime then cannot find actions/sync/index.cjs
  if (shell) execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-cf', zip, '-C', dir, '*'], { stdio: 'inherit' });
  else run('zip', ['-qr', zip, '.'], dir);
  const params = path.join(os.tmpdir(), `da-cf-sync-params-${Date.now()}.json`);
  fs.writeFileSync(params, JSON.stringify({ ...Object.fromEntries(SYNC_INPUTS.map((k) => [k, inputs[k]])), CF_SYNC_ORGS: orgs }), { mode: 0o600 });
  try {
    try { execFileSync('aio', ['rt', 'package', 'get', 'da-cf-sync'], { stdio: 'ignore', shell }); } catch { run('aio', ['rt', 'package', 'create', 'da-cf-sync']); }
    run('aio', ['rt', 'action', 'update', 'da-cf-sync/fragment-published', zip, '--kind', 'nodejs:22', '--web', 'false',
      '--timeout', '300000', '--memory', '512', '--param-file', params]);
  } finally {
    fs.rmSync(params, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const orgs = process.argv[2] || 'aemxsc';
  deploySync({ inputs: readEnv('.env'), orgs });
  process.stdout.write(`deployed da-cf-sync/fragment-published for DA org(s) ${orgs}\n`);
}
