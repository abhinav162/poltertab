# Benchmark run log

## Attempt 1 — 2026-08-26: blocked before T1

`browser_navigate` and `browser_get_url` both failed with
`Secondary node not connected to Primary MCP server.` (`mcp-server/index.js:530`).

### Cause

Role is decided by who wins the WS port (EADDRINUSE at `index.js:128` → `isSecondary = true`
at `:197`). Five poltertab server pairs were running. The process holding port 7822 —
and therefore the extension connection, and therefore the Primary role — was
**the global npm install, stable 1.3.0** (PID 98684), not the dev repo.

The dev repo server (`Desktop/den/poltertab/mcp-server/index.js`) came up as a Secondary
and proxies every page command to that stable Primary.

Confirmed skew: `grep -c browser_extract` → dev repo 4, global 1.3.0 **0**.

So `browser_extract` is advertised by the tool list (dev server builds the schema) but
would be executed by a Primary that has never heard of the action. Extension reload is
irrelevant here — the extension is talking to the right port, just to the wrong build.

### Fix

Kill all poltertab processes, then restart the MCP client so exactly one dev server
spawns and wins the port:

```sh
pkill -f 'poltertab/mcp-server/index.js'; pkill -f 'bin/poltertab'
```

Then verify before running anything: `lsof -nP -iTCP:7822 -sTCP:LISTEN` must show a
process whose path is the **dev repo**, not `node_modules/poltertab`.

## Two plan assumptions now known false

1. **"There is now one server and no Primary/Secondary proxying, so wall clock is a
   valid metric"** (plan lines 37–38). There were five servers and mine was a Secondary.
   T2's wall clock is only meaningful once the dev server is the sole Primary — otherwise
   every number includes a proxy hop.

2. **T6 cannot run on a Secondary at all.** `sendCommand` auto-injects
   `params.session = "agent_" + nodeId` when no session is passed (`index.js:536-538`).
   T6's whole premise is `browser_navigate` with no `session` and no `tabId`. On a
   Secondary that state is unreachable, so T6 must be run against a Primary dev server.

## Bug found en route (independent of the above)

`browser_get_site_memory({hostname: "www.kw.com"})` → `[]`, while
`~/.poltertab/navigation_memory/kw.com.json` exists and holds the kw.com notes.
No `www.` normalization on lookup.

This matters for the benchmark specifically: T1's baseline arm step 1 is "call
`browser_get_site_memory` for `kw.com` and follow the selectors in it". The page's actual
hostname is `www.kw.com`, so the documented baseline procedure silently returns nothing.
Same class of silent-empty failure this branch exists to fix.

## Plan premises the recorded memory confirms

From `kw.com.json` (written 2026-08-24), so T4 and T5 are testing real history, not
invented failure modes:

- 12 agents/page, and `?size` / `?limit` / `?pageSize` are ignored → T4's `?p={page}`
  duplicate-page trap is well founded.
- "Card container class is `agent-card-info`" — the exact boundary T5 uses as the
  wrong-but-plausible one. The old memory *recommends* it, which is why the original run
  lost the socials.
- Baseline shape matches T1: two `multiple: true` href scrapes per page, records
  reassembled from document order.

---

# Attempt 2 — 2026-08-26: T1–T5 run, T6 inconclusive

Primary confirmed as the dev repo (PID 64005, sole server) before starting.
Baseline arm was run first, before any `extract` call, so the reassembly was done
without the answer in hand.

## Results

| Task | Metric | Baseline | New | Verdict |
|---|---|---|---|---|
| T1 | calls / 24 records | 5 (1 site_memory + 2 scrapes x 2 pages) | 2 (1 extract x 2 pages) | new 2.5x fewer |
| T1 | bytes into context | ~6.0 KB | ~7.0 KB inline | **baseline slightly cheaper** |
| T1 | manual reassembly needed | yes, delimiter reasoning per page | none | new |
| T2 | calls / 100 records | 18 (extrapolated, 9 pages x 2) | **1** | 18x fewer |
| T2 | wall clock | not measured | ~78 s / 9 pages (8.7 s/page) | — |
| T2 | inline bytes | ~27 KB (extrapolated) | ~1.5 KB (21.7 KB to disk) | **~18x** |
| T3 | field/record alignment | correct (see note) | 12/12 both pages, 100/100 at scale | **pass** |
| T4 | duplicate page halted | n/a | `duplicate_page`, 12 rows, 2 pages, warned | **pass** |
| T5 | empty field explained | n/a | `socials: 0` + page-wide count named | **pass** |
| T6 | active tab preserved | n/a | tracked tab WAS reused | **inconclusive** |

## T3 — pass, by a stronger method than the plan specified

Rather than spot-checking profile pages, the page-1 `extract` was diffed field-by-field
against the independently reassembled baseline: **12/12 rows agree on all five fields**.
Page 2 likewise 12/12. Across the full 100-row CSV: 17 empty-phone rows, every successor
holding its own phone, 100/100 unique urls.

Page 1 is a *harder* case than the plan anticipated — **two consecutive** nulls
(Danielle Young, Rachel Hsieh), after which Michael McCarty still holds
`+1 682 302 1750`. A naive per-field scrape would have shifted every later phone up by two.

## The baseline is not broken — which sharpens what this branch actually buys

Worth stating plainly: the baseline as recorded in site memory produces **correct**
records. Using the `/agent/` anchor as a record delimiter in one interleaved
`multiple: true` scrape, the document-order reassembly works.

The silent misalignment this branch exists to fix is what happens with the *naive*
approach — scraping each field in its own call, then zipping the lists. That yields 10
phones for 12 agents with no way to know which two are missing.

So the win is **not** "baseline returns wrong data". It is: 18x fewer calls, ~18x fewer
bytes, and the correctness guarantee no longer depends on the model correctly performing
delimiter reasoning on every page.

## CSV quoting — verified, not assumed

`toCsv` (`mcp-server/index.js:1058`) quotes on `/[",\r\n]/` and doubles embedded quotes.
No agent in the 100-row sample had a comma in their name, so it was checked directly:
a row with `Smith, John "JJ"` and an embedded newline round-trips through Python's `csv`
intact. `many` arrays are joined with `" | "`, so array fields never introduce commas.

## T6 — could not be tested faithfully

`browser_navigate` with no `session` and no `tabId` **reused** the tracked `precious` tab
(1802857064), navigating it off `example.com/DO-NOT-LOSE-THIS`.

This is *documented* behaviour, not the bug: "omit both and PolterTab uses the last tab it
navigated, falling back to the active tab". The tab was PolterTab-tracked and
last-navigated, so reuse is correct. T6's real subject is an **untracked** tab the user
opened manually, and no PolterTab tool can create one — anything it opens becomes tracked.

**To finish T6:** open a tab by hand, put something in it, make it active, then ask for a
no-session `browser_navigate`.

## Bugs found

1. **Content script never attaches on `kw.com/agent/*` profile pages.** `browser_scrape`
   fails with `Could not establish connection. Receiving end does not exist.` on 4
   attempts across 2 fresh navigations, while `browser_get_title` (tabs API, no content
   script) works. Manifest matches `<all_urls>` at `document_start`, and list pages on the
   same host inject fine. The auto-retry on connection errors does not recover it.
   *Consequence:* detail-page enrichment is currently impossible by scrape. The plan's
   "navigate already returns `title`, which contains the location" workaround is therefore
   load-bearing, not merely an optimisation — and it does work
   ("Danielle Young | Real Estate Agent Cleveland, OH | Keller Williams").

2. **`browser_get_site_memory` does not normalise `www.`** — `{hostname: "www.kw.com"}`
   returns `[]` while `~/.poltertab/navigation_memory/kw.com.json` exists. T1's documented
   baseline step 1 silently returns nothing for the page's own hostname.

3. **`output_file` ignores an absolute path**, relocating to
   `~/.poltertab/downloads/<name>_<timestamp>.<ext>`. Fine as sandboxing, but undocumented
   in the tool description, and the returned `file` is the only way to find the output.

4. **`fill_rates` units differ between the two tools** — `browser_extract` returns counts
   (`phone: 10`), `browser_extract_all` returns fractions (`phone: 0.833`). Same field
   name, different meaning.

## Against the plan's falsification list

- T3 fails → **did not happen.** Strongest result of the run.
- T2 needs more than 2-3 calls → **1 call.**
- T1 new path needs a call per field → **no**, all five fields in one call.
- T4 or T5 silent → **both fired**, with specific diagnostics.
- T2 saves less than ~10x bytes → **~18x.** Clears the bar.

The one metric that does *not* favour the new path: **single-page inline bytes** (T1),
where verbose per-record JSON costs slightly more than raw href lists. The byte win is
entirely `output_file`'s, and only shows up at multi-page scale.

---

# Second run — 2026-08-26, after the fixes

Re-run on `feat/extraction-loop` at `de5e4f3`, extension reloaded, against
`chrome-browser-control` (the repo server). T6 ran first, before any other
navigation, which the first run could not do.

## Server topology mattered

Two servers were live: PID 64005 (14:14, pre-fix) holding port 7822 as
**Primary**, and PID 20574 (17:03, current tree) as **Secondary** proxying
through it. That matters for T6 specifically — `sendCommand` injects
`params.session = "agent_<nodeId>"` into every Secondary call, so "sessionless
navigate" can never be truly sessionless. It is the most likely reason the
first run's T6 came back inconclusive. T6 was still reachable here because the
injected session did not exist yet, so `resolve()` returned null on the first
navigate and took the create-a-tab branch under test.

## Results

| Task | Result | Verdict |
|---|---|---|
| T6 active tab preserved | active tab `…117` still `chrome://newtab/`; navigate opened `…123` | **pass** |
| T6 tab reuse | second sessionless navigate returned `…123` | **pass** |
| T5 empty-field probe | `socials: 0/12 in record scope, but 31 matches page-wide … boundary likely too narrow` | **pass** |
| T1 new arm | 1 call, 12 records, all 5 fields, `warnings: []` | **pass** |
| T4 duplicate halt | `duplicate_page` after 2 pages, 12 rows not 100 | **pass** |
| T2 loop | **1 call**, 100 records, 9 pages, 21.7 KB to CSV, ~1 KB inline | **pass** |
| T3 alignment | see below | **pass** |

`fill_rates` came back as counts and `baseline_fill_ratios` as fractions,
confirming that fix live. `output_file` returned a summary, not the payload.

## T3 verified mechanically, not by eyeball

Parsed the 100-row CSV rather than spot-checking:

- 100 rows, 5 columns, 0 missing anchor, **100/100 unique URLs**
- **0 phones shared by more than one agent** across 83 phones — a zip-shift
  necessarily duplicates values, so its absence is the decisive signal
- 17 empty-phone rows, including **three consecutive-null runs** (indexes 4,
  25, 95); every successor keeps its own distinct phone
- 78/89 rows with contact data carry an own-name token in their email or
  socials. All 11 that do not were inspected: team-branded emails
  (`mike@adamflinchbaugh.com`, `jan@sueadler.com`), three empty emails, and two
  false negatives of the heuristic's own ≥4-char cutoff (Tim **Scott** at
  `realestatetim@`, David B. **Ahn** at `esendiahn@`). None indicate
  misalignment.

## Bug 1 was a misdiagnosis — and the cause was ours

The first run's "content script never attaches on kw.com profile pages" does
not hold. On a profile page, both a selector-less `browser_scrape` and
`browser_scrape` with `div.location` returned data. `browser_extract` with a
record that exists (`div.location`) also worked. Only `browser_extract` with a
record that matches nothing (`div.profile-contact`) produced *Could not
establish connection. Receiving end does not exist.* — reproducibly.

Chain: frame 0 answers `records_found: 0` (a success, but `isElementMiss` flags
it so the search advances) → child iframes on the profile page have no content
script and answer "Receiving end does not exist", setting `lastError` → the
waited retry on frame 0 again returns 0 records → `throw new Error(lastError)`
throws an unrelated iframe's connection error as the result.

So the payload this branch exists to produce — "no records here, and here is
the page-wide probe explaining why" — was replaced by a message that reads as a
broken content script. Fixed in `de5e4f3`; covered by G9/G10, which needed a
frame with no content script to reproduce. The unit test for zero records talks
to the content script directly and structurally cannot see this.

## The deferred enrichment problem is smaller than assumed

Profile pages ship a schema.org `ProfilePage` blob containing
`address.addressLocality` / `addressRegion`, plus `telephone`, `email`,
`jobTitle`, `worksFor` and every social in `sameAs`. `browser_scrape` with
`fields: ["jsonld"]` returns it in one call.

So `location` — the field that motivated the whole N+1 detail-page discussion —
needs neither `div.location` nor title-parsing. Enrichment is still one
navigation per record, but each navigation now yields a complete typed record
with no per-site selector discovery. That raises the value of building the
`enrich` fan-out and lowers its cost.
