/*
 * Set up (or update) your own da-content-fragments backend in your own Adobe organization: the
 * broker the panel calls, and the sync service that updates Edge Delivery pages when a Content
 * Fragment is published in AEM. Run it in an empty folder (it keeps a git-ignored-style .env there):
 *
 *   aio login
 *   aio console org select <org> && aio console project select <project> && aio console workspace select <workspace>
 *   npx github:AEMXSC/da-content-fragments backend --da-org <your DA org> [--no-broker] [--dry-run]
 *
 * 1. the OAuth server-to-server credential `da-cf-sync` in that workspace (created or reused),
 *    subscribed to the Edge Delivery Services API;
 * 2. its technical account in the DA org's `permissions` sheet (`/ + **`, write);
 * 3. an aem.live API key (role publish) for the org, unless .env already has one;
 * 4. the broker (da-cf/cf) and the sync service (da-cf-sync/fragment-published) deployed there;
 * 5. what is left by hand: the event registration, and the broker URL for each site's Setup.
 * Safe to run again. Secrets are written to .env in this folder only, never printed.
 * Needs: the aio CLI (signed in), and a DA/Adobe sign-in that can edit the DA org config and the
 * aem.live org config (da-auth-helper opens a browser).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { withPermissionRow } from './lib.mjs';
import { deployBroker } from '../scripts/deploy.mjs';
import { deploySync, readEnv } from '../scripts/deploy-sync.mjs';

const argv = process.argv.slice(2).filter((a) => a !== 'backend');
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name) => argv.includes(`--${name}`);
const DRY = flag('dry-run');
const shell = process.platform === 'win32';
const log = (s = '') => process.stdout.write(`${s}\n`);
const NAME = 'da-cf-sync';
const EDS = 'Edge Delivery Services';

const daOrg = opt('da-org');
if (!/^[a-z0-9-]+$/.test(daOrg || '')) {
  log('Usage: npx github:AEMXSC/da-content-fragments backend --da-org <your DA org> [--no-broker] [--dry-run]');
  process.exit(1);
}

/** the libraries the aio CLI ships with (console and IMS), so this needs no extra install */
function aioLibs() {
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell }).trim();
  const base = path.join(root, '@adobe/aio-cli/node_modules/@adobe');
  if (!fs.existsSync(path.join(base, 'aio-lib-console'))) throw new Error('Install the Adobe I/O CLI first: npm install -g @adobe/aio-cli');
  const req = createRequire(path.join(base, 'aio-lib-console', 'package.json'));
  return { console: req(path.join(base, 'aio-lib-console')), ims: req(path.join(base, 'aio-lib-ims')) };
}

function writeEnv(values) {
  const env = readEnv('.env');
  Object.assign(env, values);
  fs.writeFileSync('.env', `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });
}

function daToken() {
  const token = execFileSync('npx', ['-y', 'github:adobe-rnd/da-auth-helper', 'token'], {
    encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], shell,
  }).trim().split(/\s+/).pop();
  if (!/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new Error('DA sign-in failed.');
  return token;
}

async function credential(libs, aio) {
  const client = await libs.console.init(await libs.ims.getToken('cli'), 'aio-cli-console-auth');
  const orgId = aio.project.org.id;
  const projectId = aio.project.id;
  const wsId = aio.project.workspace.id;
  const list = (await client.getCredentials(orgId, projectId, wsId)).body || [];
  let id = list.find((c) => c.integration_type === 'oauth_server_to_server' && c.integration_name === NAME)?.id_integration;
  if (!id && !DRY) id = (await client.createOAuthServerToServerCredential(orgId, projectId, wsId, NAME, 'da-content-fragments sync service')).body.id;
  log(id ? `Credential ${NAME}: ${list.some((c) => c.id_integration === id) ? 'reused' : 'created'}.` : `Credential ${NAME}: would be created.`);
  if (!id) return null;
  const eds = (await client.getServicesForOrg(orgId)).body.find((s) => s.name === EDS && s.type === 'entp');
  if (!eds) throw new Error(`Your organization has no "${EDS}" API in the Developer Console.`);
  // the credential's APIs (subscribing replaces the whole list, with their product profiles)
  const apis = (await client.getIntegration(orgId, String(id))).body.sdkList || [];
  if (!apis.includes(eds.code)) {
    if (apis.length) throw new Error(`Credential ${NAME} has other APIs but not ${EDS}: add ${EDS} to it in the Developer Console, then run this again.`);
    if (!DRY) await client.subscribeCredentialToServices(orgId, projectId, wsId, 'oauth_server_to_server', id, [{ sdkCode: eds.code, licenseConfigs: null, roles: null }]);
  }
  log(`  API ${EDS}: ${apis.includes(eds.code) ? 'already subscribed' : 'subscribed'}.`);
  const fresh = (await client.downloadWorkspaceJson(orgId, projectId, wsId)).body.project.workspace.details.credentials
    .find((c) => String(c.id) === String(id)).oauth_server_to_server;
  return {
    CF_SYNC_CLIENT_ID: fresh.client_id,
    CF_SYNC_CLIENT_SECRET: fresh.client_secrets[0],
    CF_SYNC_SCOPES: (fresh.scopes || []).join(','),
    CF_SYNC_TECH_ACCOUNT_ID: fresh.technical_account_id,
    CF_SYNC_TECH_ACCOUNT_EMAIL: fresh.technical_account_email,
  };
}

async function permission(token, email) {
  const url = `https://admin.da.live/config/${daOrg}/`;
  const H = { Authorization: `Bearer ${token}` };
  const res = await fetch(url, { headers: H });
  if (!res.ok && res.status !== 404) throw new Error(`Reading the ${daOrg} DA org config failed (HTTP ${res.status}): you need to be able to edit it.`);
  const next = withPermissionRow(res.ok ? await res.json() : null, email);
  if (!next) { log(`DA permissions (${daOrg}): technical account already allowed.`); return; }
  if (DRY) { log(`DA permissions (${daOrg}): would add "/ + **" write for ${email}.`); return; }
  const body = new FormData();
  body.append('config', JSON.stringify(next));
  const put = await fetch(url, { method: 'POST', headers: H, body });
  if (!put.ok) throw new Error(`Saving the ${daOrg} DA org config failed (HTTP ${put.status}).`);
  log(`DA permissions (${daOrg}): technical account allowed to write every site.`);
}

async function apiKey(token, env) {
  if (env.AEM_LIVE_API_KEY) { log('aem.live API key: reused from .env.'); return {}; }
  if (DRY) { log(`aem.live API key: would be created for org ${daOrg} (role publish).`); return {}; }
  const res = await fetch(`https://admin.hlx.page/config/${daOrg}/apiKeys.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-content-source-authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'da-content-fragments sync service: preview and publish pages', roles: ['publish'] }),
  });
  if (!res.ok) throw new Error(`Creating the aem.live API key failed (HTTP ${res.status}): you need the admin role for org ${daOrg}.`);
  const k = await res.json();
  log(`aem.live API key: created (expires ${k.expiration}).`);
  return { AEM_LIVE_API_KEY: k.value, AEM_LIVE_API_KEY_ID: k.id, AEM_LIVE_API_KEY_SCOPE: 'org' };
}

const where = JSON.parse(execFileSync('aio', ['console', 'where', '--json'], { encoding: 'utf8', shell }));
if (!where.org || !where.project || !where.workspace) {
  log('Select your Developer Console org, project and workspace first (aio console org/project/workspace select).');
  process.exit(1);
}
log(`Adobe org: ${where.org} | project: ${where.project} | workspace: ${where.workspace} | DA org: ${daOrg}${DRY ? ' (dry run)' : ''}\n`);
// .aio (project ids) and the runtime credentials, merged into .env in this folder
execFileSync('aio', ['app', 'use', '--global', '--no-input'], { stdio: 'ignore', shell });
const aio = JSON.parse(fs.readFileSync('.aio', 'utf8'));
const libs = aioLibs();

const creds = await credential(libs, aio);
if (creds && !DRY) writeEnv(creds);
const token = daToken();
if (creds) await permission(token, creds.CF_SYNC_TECH_ACCOUNT_EMAIL);
const key = await apiKey(token, readEnv('.env'));
if (!DRY && key.AEM_LIVE_API_KEY) writeEnv(key);

let brokerUrl = null;
if (!DRY && !flag('no-broker')) { brokerUrl = deployBroker(); log(`Broker deployed: ${brokerUrl}`); }
if (!DRY) { deploySync({ inputs: readEnv('.env'), orgs: daOrg }); log(`Sync service deployed (DA org ${daOrg}).`); }

log(`
Left to do by hand:
1. Event registration (once per AEM environment): Developer Console → ${where.project} → ${where.workspace}
   → Add service → Event → AEM Sites → your AEM author environment → "Content Fragment Published"
   → credential ${NAME} → Runtime action da-cf-sync/fragment-published.${brokerUrl ? `
2. In each site's Content Fragments panel: Setup → More settings → broker:
   ${brokerUrl}` : ''}
Keep .env in this folder private; run this command here again to update the deployment.`);
