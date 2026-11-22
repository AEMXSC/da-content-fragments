// Deploy the broker without a bundler: zip actions/cf and update the action in the selected
// App Builder workspace (aio app use). Same settings as app.config.yaml.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'da-cf-'));
['index.js', 'lib.js'].forEach((f) => fs.copyFileSync(path.join('actions/cf', f), path.join(dir, f)));
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'da-cf-broker', main: 'index.js' }));
const zip = path.join(dir, 'cf.zip');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (process.platform === 'win32') run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${dir}\index.js','${dir}\lib.js','${dir}\package.json' -DestinationPath '${zip}' -Force`]);
else run('zip', ['-j', zip, ...['index.js', 'lib.js', 'package.json'].map((f) => path.join(dir, f))]);
try { execFileSync('aio', ['rt', 'package', 'get', 'da-cf'], { stdio: 'ignore', shell: process.platform === 'win32' }); } catch { run('aio', ['rt', 'package', 'create', 'da-cf']); }
run('aio', ['rt', 'action', 'update', 'da-cf/cf', zip, '--kind', 'nodejs:22', '--web', 'true', '--web-secure', 'false',
  '-a', 'web-custom-options', 'true', '-a', 'final', 'true', '-a', 'require-adobe-auth', 'false', '--timeout', '30000', '--memory', '256']);
run('aio', ['rt', 'action', 'get', 'da-cf/cf', '--url']);
