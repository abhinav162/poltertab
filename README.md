# PolterTab — Browser Control for Any AI

**Let any AI agent use the Chrome you're already logged into.** PolterTab is a Chrome extension plus a local MCP (Model Context Protocol) server.

[![Add to Chrome — available in the Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Add%20to%20Chrome-1A73E8?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/poltertab-browser-control/lcijocampajjmennelacdfehmhndfmbd)
[![npm version](https://img.shields.io/npm/v/poltertab?logo=npm&color=cb3837)](https://www.npmjs.com/package/poltertab)
[![npm downloads](https://img.shields.io/npm/dm/poltertab?logo=npm&color=cb3837)](https://www.npmjs.com/package/poltertab)
[![license](https://img.shields.io/npm/l/poltertab)](https://www.npmjs.com/package/poltertab)

A Chrome extension + Model Context Protocol (MCP) server. The AI acts inside the browser you already use: your real profile, your cookies, your logged-in sessions. Install the extension, point your MCP client at the server, done — it works with Claude Desktop, Cursor, or any MCP-compatible agent.

## Why PolterTab

- **Your real profile** — runs in the Chrome you're already signed into. No fresh headless browser that's logged out of everything.
- **No complex setup** — add the extension from the Chrome Web Store, add one MCP entry. That's it.
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

## What leaves your machine

PolterTab runs entirely on your machine. There is no PolterTab server, account, or telemetry.

- **The MCP server is local.** It talks to your AI client over stdio, and the WebSocket the extension uses listens only on this machine (`127.0.0.1` and `::1`, port 7822 by default). The server refuses connections from web pages — browser connections must come from a Chrome extension (`chrome-extension://`) origin — and only the Chrome Web Store build (trusted automatically) or an extension you have paired can hold that connection, change upload settings, or read the logs. ([architecture](#how-it-works))
- **Page content goes only where your agent sends it.** PolterTab returns what it reads or scrapes to your MCP client; your client forwards it to whatever model provider *you* have configured. PolterTab itself transmits page content nowhere.
- **File uploads are off until you allow a folder.** `browser_upload_file` refuses every path until you add a folder with `poltertab uploads allow <dir>`, and sensitive locations are always blocked and cannot be allowlisted. Run `poltertab uploads` to see the current list.
- **npm provenance.** Releases are published with `npm publish --provenance`, so npm records a signed, verifiable link from the published tarball back to the GitHub Actions build that produced it.
- **One exception — the version check.** The running server makes one outbound request, a daily npm version check (`registry.npmjs.org`); `poltertab setup` additionally does a one-time Chrome Web Store version lookup (`clients2.google.com`). Both only compare versions to warn about a server/extension mismatch — no page content or personal data is sent. Turn both off with `POLTERTAB_NO_UPDATE_CHECK=1`.

> **From 1.12.0,** only the Chrome Web Store extension or one you have paired can control the browser; an unpacked install pairs once with `poltertab uploads pair`.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

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

**[Add to Chrome](https://chromewebstore.google.com/detail/poltertab-browser-control/lcijocampajjmennelacdfehmhndfmbd)** from the Chrome Web Store. Chrome keeps a Store
extension up to date on its own, so this is the install path for everyone who
is not developing the extension itself.

Then restart your AI tool so it picks up the new tools.

<details>
<summary>Or load it unpacked (developer / offline path)</summary>

Use this when you are changing the extension or cannot reach the Web Store.
An unpacked extension never updates on its own; you reload it from a newer zip
yourself.

1. Download the latest [release zip](https://github.com/abhinav162/poltertab/releases/latest) and unzip it into its own folder (e.g. `unzip poltertab-extension-vX.zip -d poltertab-extension`, or double-click on macOS — which creates a folder automatically)
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select that folder (the one containing `manifest.json`)
5. Pair it once so it can control the browser: run `poltertab uploads pair` and enter the 4-character code the extension shows. (Store installs are trusted automatically and skip this.)

</details>

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

**Using [Cursor](https://cursor.com)?** One-click install (adds the stdio entry above):

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=poltertab&config=eyJjb21tYW5kIjoicG9sdGVydGFiIn0%3D)

Running from a clone instead of npm? Point the client at the file directly:
`{"command": "node", "args": ["/absolute/path/to/poltertab/mcp-server/index.js"]}`

## Supported MCP Tools

The server exposes 28 tools to the LLM (all prefixed with `browser_`). Every
page-facing tool also takes optional `tabId` and `session` to target a specific
tab — omit both and PolterTab uses the agent's current tab: the last one it
navigated, opened or switched to. The first `browser_navigate` (and the first
`browser_navigate` of each new session) opens its own tab rather than
commandeering the one you are looking at.

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
| `browser_session_create` | `name` (required), `url`, `tabId` | Create a session, adopt an open tab, or bind one to the active tab |
| `browser_session_switch` | `name` (required) | Make a session active, recovering its tab if closed |
| `browser_session_list` | — | All sessions, each `alive`, `recoverable`, or `expired` |
| `browser_session_close` | `name` (required), `force` | Close a session and its tab. Adopted tabs return `needs_user_permission`; retry with `force: true` after asking the user. |
| `browser_session_context` | — | The current tab's id, URL, title and session, or `closedTabId` |

### Tabs

One agent can drive many tabs. Each agent (and each secondary server) has its
own **current tab**; page-facing tools without `tabId`/`session` act there. An
explicit `tabId` acts on that tab without changing the current one; a `tabId`
Chrome does not have returns `tab_not_found` on any tool that takes one. If the
current tab is closed, untargeted calls fail with a message naming the closed
tab instead of quietly acting on another one.

| Action | Parameters | Description |
| -------- | ----------- | ------------- |
| `browser_tab_new` | `url`, `session`, `background` | Open a tab and make it current |
| `browser_tab_list` | `all` | PolterTab's tabs (or every tab), marking the current one |
| `browser_tab_switch` | `tabId` or `session`, `focus` | Make another tab current. A tab that does not exist in Chrome returns `tab_not_found`. |
| `browser_tab_close` | `tabId` or `session`, `force` | Close a tab (default: current). Tabs not opened by PolterTab (including ones adopted via `browser_session_create({tabId})`) return `needs_user_permission` — ask the user, then retry with `force: true`. A tab that does not exist in Chrome returns `tab_not_found`. |

### File upload

| Action | Parameters | Description |
| -------- | ----------- | ------------- |
| `browser_upload_file` | `selector` (required), `paths` (required), `method` (`"picker"` or `"drop"`), `tabId`, `session` | Upload local files to a page. `method: "picker"` (default) clicks `selector` and intercepts the OS file chooser via CDP — works for any `<input type="file">` or button that opens one. `method: "drop"` dispatches a DataTransfer drag-and-drop event — use for drop zones. Paths must be within directories listed in `upload_allowed_paths` in `~/.poltertab/config.json`. A brief debugging banner appears during picker uploads (CDP requirement). |

**Configuration** — add `upload_allowed_paths` to `~/.poltertab/config.json` before using `browser_upload_file`:

```json
{
  "upload_allowed_paths": ["/Users/you/Documents", "/Users/you/Downloads"]
}
```

Always-blocked regardless of the allowlist: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `/etc`, `/private/etc`, `/System`, `/private/System`, `/Library`, `/private/Library`, `/proc`, home dotfiles. Note: `/tmp` (and its macOS realpath `/private/tmp`) is **not** blocked and can be added to `upload_allowed_paths` normally.

### Site memory

| Action | Parameters | Description |
| -------- | ----------- | ------------- |
| `browser_get_site_memory` | `hostname` (or `domain`) | Recorded obstacles and fixes for a domain |
| `browser_save_site_memory` | `hostname` (or `domain`), `obstacle`, `solution` | Record what broke on a site and how it was solved |

### Selector Resolution

Selectors are resolved in order:

1. **Snapshot ref** — `@e12`, as returned by `browser_snapshot`. Resolves to the
   exact node the snapshot described, and beats a generated class chain.
2. **CSS selector** — `#id`, `.class`, `div > span`
3. **XPath** — `//div[@class="foo"]`
4. **Text match** — exact text content of an element

A miss on all four is retried with shadow-root piercing (open roots, one level deep) and top-level same-origin iframe search. Nested iframes (iframe inside iframe) and cross-origin iframes are not supported; the tool returns a clear error in those cases.

## Troubleshooting & Options

**Running several agents at once:**
The first MCP server to bind port `7822` becomes the **primary** and owns the
connection to the extension. Later servers find the port taken and switch
themselves into **secondary** mode, proxying their commands through the primary,
so concurrent agents share one browser with no extra configuration. The
primary tags each secondary's commands with its id, and the extension keeps a
separate current tab per agent, so agents get their own tabs. Up to
`POLTERTAB_MAX_SECONDARIES` v2 secondaries are accepted (default 50); if the
primary exits, one secondary promotes itself to replace it. The extension popup
lists whichever agents are connected.

**How many agents can share one browser:**
Up to 50 v2 secondaries (one process each) plus the primary can share one
browser. Raise or lower the ceiling with `POLTERTAB_MAX_SECONDARIES`. An agent
that is idle for `POLTERTAB_IDLE_EVICTION_MS` (default 5 minutes) is evicted
with close code 4001 to free the slot; it reconnects automatically the next time
it sends a command, so eviction is transparent to the agent. An agent whose
major version does not match the primary's is refused with close code 4002 —
see [Upgrade path](#upgrade-path-1x--18) below.

**Command queue:**
The primary limits how many commands it sends to the extension at once
(`POLTERTAB_MAX_CONCURRENCY`, default 6). When that limit is reached, a v2
secondary's command is queued per-secondary (up to `POLTERTAB_QUEUE_DEPTH`
slots, default 3). The queued command is acknowledged immediately with
`{"type":"queued","id":"...","position":N}` so the caller knows its command is
pending, not lost. A v2 secondary re-arms its 35 s timeout on this
acknowledgement and again on `{"type":"dispatched","id":"..."}` when the command
leaves the queue, so queue wait never consumes the execution budget. A command
that arrives when the per-secondary queue is already full is refused immediately
with `[queue_full action=X]`. The primary itself queues its own direct commands
under the same ceiling. A queued command is dropped with `[queue_timeout action=X]`
when the caller's 35 s budget is nearly spent (a 2 s margin keeps the drop ahead
of the caller's own timer). `POLTERTAB_QUEUE_TIMEOUT_MS` (default 60 s) is a
separate GC backstop for commands in a queue that never gets dequeued; it does
not extend queue wait time.

**`/status` endpoint:**
`GET http://127.0.0.1:7822/status` returns a JSON snapshot of the primary's
queue state, connected agents, and wait-time percentiles (p50/p95/p99). It is
restricted to loopback callers (`127.0.0.1`, `::1`, or `::ffff:127.0.0.1`) and
to requests whose `Host` header names `localhost` or a loopback address; all
others receive 404.

**Extension reconnection:**
The Chrome extension reconnects automatically when the bridge server restarts or
the WebSocket drops. It dials immediately on disconnect, then backs off 1 s,
2 s, 4 s … up to 30 s, with an alarm that wakes the service worker if it was
suspended mid-schedule. While reconnecting, commands return:

- `[extension_reconnecting port=7822 elapsed=Xs]` — the extension disconnected
  and is on its way back. Retry shortly.
- `[extension_never_connected port=7822]` — the extension has never connected to
  this server instance. Check that the extension is installed, enabled, and
  pointed at the right port.

**Close codes:**

| Code | Meaning | Agent behaviour |
|------|---------|-----------------|
| 4001 | Idle eviction — the agent was silent for `POLTERTAB_IDLE_EVICTION_MS` | Secondary dials again lazily on next command; no action needed |
| 4002 | Version mismatch — major version incompatible with the primary | Secondary stops retrying until restarted; update the npm package so every session runs the same major |

**Upgrade path (1.x → 1.8):**
PolterTab 1.8 introduces a version handshake. A secondary whose major version
does not match the primary's receives close code 4002 and stops retrying; updating
the npm package (so all sessions run the same major) resolves it. The Chrome
extension should also be updated at the same time to get the PR-4 reconnect
behaviour. Run `poltertab doctor` to check for skew before upgrading. A 1.7.x
secondary that has not upgraded does not receive 4002 (it does not speak the
handshake) and continues to work as an unversioned legacy secondary; it bypasses
the command queue and is never idle-evicted.

**Env vars:**

| Variable | Default | Description |
|----------|---------|-------------|
| `POLTERTAB_MAX_SECONDARIES` | `50` | Maximum v2 secondaries accepted |
| `POLTERTAB_IDLE_EVICTION_MS` | `300000` (5 min) | Idle before a v2 secondary is evicted with 4001 |
| `POLTERTAB_MAX_CONCURRENCY` | `6` | Extension command concurrency limit |
| `POLTERTAB_QUEUE_DEPTH` | `3` | Per-secondary queue depth before `[queue_full]` |
| `POLTERTAB_QUEUE_TIMEOUT_MS` | `60000` (60 s) | GC backstop for stuck queued commands (does not extend queue wait) |
| `POLTERTAB_COMMAND_TIMEOUT_MS` | `35000` (35 s) | Per-command budget. Must exceed the extension's 30 s navigation wait + 500 ms settle; tune for tests only |

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

**Picker uploads fail while DevTools is open:**
Chrome allows only one debugger at a time per tab. When DevTools is open on the target tab, `browser_upload_file` (method `"picker"`) fails with "Another debugger is already attached". Close DevTools on that tab before running a picker upload.

**Adding `debugger` permission requires re-approving the extension:**
Loading or reloading the extension folder after the `debugger` permission was added prompts Chrome to ask for re-approval — the extension is disabled until you click **Keep** or **Allow** on the warning dialog in `chrome://extensions/`. Unpack-loaded extensions do not auto-update, so this only happens when you explicitly reload or update the extension folder.

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

The npm package updates when you run `npm update -g poltertab`. The extension
installed from the [Chrome Web Store](https://chromewebstore.google.com/detail/poltertab-browser-control/lcijocampajjmennelacdfehmhndfmbd)
updates itself, like any Store extension. One loaded unpacked **never updates on
its own** — Chrome only auto-updates what came from the Web Store. So the
interesting failure is not a missing update, it is skew: a newer server sending
a command an older extension does not implement (or the reverse, while Chrome
has updated the extension and you have not yet run `npm update`), which
surfaces as an element mysteriously not being found.

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
