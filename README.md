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

Returns `{ data, etag }`, or `{ error }` with 401/403/404/409/422/428.

## Deploy a broker (any Adobe organization)

Sites use a shared broker by default: the AEM XSC stage action,
`https://3635370-dacontentfragments-stage.adobeioruntime.net/api/v1/web/da-cf/cf`. It only
passes each user's own token to that user's own AEM author, so no data crosses organizations.
An organization that wants to run its own broker deploys it to its own App Builder project:

1. In [Adobe Developer Console](https://developer.adobe.com/console), create a project in your
   organization from the App Builder template (any name; it needs I/O Runtime), with a
   workspace such as Stage or Production.
2. Deploy from a clone of this repository:

   ```bash
   aio login
   aio console org select <your org id>
   aio console project select <your project>
   aio console workspace select <your workspace>
   aio app use --global --no-input   # writes .env/.aio (git-ignored)
   npm test
   npm run deploy                    # zips actions/cf and updates the action; prints its URL
   ```

3. Point sites at it: in the panel, **Setup** → **More settings** → broker, or the `broker` key in
   the site's `content-fragments` config sheet.

The action is `da-cf/cf` in your workspace's namespace:
`https://<namespace>.adobeioruntime.net/api/v1/web/da-cf/cf`. To allow more browser origins than
the defaults, set the action input `ALLOWED_ORIGINS` (comma-separated regular expressions).

`aio app deploy` works too where its webpack build runs; on Windows with Node 26 it stalled at
"Building actions". The action needs no bundling (two CommonJS files), so `npm run deploy`
(`scripts/deploy.mjs`) zips `actions/cf` and updates the action directly.

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
