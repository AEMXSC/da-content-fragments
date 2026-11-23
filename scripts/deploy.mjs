// Deploy the broker without a bundler: zip actions/cf and update the action in the selected
// App Builder workspace (aio app use). Same settings as app.config.yaml.
// Usable as a command (npm run deploy) or from code (bin/backend.mjs): deployBroker() → action URL.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.platform === 'win32';
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', shell });

export function deployBroker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'da-cf-'));
  const FILES = ['index.js', 'lib.js', 'package.json'];
  ['index.js', 'lib.js'].forEach((f) => fs.copyFileSync(path.join(ROOT, 'actions/cf', f), path.join(dir, f)));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'da-cf-broker', main: 'index.js' }));
  const zip = path.join(dir, 'cf.zip');
  if (shell) run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path ${FILES.map((f) => `'${path.join(dir, f)}'`).join(',')} -DestinationPath '${zip}' -Force`]);
  else run('zip', ['-j', zip, ...FILES.map((f) => path.join(dir, f))]);
  try { execFileSync('aio', ['rt', 'package', 'get', 'da-cf'], { stdio: 'ignore', shell }); } catch { run('aio', ['rt', 'package', 'create', 'da-cf']); }
  run('aio', ['rt', 'action', 'update', 'da-cf/cf', zip, '--kind', 'nodejs:22', '--web', 'true', '--web-secure', 'false',
    '-a', 'web-custom-options', 'true', '-a', 'final', 'true', '-a', 'require-adobe-auth', 'false', '--timeout', '30000', '--memory', '256']);
  const url = execFileSync('aio', ['rt', 'action', 'get', 'da-cf/cf', '--url'], { encoding: 'utf8', shell }).trim().split(/\s+/).pop();
  fs.rmSync(dir, { recursive: true, force: true });
  return url;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${deployBroker()}\n`);
}
