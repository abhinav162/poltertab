# Execution tasks — modularity review

> **Status: all eight complete** on `ao/poltertab-1/modularity`, one commit each.
> Suites went 141 → 155 cases (83→97 server, 58 installer), all passing.
> T6 and T7 were **swapped**: the index.js split needed the shared constants
> that config.js introduces, so config landed first.

Derived from `plans/2026-08-31-modularity-review.md`. Ordered by development sequence:
security first, then subtraction, then mechanical refactors, then structural splits.

Verification for every task: `npm test` (runs `mcp-server/test/run.js` + `test/setup.test.js`).
No task is done until the suite passes at the same count or higher.

**Dependency note:** T6 must land before T8 (test groups should follow the modules they test).
T4 and T5 both edit `index.js` and should not be interleaved. T1–T3 are independent of
everything and of each other.

---

## T1 — Reject non-extension WebSocket origins  `[security]`

**File:** `mcp-server/index.js` (`setupPrimaryServer`, ~line 137)

A visited web page can open `ws://localhost:7822`, send `{type:"ping"}`, and be installed as
`extensionSocket` — dropping the real extension and receiving every subsequent command.

- Add `verifyClient` to the `WebSocketServer` options.
- Allow: `Origin` absent (Node secondary nodes send none) or `chrome-extension://…`.
- Reject everything else with 403.
- Log rejections to stderr — a silent reject during a real extension problem is unhelpful.

**Test:** new group A case — a `ws` client connecting with `Origin: https://evil.example`
is refused; one with no Origin connects.

**Acceptance:** existing extension + secondary-node tests still pass; drive-by connection refused.

---

## T2 — Fix `@e` refs and drop the interceptor's `TEST_INIT` record

**Files:** `chrome-extension/content_script.js`, `chrome-extension/interceptor.js`

Two documented-but-broken behaviours, both one-liners.

- `resolveElement`: map `@eN` → `[data-zc-ref="@eN"]` before the CSS attempt.
- `interceptor.js:90–93`: delete the unconditional `TEST_INIT` postMessage.

**Test:** content-script sandbox case — `snapshot()` then `click("@e2")` resolves the node
stamped with that ref. Assert no `TEST_INIT` string remains in the source (group A style).

**Acceptance:** a ref returned by snapshot is usable as a selector; a freshly loaded tab
reports zero captured requests.

---

## T3 — Delete dead files, fix machine-specific config

**Files:** `zc-browser.sh`, `mcp-server/test-client.js`, `.mcp.json`, `README.md`

- Delete `zc-browser.sh` (targets a REST bridge on :7823 that does not exist in this repo).
- Delete `mcp-server/test-client.js` (excluded from `files`, referenced by nothing).
- `.mcp.json`: replace the hardcoded `/Users/apple/Desktop/den/poltertab/...` absolute path.
- README: remove the `zc-browser.sh` section (~line 220) and the ZeroClaw REST note (~line 85).

Leave `zc_sessions` / `zc_intercept_patterns` storage keys alone — renaming breaks existing
users' state. In-page `ZC_*` postMessage types and `data-zc-ref` are safe to rename but are
cosmetic; skip unless T2 touches them anyway.

**Acceptance:** no reference to a deleted file survives; `npm pack` contents unchanged.

---

## T4 — Collapse duplicated schema fragments and the pending-command triple

**File:** `mcp-server/index.js`

Pure subtraction, no behaviour change.

- Hoist `TARGET` (`tabId` + `session`) and `SINK` (`output_file`) consts; spread them into the
  23 tool schemas. Reconciles the drifting descriptions. (~−120 lines)
- Collapse the three `pendingCommands.set(id, {…timer})` blocks (lines ~355, ~545, ~594) into
  one `pend(id, onTimeout)` helper. (~−40 lines)
- De-duplicate `get_network_state` tab-resolution + clear + envelope, written twice
  (~305–330 and ~1337–1360).

**Acceptance:** `tools/list` output is byte-identical except for the reconciled descriptions;
full suite passes.

---

## T5 — Route table + the assertion that pins it

**Files:** `chrome-extension/background.js`, `mcp-server/test/run.js`

The action name is spelled in four places across three files and nothing checks they agree.

- Replace `handleCommand`'s `switch` with a lookup object.
- Add to group A: every `browser_*` name in `BROWSER_TOOLS` has a route in `handleCommand`,
  and every content-script action has a handler in `content_script.js`'s `handlers`.
- Also pin B5 here: the `"Cannot interact with this page"` string is thrown in background.js
  and matched in index.js — assert both spellings agree.

**Acceptance:** deliberately misspelling a route makes the suite fail.

---

## T6 — Split `mcp-server/index.js` along its existing banners

**File:** `mcp-server/index.js` (1,606 → ~400)

Cut at the comment banners already in the file. No new abstractions.

| Extract | To |
|---|---|
| Port election, WS bridge, network-state store, version handshake | `mcp-server/bridge.js` |
| 23 tool schemas | `mcp-server/tools.js` |
| CSV/JSONL writer, path confinement, summaries | `mcp-server/output.js` |
| Site-memory hostname resolution | `mcp-server/memory.js` |
| The pagination loop | `mcp-server/extract-all.js` |

`index.js` keeps tool dispatch + MCP wiring. Check `package.json` `files` still covers the
new modules (`mcp-server/` is already a directory entry — verify).

**Acceptance:** suite passes unchanged; `poltertab` still starts; `npm pack` includes all
new files.

---

## T7 — `config.js` and a stated timeout budget

**Files:** `mcp-server/config.js` (new), `chrome-extension/background.js`, `content_script.js`

Port 7822 lives in 5 places, the 35s command timeout in 3. Worse, the server's 35s timeout is
shorter than the extension's 30s nav wait + 500ms settle + content-script retries — the layers
can race, and nothing records that they were chosen together.

- `mcp-server/config.js` for the Node side.
- Mirrored `const` block at the top of `background.js` (the two runtimes cannot share a module
  without a build step — say so in a comment).
- **Comment the budget:** which timeout must stay under which, and why.

**Acceptance:** no bare timeout literal outside the config blocks; budget comment present.

---

## T8 — Split the regression suite  `[after T6]`

**File:** `mcp-server/test/run.js` (2,431 lines → runner + 11 groups)

The sandbox builders are the reusable asset and they are buried inline.

- `test/harness.js` — `contentScriptSandbox`, `backgroundSandbox`, `shadowSandbox`,
  `frameSearchSandbox`, `recordSandbox`, `startServer`, `fakeExtension`, `rpc`, `test`, `waitFor`.
- `test/group-*.js` — one file per group, mirroring the modules T6 created.
- Runner becomes a `readdir`.

Keep the header's "plain asserts, real processes, no framework" decision intact.

**Acceptance:** same test count, same pass count, no new dependency.

---

## Out of scope (decided in the review)

TypeScript · a test framework · a tool plugin/registry abstraction · restructuring the
primary/secondary election.
