# PolterTab — architecture & maintainability review

2026-08-31 · against `47a2890` (v1.4.0) · 7.8k LOC across two runtimes

---

## 1. What the architecture actually is

Four processes, one command word travelling through all of them:

```
MCP client (Claude)
   │  stdio JSON-RPC
   ▼
mcp-server/index.js ─────────── WS :7822 ────────── background.js  (MV3 SW)
   │  Primary or Secondary                            │  chrome.tabs.sendMessage
   │  (EADDRINUSE ⇒ Secondary, proxies to Primary)    ▼
   │                                            content_script.js  (isolated world)
   └── ~/.poltertab/{navigation_memory,downloads}     │  window.postMessage
                                                      ▼
                                              interceptor.js  (MAIN world, patches fetch/XHR)
```

**The transport story is the good part.** The primary/secondary election (index.js:123–263)
is a genuinely nice piece of engineering: bind the port or become a client of whoever did,
and promote yourself on their death with jittered backoff. No lockfile, no supervisor. The
MV3 keepalive/reconnect via `chrome.alarms` (background.js:487–510) is the correct answer to
service-worker suspension, not a hack.

**The frame-search strategy** (background.js:929–1010) — probe frame 0 with `_noWait`, fan out
to all child frames in parallel, then one waited retry on frame 0 for late-mounting portals —
is the right shape and the comment explaining the cost model is exemplary.

**Coding practices, honestly assessed:** above average. Comments explain *why*, and most of
them name the specific bug that motivated the code (`fill` never worked on textareas; the
30s hang on fast pages; the field-shift that mis-assigned 90 agents' phone numbers). The
2,431-line regression suite runs real processes and real stdio, with no framework. The
`ponytail:` markers name their own ceilings. This is not a codebase that needs rescuing.

The gaps below are about **structure**, not quality.

---

## 2. The real modularity gaps, ranked by payoff

### G1 — `mcp-server/index.js` is one file doing five jobs (1,606 lines)

The seams are already drawn as comment banners; nobody has cut along them.

| Lines | Job | Extract to |
|-------|-----|-----------|
| 76–508 | Port election, WS bridge, network-state store, version handshake | `mcp-server/bridge.js` |
| 610–1048 | 23 tool schemas (438 lines of literal) | `mcp-server/tools.js` |
| 1050–1174 | CSV/JSONL writer, path confinement, summaries | `mcp-server/output.js` |
| 1084–1108 | Site-memory hostname resolution | `mcp-server/memory.js` |
| 1176–1323 | The pagination loop | `mcp-server/extract-all.js` |
| rest | Tool dispatch + MCP wiring | `index.js` |

**Why it matters:** `handleToolCall` (1325–1530) is now a 200-line if-ladder where five special
cases (`get_network_state`, `smart_scroll`, `set_intercept_patterns`, site memory ×2,
`extract_all`) sit above the generic path. Every new tool tempts a sixth `if`. Cutting at the
existing banners is a mechanical move — no new abstractions, ~45 min, and it makes the
if-ladder visibly the only thing left.

**Lazy version if you do nothing else:** pull out `tools.js` alone. It is 27% of the file, has
zero dependencies on anything else in it, and is the part people edit most.

---

### G2 — the action name is the contract, and it is spelled in four places with no shared table

Adding one tool today means touching three files in two runtimes:

```
index.js BROWSER_TOOLS[]        name: "browser_scrape"
index.js handleToolCall         name.replace("browser_", "")   → "scrape"
background.js handleCommand     case "scrape":                  → forwardToContentScript
content_script.js handlers{}    scrape,
```

Nothing checks that these four agree. A typo in the `switch` surfaces as
`Unknown action: scrap` at runtime, on the user's machine, mid-scrape.

**Lazy fix, no build step:** background.js already routes 8 actions to one identical
`forwardToContentScript` call. Replace the `switch` with a lookup object and derive the
content-script action set from `Object.keys(handlers)` shipped back on `extension_ready`. Then
add **one** assertion to test group A: every `browser_*` in `BROWSER_TOOLS` has a route in
`handleCommand`. That single test is ~15 lines and closes the whole class.

---

### G3 — no shared constants; the same numbers live in 2–4 places

| Value | Lives in |
|-------|----------|
| port `7822` | index.js:80, background.js:9, doctor.js:33, README, setup.js |
| 35 000 ms command timeout | index.js:355, 545, 594 (three copies) |
| 3 000 ms element wait | content_script.js:9 |
| 30 000 ms nav timeout | background.js:701 |
| 10 000 ms frame timeout | background.js:830 |
| 500-request cap / 1 MB body / 5-min TTL | index.js:170, 411, 425 |
| 5 secondary-node limit | index.js:274 |

The MCP server's 35s timeout is *shorter* than background.js's 30s nav wait plus its 500ms
settle plus content-script retries — the layers can race, and nothing in the code says they
were chosen together. A `mcp-server/config.js` (and a mirrored `constants` block at the top of
background.js, since the two runtimes cannot share a module without a build step) makes the
relationship reviewable. **Name the budget once, comment which timeout must stay under which.**

---

### G4 — three near-identical `pendingCommands` blocks

index.js:355–375 (proxy path), 545–580 (secondary), 594–609 (primary) each build the same
`{id, timer, resolve, reject}` triple with the same 35 000 and the same cleanup. One
`function pend(id, onTimeout)` collapses all three. ~40 lines deleted, and the
timeout value stops being three independent facts.

Likewise `get_network_state` tab-resolution + clear + envelope is written twice — index.js:305–330
(primary serving a secondary) and index.js:1337–1360 (primary serving itself). Same logic,
two copies, and only one of them honours `output_file`… which the comment at 1362 says must be
honoured in both roles. It is honoured after the fact, but the duplication is what makes that
comment necessary.

---

### G5 — schema fragments copy-pasted 15–16×

`tabId: { type: "number" }` appears 15 times, `session: {...}` 16, `output_file` 15 — with
drifting descriptions. Three consts and a spread:

```js
const TARGET = { tabId: {type:"number"}, session: {type:"string", description:"…"} };
const SINK   = { output_file: {type:"string", description:"…"} };
// properties: { url: {...}, ...TARGET, ...SINK }
```

Cuts ~120 lines and makes "which tools accept output_file?" answerable by reading, not grepping.

---

### G6 — the test suite is excellent and structured as one 2,431-line file

The sandbox builders are the reusable asset and they are buried inline:
`contentScriptSandbox` (149), `backgroundSandbox` (288), `shadowSandbox` (896),
`frameSearchSandbox` (1117), `recordSandbox` (1655), plus `startServer`/`fakeExtension`/`rpc`.

Split into `test/harness.js` (the sandboxes + the runner) and `test/group-*.js` (11 files of
assertions). The runner at the bottom becomes a `readdir`. No framework added — the "plain
asserts, real processes" decision in the header stays intact, it just stops being one scroll.

---

## 3. Bugs and rot found while reading

### B1 — `@e` refs are documented but cannot resolve *(real bug)*

`snapshot()` stamps `data-zc-ref="@e5"` on every node (content_script.js:220) and returns
`ref` in every node object. SKILL.md:155 tells the agent: *"Reach for a `@e` ref from the last
snapshot instead."*

`resolveElement()` (content_script.js:57–99) has no branch for it. `@e5` is not valid CSS, not
valid XPath, and matches no text — so it falls through all four strategies and throws
`Element not found: @e5`. Every ref the snapshot emits is dead weight, and the skill actively
steers agents into the failure.

**Fix is one line at the top of `resolveElement`:**
```js
if (/^@e\d+$/.test(selector)) selector = `[data-zc-ref="${selector}"]`;
```
Then either keep the skill line or delete both. Confirmed dead in the current tree.

### B2 — interceptor injects a junk record into network state on every page load

interceptor.js:90–93 posts `ZC_NETWORK_DATA` with `url: "TEST_INIT"` unconditionally. That
travels content script → background → server and lands in `networkState` as a real captured
request. Every `browser_get_network_state` on a freshly-loaded tab returns at least one fake
entry, and it counts toward the 500 cap. Debug leftover — delete the block.

### B3 — the WebSocket bridge has no origin check or auth *(security)*

`setupPrimaryWss` accepts any connection on `ws://localhost:7822`. **A web page the user visits
can open that socket** (browsers permit ws:// to localhost from https:// origins) and send
`{type:"ping"}`. The server treats any nodeId-less socket as the extension: it closes the real
extension's connection (index.js:377–383) and installs the page's socket as `extensionSocket`.

Impact: any visited site can (a) kill browser control, and (b) receive every subsequent command
— including URLs being navigated and selectors being read — and reply with fabricated data the
agent will trust.

**Lazy fix:** `verifyClient` on the WSS rejecting anything whose `Origin` is not
`chrome-extension://…` or absent. Secondary MCP nodes are Node clients and send no Origin;
pages always do. ~6 lines. A shared token in `~/.poltertab/` is the fuller answer if you want
it, but the origin check alone closes the drive-by.

### B4 — dead and machine-specific files

- `zc-browser.sh` (168 lines) targets a **REST bridge on port 7823** that does not exist in
  this repo — it was ZeroClaw's. README:220 still tells users to use it.
- `mcp-server/test-client.js` (38 lines) — excluded from the npm `files` list, referenced by
  nothing.
- `.mcp.json` hardcodes `/Users/apple/Desktop/den/poltertab/mcp-server/index.js` — a path that
  is wrong for every other machine, and wrong for this worktree.
- `ZC_*` / `zc_*` / `data-zc-ref` prefixes are the old brand across 4 files. Renaming
  `zc_sessions` and `zc_intercept_patterns` **breaks existing users' stored state**, so if you
  rename, read both keys for one release. The `ZC_` postMessage types and `data-zc-ref` are
  in-page only and safe to rename today.

### B5 — a cross-process contract carried in an error string

index.js:1510 branches on `result.includes("Cannot interact with this page")`, a string thrown
in background.js:864. Two processes, one English sentence, no test pinning it. Either give the
error a `code` field or add the assertion to group A.

### B6 — `isBlank` (index.js:1111) and `isEmpty` (content_script.js:305) are the same function

Duplicated across the runtime boundary, which is a legitimate constraint — there is no build
step, so they cannot share a module. That's fine; the gap is that nothing notices when they
drift. Group A already asserts source invariants by regex — add one that pins these two.

---

## 4. What NOT to do

- **Don't add TypeScript.** Two runtimes, no build step, and a Chrome extension that ships as
  raw files. The type safety you want here is G2's one-line route assertion.
- **Don't add a test framework.** The current suite catches real regressions with real
  processes. Splitting the file gets you the maintainability without the dependency.
- **Don't introduce a plugin/handler-registry abstraction for tools.** 23 tools in a flat array
  is readable. G2 asks for a *lookup object and one test*, not a registry.
- **Don't restructure the primary/secondary election.** It works, it's commented, leave it.

---

## 5. Suggested order

| # | Item | Effort | Why first |
|---|------|--------|-----------|
| 1 | B3 origin check | 6 lines | Only item with a security impact |
| 2 | B1 `@e` ref, B2 `TEST_INIT` | 2 lines | Documented features that don't work |
| 3 | B4 delete dead files, fix `.mcp.json` | 10 min | Pure subtraction |
| 4 | G5 schema consts, G4 `pend()` helper | 1 h | −160 lines, no behaviour change |
| 5 | G2 route table + the one assertion | 1 h | Closes a whole failure class |
| 6 | G1 split `index.js` at the banners | 2 h | The actual modularity win |
| 7 | G3 `config.js` + timeout-budget comment | 30 min | Makes the racing timeouts reviewable |
| 8 | G6 split the test suite | 2 h | Do it *after* G1, so groups follow modules |

Steps 1–4 are mechanical and independently shippable. Nothing here requires a new dependency,
a build step, or an abstraction that does not already exist in the code.
