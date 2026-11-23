# da-content-fragments

AEM Content Fragments in DA and Experience Workspace, for any EDS site and any AEM as a Cloud
Service environment, with no per-environment CORS setup. Built on Mark Szulc's Content Fragment
plugin for Fréscopa ([markszulc/frescopa26](https://github.com/markszulc/frescopa26/tree/main/tools/plugins/content-fragment),
Apache-2.0); this repository makes it generic. Status: broker, panel, setup wizard, live preview
and Content Advisor placement work; re-rendering pages when a fragment is published follows (see
Roadmap).

- **New here?** [Getting started](docs/getting-started.md): add the extension to a site, connect
  it to AEM, and edit fragments, with screenshots.
- **Developers:** [Architecture](docs/architecture.md): the parts, the broker's security model,
  the flows, the modules, testing, deploying and extending.

## The problem it solves

| Browser origin | AEM author | AEM publish |
|---|---|---|
| `experience.adobe.com` (Adobe consoles) | allowed by default | allowed |
| `da.live`, `*.aem.page`, App Builder static hosting | **refused** | allowed |

A DA panel that talks to author from the browser works only after each AEM environment deploys
its own CORS policy (an OSGi config through Cloud Manager). That does not scale across demos and
customers. Fréscopa's plugin also hard-codes its author URL, its IMS organization, FAQ fields
and its own published-content endpoint.

## Design

1. **Broker, not CORS.** The panel calls one App Builder web action (`actions/cf`) with the
   signed-in DA user's IMS token. The action calls AEM author server to server with that same
   token, so AEM permissions still apply. CORS is configured once, on the action, for `da.live`,
   `*--*--*.aem.page|live`, DA's live-preview proxy `*--*--*.preview.da.live` (where Experience
   Workspace runs panel extensions and the page preview) and localhost. The action only calls an author host that Adobe's
   repository discovery lists for that token, refuses anything else before any request, writes
   only fields/title/description with the caller's strong ETag (`If-Match`) and a fresh CSRF
   token, stores nothing and never logs tokens. One deployment serves every site.
2. **Configured per site, not coded.** A sheet in the site's DA config holds the author and
   publish hosts, folders to browse, model → block and template, editable fields and the
   usage-metadata property. Editor links open in the author's own org, found from repository
   discovery, so no tenant is configured. The panel builds its
   form from the fragment model (text, long text, rich text, enumeration, references).
3. **One renderer, preview and live.** Each model has a Mustache template that turns a fragment
   (and a variation) into EDS block markup. The same template renders author content in the
   Experience Workspace preview and the delivered page, so they cannot drift.
4. **Static by default, live per block.** Static: the rendered markup is written into the DA
   document (Lighthouse 100, visible to crawlers and AI agents, personalization holdouts stay
   exact). Live: the block reads AEM publish in the browser, which publish already allows, for
   facts that change often (prices, hours, availability).
5. **Variations are first class.** A block references fragment + variation; cohorts and
   experiments choose the variation.
6. **Publishing closes the loop.** An AEM "fragment published" I/O event triggers the broker
   project to re-render the static blocks that use the fragment (usage metadata, as in
   Fréscopa) and re-preview those pages.

Each site gets its own copy of the panel and block (installed by `npx
github:AEMXSC/da-content-fragments install`, see [Install on a site](#install-on-a-site)): EDS code on `aem.live` carries no CORS header, so a shared module
cannot be imported across sites, and the panel must share the preview's origin for the live
preview swap.

## Broker API

`POST <action URL>` with `Authorization: Bearer <IMS token>` and a JSON body:

| `op` | Fields | AEM call |
|---|---|---|
| `list` | `author, path, limit?, cursor?, projection?` | `GET /adobe/sites/cf/fragments?path=` (subfolders included) |
| `folders` | `author, path?, cursor?` | `GET /adobe/folders?path=` |
| `get` | `author, id, variation?` | `GET /adobe/sites/cf/fragments/{id}[/variations/{v}]?references=direct-hydrated` |
| `variations` | `author, id` | `GET …/fragments/{id}/variations` |
| `model` | `author, model` | `GET /adobe/sites/cf/models/{id}` |
| `metadata` | `author, id` | `GET …/fragments/{id}/metadata` |
| `patch` | `author, id, variation?, etag, ops` | `PATCH …/fragments/{id}[/variations/{v}]` (fields, title, description only) |
| `patch-metadata` | `author, id, etag, ops` | `PATCH …/fragments/{id}/metadata` |
| `publish` | `author, id` | `POST /adobe/sites/cf/fragments/publish` (`{ ids: [id] }`; CSRF, no ETag) |

Returns `{ data, etag }`, or `{ error }` with 401/403/404/409/422/428.

## Sync service: AEM publish updates the pages

Publishing a fragment in AEM updates and republishes the Edge Delivery pages that show it, on
every site in the DA org whose Setup points at that AEM environment. It is an App Builder action
run by AEM's "Content Fragment published" event; it reads the fragment from AEM publish and writes
DA with its own server-to-server credential. How it works, what it needs and how to deploy it:
[architecture.md, The sync service](docs/architecture.md#the-sync-service).

## Run your own backend (any Adobe organization)

There are two server parts: the **broker** (the panel's way into AEM author) and the **sync
service** (publishing in AEM updates the pages). Who needs what:

| You are | Panel (edit, Save, Publish) | Sync (publish in AEM updates pages) |
|---|---|---|
| AEM XSC (DA org `aemxsc`, AEM e1614585) | Install + Setup; uses the XSC broker | Already running for every aemxsc site that ran Setup |
| Another team, partner or customer (your own Adobe org) | Works with the XSC broker by default; run your own for production | Needs your own: Adobe delivers AEM events only to a project in the same organization |

Your own backend is one command, run in an empty folder (it keeps a `.env` with the secrets
there: keep the folder private, and run the command there again to update):

```bash
npm install -g @adobe/aio-cli          # once
aio login
aio console org select <your org> && aio console project select <your App Builder project> && aio console workspace select <workspace>
npx github:AEMXSC/da-content-fragments backend --da-org <your DA org>    # --dry-run first to see what it will do
```

It creates or reuses, in your organization only:
1. the OAuth server-to-server credential `da-cf-sync` (Edge Delivery Services API) in that
   workspace;
2. a row in your DA org's `permissions` sheet letting its technical account write every site;
3. an aem.live API key (role `publish`) for your org;
4. the broker (`da-cf/cf`) and the sync service (`da-cf-sync/fragment-published`), deployed
   to that workspace (`--no-broker` to keep using another broker).

Two steps are left, and it prints them:
1. **The event registration**, once per AEM environment: Developer Console → your project →
   workspace → Add service → Event → AEM Sites → the environment → **Content Fragment
   Published** → credential `da-cf-sync` → Runtime action `da-cf-sync/fragment-published`.
2. **Your broker URL** in each site's panel: **Setup** → **More settings** → broker.

What you need: an App Builder project in your org (any name, with I/O Runtime); the right to edit
your DA org's config and the aem.live org config (the command signs you in with Adobe's
da-auth-helper); AEM Eventing available for your AEM as a Cloud Service environment.

Details: [architecture.md](docs/architecture.md) (the broker, the sync service). The broker's
CORS origins can be widened with the action input `ALLOWED_ORIGINS` (comma-separated regular
expressions). Manual deploys from a clone: `npm run deploy` (broker) and
`node scripts/deploy-sync.mjs <DA org>` (sync service, reads `.env`: see `.env.example`).

## Install on a site

1. In the root of the site's repo, run:

   ```bash
   npx github:AEMXSC/da-content-fragments install            # --dry-run shows what it would change
   ```

   It copies `tools/content-fragments/` (panel), `scripts/cf-render.js`, `scripts/cf-bridge.js`
   and `blocks/cf-card/` (the default layout for models without a template); a site's own
   `templates/` folder is kept. It also:
   - wires the bridge into `loadDelayed()` in `scripts.js` (preview frames only);
   - adds the panel to the lint ignore files;
   - signs in with Adobe's da-auth-helper and adds the `Content Fragments` row to the site's DA
     `library` sheet.

   The DA org and site come from `fstab.yaml` or the git remote (`--org`, `--site` override).
   Anything it cannot do safely it lists as a by-hand step. Run it again to update. A coding
   agent can do the same, and the manual steps are in
   [getting-started.md](docs/getting-started.md#1-add-the-extension-to-a-site).
2. Commit and push the site repo.
3. Open the panel in Experience Workspace: the first time, it runs **Setup** (no other sheet
   editing):
   1. pick the AEM author from your environments (Adobe repository discovery) and a Content
      Fragment folder (open folders level by level; fragments in subfolders count too);
   2. review the models found there (every fragment in the folder is read): a model gets the
      site's template for it if the site ships one (see [Writing templates](#writing-templates)),
      else a starter template from its fields (the `cf-card` block); editable, and previewed on a
      real fragment with the site's styles;
   3. save: the wizard writes the config below, including the Content Advisor dialog entry.
      Experience Workspace reads the library list when it loads, so when the save adds that
      entry the panel reloads Workspace (same page, SDK `setHref`). In the classic DA editor,
      reload the page once yourself.
   Only people who can edit the site's DA config can save; **Setup** (top right) reopens it.
   A model with no template at all still works: the panel uses its starter template.

   What Setup writes, for reference (`https://da.live/config#/<org>/<site>`):
   - `library`: `Content Fragments` → `/tools/content-fragments/index.html`, experience `inline`;
     and `Content Advisor` (this exact title: the panel opens it by id `content-advisor`) →
     `/tools/content-fragments/index.html?advisor=1`, experience `fullsize-dialog`;
   - sheet `content-fragments` (key/value): `broker` (action URL), `author` (author host),
     `tenant` (optional fallback for "Open in AEM" links when the author's IMS org cannot be
     found; links normally use `@<IMS org>`, which Experience Cloud switches to), `link-base` (optional,
     origin for root-relative fragment links; the site's `/redirects.json` keeps moved pages
     local), `advisor-folder` (optional, DAM folder Content Advisor opens on);
   - sheet `content-fragment-models`: `model` (model path or name), `label`, and `html` (the
     template, as Setup saves it) or `template` (a template file in the site code);
   - optional `asset-base` (where fragment images load from; default: the author's publish host).
4. Reference fragments on a page: Section Metadata `Fragment` + `Variation`, or a Content
   Fragment block. Or place them: **Browse with Content Advisor** in the panel inserts each
   picked fragment (and variation) at the cursor as its own section, rendered with its model's
   template, with that Section Metadata.

## Writing templates

A template turns one fragment into one EDS block. Ship it with the site so Setup offers it:
`tools/content-fragments/templates/<model name>.html`, where the model name is the last part of
the model path (`/conf/frescopa/settings/dam/cfm/models/frescopa-product` →
`frescopa-product.html`). Example: AEMXSC/frescopa26 `templates/frescopa-product.html` with its
`blocks/cf-product` block.

- **One block, as rows and cells:** a root `<div class="block-name">`, each child `<div>` a row,
  each grandchild `<div>` a cell, the way the block appears in `.plain.html`.
- **Fields by name** (Mustache subset, `scripts/cf-render.js`): `{{name}}` escaped, `{{{body}}}`
  raw (rich text), `{{#heroImage}}…{{/heroImage}}` only when set, `{{#tags}}{{.}}{{/tags}}` per
  item. Image references (`content-reference`) are full URLs on AEM publish; fields ending in
  `url`/`href` are resolved against `link-base` and the site's redirects.
- **Rows with different numbers of cells: make the block ignore empty cells.** DA's editor keeps
  block tables rectangular: when a row has fewer cells than the widest row, it can fill the row
  with empty cells. Content Advisor inserts avoid this (a short row's last cell spans the table,
  and a merged cell is one cell on the page), but a table an author or the editor has squared
  will reach the block with the extra empty cells. Either give every row the same number of
  cells, or drop empty cells before reading the rows:

  ```js
  const filled = (cell) => cell.textContent.trim() || cell.querySelector('picture, img');
  [...block.children].forEach((row) => {
    [...row.children].forEach((cell) => { if (!filled(cell)) cell.remove(); });
  });
  ```

  Without it, a block that tells rows apart by their number of cells (a one-cell header row and a
  four-cell facts row, say) reads a padded header row as a facts row.
- **Match rows by content, not position,** where you can (the row with the picture is the image
  row): authors may leave an optional row out.
- **Publish the images in AEM.** The page loads them from AEM publish; an unpublished asset shows
  as a broken image.

## Roadmap

- v0.2 panel (done): On this page (fragment + variation per block or section), publication status,
  model-driven field editing per variation, editor links, Content Advisor picker, setup wizard,
  installer.
- v0.3 renderer + static delivery (`materialize`), live mode block.
- v0.4 I/O Events re-render on publish; AEM editor extension listing DA pages that use a fragment.

## Credits

Mark Szulc (original Fréscopa plugin: panel, ETag-guarded saves, usage metadata, Content Advisor
picking), Cedric Huesler (homepage-cohorts, whose cohort heroes are the first consumer).
