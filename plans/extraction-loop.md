# Plan: record-scoped extraction + the loop

Revalidation of the agent report from the kw.com/agents run, and the build order
I'd actually ship. Every claim below was checked against source.

## Revalidation

### Confirmed, with file evidence

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Flat scrapes lose field↔record grouping | **Confirmed** | `content_script.js:277` — `scrape()` returns `elements.map(...)`, a flat array. No record concept exists. Field grouping is reconstructed by the model from document order. |
| 4 | Silent false negatives on scoped selectors | **Confirmed** | Same code path: a scoped selector that matches 12 of 12 records but the wrong subtree returns 12 plausible rows. Nothing reports scope coverage. |
| 9 | Verbose envelopes | **Confirmed, worse than reported** | `content_script.js:285-291` returns `attributes: Object.fromEntries(el.attributes)` — *every* attribute of every element, so full `class`/`data-*`/`aria-*` dumps, not just JSON punctuation. |
| 9 | No `output_file` on read tools | **Confirmed, partially built** | `index.js:776` + `:953` — a working, path-traversal-safe implementation exists, wired to `browser_get_network_state` **only**. |
| 9 | Silent 500-char text truncation | **Confirmed** | `content_script.js:283` — `.textContent.trim().slice(0, 500)`, no flag in the response. |
| 9 | `attribute` returns nulls | **Confirmed** | `content_script.js:282` — `el.getAttribute(attribute)`. `attribute:"textContent"` is not an attribute → `null`. Already recorded in kw.com site memory. |
| 10 | Intercept patterns can't be set before first load | **Confirmed** | `browser_set_intercept_patterns` requires a tab (`index.js:786`); `browser_session_create` (`index.js:820`) accepts `name` + `url`, no `patterns`. |
| 10 | Analytics noise dominates the capture buffer | **Confirmed, root cause differs** | `interceptor.js:5` defaults to `["graphql","/api/","voyager","feed"]`. `/api/` is what matched GA and Maps. It's the default pattern that's noisy, not a missing exclude list. |
| 11 | Timeout reported on a page that loaded fine | **Confirmed, root cause found** | `background.js:702-719` — `waitForTabLoad` polls `tabLoadEpoch.get(tabId) >= since`. If the load event fired before `since` was stamped (or on SPA soft-nav, where it never fires), it spins the full 30s and **throws**, while `chrome.tabs.get` would show the page loaded. |
| 8 | Extra tabs never gave real concurrency | **Confirmed** | MCP tool calls are sequential per turn. Tabs were parallel; the driver wasn't. |

### Corrections

- **#12 "site memory is prose" — the store is already structured.**
  `~/.poltertab/navigation_memory/kw.com.json` is `[{obstacle, solution, timestamp}]`.
  Only the *payload* is prose. This is an added field on an existing store, not a
  new subsystem.
- **#8 "expose title/meta/JSON-LD as free fields" — title and meta already exist.**
  `content_script.js:298-305` returns `title` and every `meta[name]`/`meta[property]`,
  so `og:*` is already there. It's unreachable in practice because the same call
  also returns 200 links and 50KB of `bodyText`. **JSON-LD is genuinely absent** —
  nothing reads `script[type="application/ld+json"]`. So: make the existing fields
  selectable, and add JSON-LD.
- **#8 kw.com needed no enrichment fields at all.** The location was in `<title>`,
  which `navigate` already returns. The N+1 was 100 sequential *round-trips*, not
  100 missing selectors — so the fan-out loop is the fix, and the field spec is
  a no-op for this site.
- **#11 "retry with backoff" is the wrong fix for the timeout.** Retrying a 30s
  hard timeout makes the bad case 90s. Check real tab state at the deadline instead.

### Missed by the report

- **`browser_navigate` hijacks the user's active tab.** `background.js:647-654`:
  with no session, it resolves the active tab and `chrome.tabs.update`s it. On a
  live personal browser that navigates the user away from whatever they had open.
  The kw.com site memory documents the workaround instead of the bug. Higher
  severity than most of the report.

## Where I disagree on scope

The report proposes seven subsystems: wrapper induction, a five-driver pagination
taxonomy, a tab pool with per-tab crash recovery, and a recipe engine. That's a
scraping framework. Three of them earn their keep; the rest are speculative.

**Cut: #6 wrapper induction (auto-discovery).**
It competes with the model at the one thing the model is already good at — reading
one snapshot and writing selectors. That was never the expensive part; the report's
own numbers put the cost in the per-page loop and the transcription. Fingerprinting
plus type-label heuristics is the largest, least verifiable component in the whole
proposal, and it exists to save round-trips that phases 1 and 3 below already save.
Revisit only if selector-writing turns out to be the bottleneck after 1–3 ship.
It won't be.

**Cut: 4 of 5 pagination drivers.**
`url_param` covers kw.com and most directory sites. `cursor`, `infinite_scroll`,
`load_more`, `virtualized` are detectors for sites we haven't hit. Add each one
when a site demands it. **Keep the identical-page check** — that's the silent-
wrong-data trap again, and it's a key-set hash comparison, three lines.

**Cut: the tab pool as a new component.**
`sessionManager` (`background.js:100-180`) already creates, tracks, groups, and
persists tabs. Round-robin over N named sessions inside one tool call. Per-tab
crash recovery = the existing "Tab was closed during navigation" path plus a
skip-and-report.

**Reorder: `output_file` goes first, not second.** The plumbing already exists and
works; hoisting it to a shared helper is the cheapest item on the list and the
report's own accounting says it was ~35k tokens on a task this size.

## Build order

### Phase 1 — `output_file` + field selection on every read tool
Hoist `index.js:953-974` into one helper; call it from `scrape`, `snapshot`,
`get_text`, `get_network_state`. Inline return becomes
`{rows, fields, file, sample: 2}`.

Add to `scrape`: `fields: ["title","meta","jsonld"]` to reach the cheap structured
data without the 50KB body, and `max_text` (default 500) that **reports when it
truncates**. Add `script[type="application/ld+json"]` parsing — the one genuinely
missing free field.

Pure token win, no design risk.

### Phase 2 — `browser_extract`: record-scoped, null-safe
```
browser_extract({
  record: ".agent-card",
  fields: { name: {sel: "a.agent-card-name", get: "text"},
            phone: {sel: "a[href^='tel:']", get: "href", strip: "tel:"},
            socials: {sel: "a.agent-card-social-button", get: "href", many: true} },
  anchor: "name",        // field that must be present
  output_file: "kw.jsonl"
})
```
Two semantics, non-negotiable, because violating either produces confidently wrong
data: **fields resolve relative to the record root**, and **a missing field is
`null`, never a shift**. Reuse `deepQuery` so shadow-DOM piercing carries over.

`get: "text"` and `get: "href"` fix the `attribute:"textContent"` → nulls trap.

Returns fill rates — they fall out of the extraction loop for free, no separate
feature:
```
{ rows: 12, fill_rates: {name: 12, phone: 10, socials: 0},
  dropped: 0, warnings: ["socials: 0/12 in record scope, 40 matches page-wide
                         — record boundary likely too narrow"] }
```
The loosening probe is one extra page-wide `querySelectorAll` per zero-fill field.
This is the phase that closes the correctness risk; it ships with tests in
`mcp-server/test/run.js`.

### Phase 3 — the loop
`browser_extract_all({url_template, limit, offset, key, ...phase-2 spec})`.
Stream-level `limit`/`offset` so page arithmetic stops being hand-done. Dedup on
`key` (the detail URL). Halt on: limit reached, empty page, **repeated key-set**,
or `max_pages`. Compare each page's fill rates to page 1 and halt on deviation past
a threshold rather than emitting 40%-empty rows. Report which condition fired, and
`log` anything dropped — silent truncation reads as full coverage.

Learn the spec on two non-adjacent pages, union the variants. Page 1 having
`MARKET CENTER` and page 10 having phantom cards is the exact failure this
prevents.

### Phase 4 — two bug fixes, independent of the above
- `waitForTabLoad`: at the deadline, `chrome.tabs.get` + `readyState`; return
  `{status:"timeout"|"ok", url, title, readyState}` instead of throwing when the
  page is in fact loaded. Root-cause fix at the one function all navigation routes
  through.
- `navigate` with no session: create a tab instead of hijacking the active one.
  Grep every caller first — `sessionManager.resolveOrFallback` is shared.
- Content-script injection race (`Could not establish connection`): retry once
  inside `forwardToContentScript`, not at the caller.

### Deferred, in order, when a site demands it
Enrich fan-out over round-robined sessions (phase 3 makes it a config field, not
new machinery) → `patterns` on `session_create` + a default noise-host exclude →
SSR detection ("no XHR matched; N KB of records in initial HTML") → `recipe` field
on the existing navigation-memory store, keyed by host + DOM fingerprint →
wrapper induction, if ever.

## The principle worth keeping

The report's closing line is the right one and survives all the cuts: the model
supplies intent and receives results; it is never the loop and never the
transcriber. Phases 1–3 are exactly that, and nothing else on the list is needed
to get there. And where the tool can't be sure, it halts and names the ambiguity —
a confident wrong dataset costs more than a paused one.
