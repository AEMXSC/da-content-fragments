# CLAUDE.md — da-content-fragments

> Loaded automatically by Claude Code and AI coding agents.
> Defines the rules of this repo. Follow these before writing a single line.
> **Do not override without explicit instruction from the project owner.**

---

## Project Identity

- **Project:** da-content-fragments
- **Type:** DA / Experience Workspace extension (panel + setup wizard + Content Advisor dialog) with an App Builder broker
- **Owner:** AEMXSC (AEM Expert Solution Consulting)
- **Repo:** github.com/AEMXSC/da-content-fragments
- **Broker (stage):** https://3635370-dacontentfragments-stage.adobeioruntime.net/api/v1/web/da-cf/cf
- **Reference site:** AEMXSC/tsc (DA aemxsc/tsc), which vendors `site/` into its own repo
- **Production broker:** [FILL IN] (none yet; the stage action is the shared demo broker)

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Panel UI | Vanilla ES modules, no build | Runs in the DA library rail and an EW full-size dialog |
| Styling | Plain CSS on Spectrum 2 | `da.live/nx2/styles/{styles,buttons,form}.css`; `--s2-*` tokens (light-dark) |
| Language | JavaScript (ESM) | No TypeScript, no bundler |
| Host SDK | DA SDK `https://da.live/nx/utils/sdk.js` | `subscribeLiveDocument`, `sendHTML`, `showPanel`, `closeLibrary` |
| Broker | Adobe App Builder (I/O Runtime action `actions/cf`) | Calls AEM author server to server with the user's IMS token |
| AEM | AEM Cloud Service author, Sites OpenAPI fragments | Discovery: `aem-discovery.adobe.io/repositories` |
| Site runtime | AEM Edge Delivery Services | `site/scripts/cf-bridge.js`, `cf-render.js`, `site/blocks/cf-card` |
| Tests | `node --test` + linkedom | `npm test` |
| Package manager | npm | Node >= 22 |

---

## Folder Structure

```
/
├── actions/cf/            # App Builder broker: index.js (HTTP, CORS), lib.js (validation, ops)
├── bin/install.mjs        # site installer (npx github:AEMXSC/da-content-fragments install)
├── bin/lib.mjs            # installer logic, no I/O (test/install.test.mjs)
├── scripts/deploy.mjs     # zips and deploys the broker action (npm run deploy)
├── site/                  # copied into each EDS site repo (vendored, e.g. AEMXSC/tsc)
│   ├── tools/content-fragments/   # the panel: index.html, panel.js, editor.js, setup.js,
│   │                              # advisor.js, broker.js, refs.js, apply.js, discovery.js,
│   │                              # starter.js, ui.js, panel.css, img/icons (S2 svg)
│   ├── scripts/cf-render.js       # Mustache-subset renderer (preview and delivery share it)
│   ├── scripts/cf-bridge.js       # runs in the page preview; merges renders in place
│   └── blocks/cf-card/            # generic default block for starter templates
├── test/                  # *.test.mjs, node --test
├── .env / .aio            # App Builder credentials: never committed
└── README.md              # install and config reference
```

---

## Naming Conventions

| Thing | Convention | Example |
|---|---|---|
| Modules | lowercase, one word where possible | `editor.js`, `discovery.js` |
| Functions | camelCase, verb first | `openEditor`, `listAuthors` |
| Constants | SCREAMING_SNAKE_CASE | `DEFAULT_BROKER` |
| Tests | `<area>.test.mjs` | `setup.test.mjs` |
| CSS classes | short lowercase, hyphenated | `.row-status`, `.pick-meta` |
| Broker ops | lowercase verbs | `list`, `get`, `patch`, `folders` |
| DA config keys | kebab-case | `advisor-folder`, `link-base` |

---

## Code Style Standards

### JavaScript
- `const` over `let`, never `var`; arrow functions for callbacks
- DOM through `el()` from `ui.js` (text via `text`, never `innerHTML` with fragment or user data)
- Airbnb ESLint as configured in the site repo (AEMXSC/tsc `eslint.config.mjs`): no nested ternaries,
  no nested template literals, define before use, max line 220
- Comments explain why, at the density of the surrounding code
- Small files (200–400 lines, 800 max) and functions (< 50 lines)

### CSS
- Spectrum 2 tokens (`var(--s2-*, fallback)`) for color, spacing, radius and type; raw px only for
  fixed sizes (icons, dots)
- Contrast 4.5:1 for text in light and dark, including hover fills (check `light-dark()` tokens)
- `[hidden]` must win: keep the global `[hidden] { display: none !important; }`
- Stylelint (site repo `.stylelintrc.json`): one declaration per line

### Copy
- The product's own words: Main (not master), Save to AEM, Apply to page, Publish
- Errors name the problem and the recovery; no raw HTTP codes without a next step
- Messages for one fragment appear in its row (`.row-status`), not only the top status line

---

## Code Quality — Non-Negotiable

- No `console.log` in committed code
- Every `fetch()` checks `response.ok` before parsing
- Every async path has try/catch or explicit propagation to a status message
- Loading, error and empty states for every list and fetch
- Remove what your change made unused; do not refactor what you did not touch

### Security
- Never print, log or commit tokens (DA, IMS, aio), cookies or the Optel domain key
- The broker validates every input: author host `author-pN-eN.adobeaemcloud.com`, `/content/dam` paths
  (no `.`/`..` segments), cursors, variation names; CORS only for allowed origins
- Content Advisor picks and section metadata are validated before use
- `sendHTML` replace always carries `expected` (document + selection) so stale edits are refused
- Sandboxed iframes for template samples: never `allow-scripts`

### Accessibility (WCAG 2.2 AA)
- Semantic controls (`<button>`, `<label for>`), visible focus rings on custom controls
- Focus moves to each setup step's heading
- Status in text, never color alone (status lights carry labels)

---

## Testing

- `npm test` (node --test, linkedom) before every commit: renderer, broker validation, refs,
  apply/merge, setup merge, morph
- UI changes: check in a browser at 360px (panel width), light and dark, and the dialog at ~1100px
- Mock external services in tests; never call AEM, DA or the broker from tests
- Lint in the site repo: `npx eslint --no-ignore tools/content-fragments/*.js` and stylelint on panel.css

---

## Git and PR Conventions

- Conventional commits: `feat|fix|refactor|docs|test|chore: <description>`
- Commit or push only when the owner asks; confirm `git rev-parse --show-toplevel` and the remote first
- Keep `site/` and the vendored copy in the site repo in step (same files, same commit wording)
- Broker deploys (`npm run deploy`) and shared DA config writes need the owner's review

---

## Environment Variables

- `.env` and `.aio` hold App Builder credentials: never committed (see `.gitignore`)
- `ALLOWED_ORIGINS` (action input) overrides the default CORS origin patterns

---

## AI Agent Behavior Rules

1. Read the folder structure before creating files: extend existing modules
2. Ask before adding dependencies (the panel has none; keep it that way)
3. Never auto-commit: summarize what changed and why first
4. Flag scope creep: panel, broker and site runtime are separate deploys
5. Surface architectural issues (e.g. the shared stage broker) instead of working around them
6. Self-review every non-trivial change against this file
