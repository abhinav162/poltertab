# PolterTab — Browser Control for Any AI

**PolterTab lets any AI assistant drive and scrape your *existing* Chrome profile — no headless browser, no separate automation setup, no re-logging into anything.**

A Chrome extension + Model Context Protocol (MCP) server. The AI acts inside the browser you already use: your real profile, your cookies, your logged-in sessions. Install the extension, point your MCP client at the server, done — it works with Claude Desktop, Cursor, or any MCP-compatible agent.

## Why PolterTab

- **Your real profile** — runs in the Chrome you're already signed into. No fresh headless browser that's logged out of everything.
- **No complex setup** — load the unpacked extension, add one MCP entry. That's it.
- **Any AI tool** — any MCP-compatible client can connect.

## How It Works

```
Any MCP Agent (Claude Desktop, Cursor, custom agents)
       │  Stdio (MCP Protocol)
       ▼
Node.js MCP Server (mcp-server/index.js)
       │  WebSocket (port 7822 by default)
       ▼
PolterTab Chrome Extension
       │  Chrome APIs + DOM
       ▼
  Your existing Chrome profile
```

Several agents can point at the same browser at once — the first server to claim
the WebSocket port serves the extension and the rest proxy through it. See
[Running several agents at once](#troubleshooting--options).

## Setup

Requires Node 18 or newer.

### 1. Run the installer

```bash
npm install -g poltertab
poltertab setup
```

The wizard asks whether to install for all projects or just the current one,
then puts three things in place:

- the `browser-navigation-strategy` skill, so the agent knows how to drive a
  browser that fights back
- a `CLAUDE.md` section, so it knows the tools exist
- the MCP server registration, via `claude mcp add`

It is safe to re-run — each step detects its own prior work, so an upgrade or a
second pass will not duplicate anything.

Prefer not to install globally? `npx poltertab setup` does the same thing.

### 2. Install the Chrome Extension

The installer prints this link when it finishes:

1. Download the latest [release zip](https://github.com/abhinav162/poltertab/releases/latest) and unzip it
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the unzipped `chrome-extension/` directory

Then restart your AI tool so it picks up the new tools.

### Other MCP clients

The wizard targets Claude Code. Any other MCP client works too — register
`poltertab` as a stdio command:

```json
{
  "mcpServers": {
    "poltertab": {
      "command": "poltertab"
    }
  }
}
```

Running from a clone instead of npm? Point the client at the file directly:
`{"command": "node", "args": ["/absolute/path/to/poltertab/mcp-server/index.js"]}`

> **Legacy:** This extension began as a ZeroClaw plugin and still speaks ZeroClaw's built-in REST bridge (`backend = "bridge"` in `~/.zeroclaw/config.toml`). That path is optional and not required for the MCP setup above.

## Supported MCP Tools

The server exposes 23 tools to the LLM (all prefixed with `browser_`). Every
page-facing tool also takes optional `tabId` and `session` to target a specific
tab — omit both and PolterTab uses the last tab it navigated. The first
`browser_navigate` of a session opens its own tab rather than commandeering the
one you are looking at.

### Page actions

| Action | Parameters | Description |
| -------- | ----------- | ------------- |
| `browser_navigate` | `url` (required) | Navigate to a URL |
| `browser_click` | `selector` (required) | Click an element (CSS/XPath/text) |
| `browser_fill` | `selector`, `value` (required), `submit` | Fill an input field, optionally submitting its form |
| `browser_hover` | `selector` (required) | Hover over an element |
| `browser_scroll` | `direction` (required), `amount`, `selector` | Scroll page or element — `up`/`down`/`left`/`right`/`top`/`bottom` |
| `browser_smart_scroll` | `direction` (required), `amount` | Scroll, then wait 2s for lazy-loaded network data to arrive |

### Reading the page

Every tool here takes `output_file`, which writes the payload to
`~/.poltertab/downloads/` and returns only a summary — row count, field names,
fill rates and two sample records. Use it for anything bigger than a glance; the
raw payload should never be the default path into a context window.

| Action | Parameters | Description |
| -------- | ----------- | ------------- |
| `browser_extract` | `record`, `fields` (required), `anchor`, `max_text`, `probe`, `output_file` | Repeating records with fields grouped per record — see below |
| `browser_extract_all` | `url_template`, `record`, `fields` (required), `key`, `limit`, `offset`, `start_page`, `max_pages`, `fill_tolerance`, `output_file` | Paginate and extract in one call, no model round-trip per page |
| `browser_scrape` | `selector`, `attribute`, `multiple`, `fields`, `max_text`, `output_file` | Scrape given elements, or the whole page. `attribute` accepts `text` as well as any attribute name; `href`/`src` come back absolute. `fields` picks which parts of a full-page scrape to return — `["meta","jsonld"]` gets og: tags and schema.org blobs without 50KB of body text |
| `browser_snapshot` | `interactive_only`, `max_nodes`, `max_depth`, `output_file` | Ref-tagged tree of visible and interactive nodes, capped at 400 |
| `browser_get_text` | `selector` (required), `max_text`, `output_file` | Text content of one element. Flags it in the result when text was cut |
| `browser_get_title` | — | Page title and URL |
| `browser_get_url` | — | Page URL and title |
| `browser_screenshot` | — | Visible tab as base64 PNG (focuses the tab) |

### Extracting records

`browser_scrape` returns a flat list, which loses track of which value belongs
to which record. That is fine for one element and dangerous for ninety: the
moment a field is optional, a flat scrape of names against phone numbers shifts
every later phone up a row and mis-assigns the rest of the page.

`browser_extract` takes a record container and resolves each field *inside* it:

```json
{
  "record": ".agent-card",
  "fields": {
    "name":    { "sel": "a.agent-card-name", "get": "text" },
    "url":     { "sel": "a.agent-card-name", "get": "href" },
    "phone":   { "sel": "a[href^='tel:']",   "get": "href", "strip": "tel:" },
    "socials": { "sel": "a.social-button",   "get": "href", "many": true }
  },
  "anchor": "url",
  "output_file": "agents.csv"
}
```

- **A missing field yields `null`.** It never shifts.
- `sel` is relative to the record root; omit it (or use `"."`) for the root itself.
- `get` is `text` (default), `href`, `src`, or any attribute name.
- `anchor` names the field a real record always has. Records missing it — the
  placeholder cards that pad the last page of a listing — are dropped and
  counted in `dropped` rather than emitted as rows of nulls.

The result reports what happened, so an empty column cannot pass for an answer:

```
{ "count": 12, "dropped": 0,
  "fill_rates": { "name": 12, "phone": 10, "socials": 0 },
  "warnings": ["socials: 0/12 within record scope, but 40 matches page-wide
                for a.social-button — record boundary likely too narrow"] }
```

That warning is the loosening probe. Any field that comes back entirely empty is
re-checked page-wide, because the container that *looks* like the record often
excludes a sibling holding some of the fields — and "0 socials" reads as "these
people have no social accounts" rather than "your selector scope is wrong".

**`browser_extract_all`** takes the same spec plus a `url_template` containing
`{page}`, and runs the loop itself. It dedups on `key` and halts on the first of:
`limit_reached`, `empty_page`, `duplicate_page` (a page whose records repeat an
earlier one — what a site does when it ignores an unrecognised page-size
param), `fill_rate_deviation` (a page whose fill rates collapse against the
first page's baseline, which is how a spec learned on page 1 quietly degrades on
page 10), or `max_pages`. It always reports which condition fired and returns
everything collected up to that point, so a halt never costs you the run.

`.csv` and `.jsonl` output files are written in those formats.

### Network capture

For sites whose DOM is obfuscated or virtualized, read the JSON driving the UI
instead of scraping elements that may not exist.

| Action | Parameters | Description |
| -------- | ----------- | ------------- |
| `browser_set_intercept_patterns` | `patterns` (required) | URL substrings to capture, e.g. `["graphql", "/api/v1/"]`. Defaults to `["graphql", "/api/", "voyager", "feed"]` |
| `browser_get_network_state` | `clear`, `output_file` | Captured raw JSON for the tab. `output_file` writes to `~/.poltertab/downloads/` and returns just the path, keeping large payloads out of the context window |

### Sessions

A session is a named tab. Giving each agent its own session stops concurrent
agents fighting over one tab; closed tabs are recreated from the stored URL on
next use.

| Action | Parameters | Description |
| -------- | ----------- | ------------- |
| `browser_session_create` | `name` (required), `url` | Create a session, or bind one to the active tab |
| `browser_session_switch` | `name` (required) | Make a session active, recovering its tab if closed |
| `browser_session_list` | — | All sessions, each `alive`, `recoverable`, or `expired` |
| `browser_session_close` | `name` (required) | Close a session and its tab |
| `browser_session_context` | — | Active session's tab, URL and title |

### Site memory

| Action | Parameters | Description |
| -------- | ----------- | ------------- |
| `browser_get_site_memory` | `hostname` (or `domain`) | Recorded obstacles and fixes for a domain |
| `browser_save_site_memory` | `hostname` (or `domain`), `obstacle`, `solution` | Record what broke on a site and how it was solved |

### Selector Resolution

Selectors are resolved in order:

1. **CSS selector** — `#id`, `.class`, `div > span`
2. **XPath** — `//div[@class="foo"]`
3. **Text match** — exact text content of an element

## CLI Wrapper (Legacy)

`zc-browser.sh` lets you send commands directly to the legacy ZeroClaw REST bridge for testing (only relevant if you use the optional ZeroClaw bridge path above):

```bash
./zc-browser.sh navigate url=https://example.com
./zc-browser.sh scrape selector="h1"
./zc-browser.sh get_title
./zc-browser.sh health
```

## Troubleshooting & Options

**Running several agents at once:**
The first MCP server to bind port `7822` becomes the **primary** and owns the
connection to the extension. Later servers find the port taken and switch
themselves into **secondary** mode, proxying their commands through the primary,
so concurrent agents share one browser with no extra configuration. Each
secondary auto-injects a per-agent `session` so agents get their own tabs. Up to
5 secondaries are accepted, and if the primary exits one of them promotes itself
to replace it. The extension popup lists whichever agents are connected.

**Changing the WebSocket Port:**
Only needed when something that *isn't* PolterTab already holds `7822` —
PolterTab servers share that port by design (see above). Both sides must move:

1. Click the Extension icon in Chrome -> **Settings**.
2. Change the WebSocket Port to a free port (e.g. `7824`) and click **Save** —
   the extension reconnects immediately, no reload needed.
3. Update your MCP Server configuration to pass the new port.
   - Using env var: `MCP_BROWSER_WS_PORT=7824 node index.js`
   - Using CLI arg: `node index.js --port 7824`
   - In Claude Desktop config:

   ```json
   "args": ["/absolute/path/to/poltertab/mcp-server/index.js", "--port", "7824"]
   ```

**Extension not connecting:**

- Ensure the MCP Server is running and pointing to the correct port.
- Reload the extension from `chrome://extensions/`

**Commands timing out / Restricted Pages:**

- Ensure you have an active tab open in Chrome.
- Chrome extensions **cannot** interact with `chrome://` URLs, the Chrome Web Store, or certain restricted pages. The MCP server will cleanly report "Cannot interact with this page" back to the agent in these cases.

## Project Structure

```
poltertab/
├── package.json               # Published npm package (deps + bin)
├── bin/
│   ├── poltertab.js           # Entry: bare = MCP server, `setup` = wizard
│   └── setup.js               # Installer (skill, CLAUDE.md, MCP registration)
├── skills/
│   └── browser-navigation-strategy/   # Shipped skill, installed by the wizard
├── assets/
│   └── claude-md-snippet.md   # The CLAUDE.md section the wizard appends
├── mcp-server/
│   ├── index.js               # MCP server (stdio) + WebSocket hub
│   └── test/run.js            # Extension + server regression suite
├── test/
│   └── setup.test.js          # Installer regression suite
├── chrome-extension/
│   ├── manifest.json          # MV3 manifest
│   ├── background.js          # WebSocket client, session manager, command router
│   ├── content_script.js      # DOM extractor + action executor (isolated world)
│   ├── interceptor.js         # fetch/XHR capture (main world)
│   ├── popup.html/js          # Connected-agents UI
│   ├── options.html/js        # Port configuration UI
│   └── icons/
├── zc-browser.sh              # CLI wrapper (legacy)
└── README.md
```

## Staying up to date

```bash
poltertab doctor
```

Reports the installed version, whether npm has a newer one, and — the part that
matters — whether the two halves agree:

```
  server      1.1.0
  extension   1.0.0  SKEW      last seen 3m ago
  bridge      listening on port 7822
  state       ~/.poltertab
  npm         1.2.0 available
```

The npm package updates when you run `npm update -g poltertab`. The extension,
loaded unpacked, **never updates on its own** — Chrome only auto-updates what came
from the Web Store. So the interesting failure is not a missing update, it is
skew: a newer server sending a command an older extension does not implement,
which surfaces as an element mysteriously not being found.

Both halves ship as one version, so a mismatch is unambiguous. The extension
reports its version when it connects; the server compares, logs it, and shows it
in the extension popup. If either half is behind, the first tool response of a
session says so once, so you hear about it without having to think to check.

Update checks hit `registry.npmjs.org` at most once a day, cached in
`~/.poltertab/update-check.json`, and never block anything. Set
`POLTERTAB_NO_UPDATE_CHECK=1` to turn them off — skew detection is local and
keeps working either way.

`poltertab doctor` exits non-zero on skew, so CI or a shell prompt can act on it.

## Where your data lives

Nothing the server accumulates is stored inside the package:

```
~/.poltertab/
├── navigation_memory/   # Per-domain obstacles and fixes (browser_save_site_memory)
└── downloads/           # output_file payloads from any read tool
```

This matters for a global npm install. The package sits in `node_modules/`, so
anything written beside the code is deleted by the next `npm update -g` — site
memory would read as amnesia after every upgrade, and scraped payloads would be
buried somewhere you would never look for them.

Set `POLTERTAB_HOME` to move the whole tree. Upgrading from a version that kept
memory in `mcp-server/navigation_memory/`? It is copied forward on first start,
and an existing note at the destination always wins.

## Releasing

Publishing is driven by GitHub Releases. The version string decides the npm
channel, so the git tag is the only thing you have to get right:

| Version | npm tag | Installed by |
|---|---|---|
| `1.2.0` | `latest` | `npm install -g poltertab` |
| `1.2.0-rc.1` | `rc` | `npm install -g poltertab@rc` |
| `1.2.0-beta.1` | `beta` | `npm install -g poltertab@beta` |
| `1.2.0-alpha.1` | `alpha` | `npm install -g poltertab@alpha` |

To cut one:

```bash
npm version 1.2.0-beta.1     # bumps package.json, syncs the manifest, tags
git push --follow-tags
gh release create v1.2.0-beta.1 --generate-notes --prerelease
```

`npm version` runs `scripts/sync-manifest-version.js`, which keeps
`chrome-extension/manifest.json` in step. The two files cannot hold the same
string — Chrome rejects a manifest version with a prerelease identifier — so the
numeric base goes in `version` and the full string in `version_name`.

Publishing the release then runs the workflow: tests, a version-consistency
check, `npm publish --provenance` on the resolved tag, and the extension zip
gets built and attached to the release.

The checks refuse to publish rather than guess. A tag that disagrees with
`package.json`, a manifest left behind, or a stable version on a release marked
*pre-release* all fail the run — that last one because it would otherwise land on
`latest` and become the default install for everyone.

Use the workflow's manual trigger (`dry_run: true`) to rehearse all of it
without publishing.

## Tests

```bash
npm install
npm test
```

No framework and no browser needed. Two suites run:

- `mcp-server/test/run.js` — content-script injection idempotence, shadow DOM
  piercing, cross-frame search, the tab-navigation load race, and the MCP server
  end to end. It spawns real server processes against a fake extension on port
  `7931`, so it never disturbs a PolterTab already running on `7822`.
- `test/setup.test.js` — the installer: scope resolution, skill install, and
  `CLAUDE.md` idempotence. Every case runs in a throwaway temp directory, so a
  leaked write cannot reach your real `~/.claude`.
