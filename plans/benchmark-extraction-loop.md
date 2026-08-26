# Benchmark: does the extraction loop actually pay off?

Six tasks against the live site that produced the original complaint. Four
measure cost, two measure correctness. Run the correctness ones even if the
cost numbers look good — the failure this branch exists to fix was *silent*,
and a fast wrong dataset is the outcome to rule out.

## Prerequisites

1. **Reload the extension** — `chrome://extensions` → PolterTab → reload.
   Without this, `browser_extract` reaches a content script that has never
   heard of it.
2. **Restart the MCP client** so the server respawns from the repo.
3. Confirm you are on `feat/extraction-loop`.

### Why there is no second install

Nothing here needs the old version side by side. `browser_scrape` was left
untouched — same parameters, same return shape, and `max_text` defaults to the
500 characters that used to be hardcoded. So the new server produces **both**
arms of the comparison: the baseline is `scrape` used the old way, which is the
thing actually being measured against record-scoped extraction.

Two extensions at once is technically possible — separate extension IDs, and the
WS port is per-extension in the options page — but both content scripts inject
into every page and both interceptors patch `window.fetch` in the MAIN world, so
it is not worth the confusion. A prerelease (`1.4.0-beta.1` publishes to the npm
`beta` tag) would give you a second *server*, but the server is not the part that
would need doubling: the extension is, and that is the half you can only sanely
run one of. So a prerelease does not buy the A/B either.

Two things consequently cannot be isolated by T1/T2, since only one version of
the code exists in the browser: the `attribute: "textContent"` → nulls trap, and
the two navigation fixes. Tests I6 and C3/C5/C6 cover them, and T6 below checks
the tab behaviour by hand.

Because there is now one server and no Primary/Secondary proxying, **wall clock
is a valid metric** alongside tool calls and returned bytes.

## T1 — cost per page, head to head

Same 24 records (pages 1–2 of `https://www.kw.com/agents`), both ways, same
server. Two pages is enough: per-page cost is linear, so this extrapolates.

**Baseline** — reproduce what the original run had to do, which is recorded
verbatim: call `browser_get_site_memory` for `kw.com` and follow the selectors
in it. Two flat `browser_scrape` calls per page with `attribute: "href"` and
`multiple: true`, no `output_file`, then reconstruct records from document order
by reasoning about which `/agent/` href each `tel:`/`mailto:` follows.

Run this arm first, before reading T3, so the reassembly is done the way the
original run did it rather than with the answer in hand.

**New** — one `browser_extract` per page:

```json
{
  "record": ".agent-card",
  "fields": {
    "name":    { "sel": "a.agent-card-name", "get": "text" },
    "url":     { "sel": "a.agent-card-name", "get": "href" },
    "phone":   { "sel": "a[href^='tel:']",   "get": "href", "strip": "tel:" },
    "email":   { "sel": "a[href^='mailto:']","get": "href", "strip": "mailto:" },
    "socials": { "sel": "a.agent-card-social-button", "get": "href", "many": true }
  },
  "anchor": "url"
}
```

Record for each: **tool calls**, **bytes returned into context**, records
recovered, and whether records had to be reassembled by hand.

Target: baseline ~2–3 calls/page (plus reassembly reasoning), new 1 call/page
with records already grouped. If the new path needs more than one call per page
to get all five fields, that is a finding — write down which field forced the
extra call.

## T2 — the loop, 100 records

One call:

```json
{
  "url_template": "https://www.kw.com/agents?page={page}",
  "record": ".agent-card", "fields": { ...as above... },
  "anchor": "url", "key": "url", "limit": 100,
  "output_file": "kw_agents.csv"
}
```

Record: total tool calls (**expect 1**), wall clock, inline response bytes,
`pages_fetched`, `stopped_because`, `dropped`, `fill_rates`, and the CSV's row
count.

Then extrapolate T1's baseline to 100 records and compare. The claim under test
is the report's own arithmetic: ~1.5k tokens per 12 records of list data, plus
~20k tokens of hand-transcription, both going to roughly zero.

**Check the CSV opens correctly in a spreadsheet.** Any agent whose name
contains a comma or quote is the case that matters.

**Scope note, so this is not read as a bigger win than it is:** `location`
lives only on profile pages, and detail-page enrichment was deliberately *not*
built — that is still ~1 navigation per record, unchanged. T2 measures list
extraction only. If you want the full original job benchmarked, expect ~100
navigations on top of the 1 call, same as before. The cheap partial fix is that
`browser_navigate` already returns `title`, and on kw.com the title contains the
location — so no scrape per profile is needed, just the navigation.

## T3 — correctness audit (do not skip)

The bug that motivated all of this produced *plausible* data. From T2's CSV:

1. Find rows where `phone` is empty. There should be some — page 1 of the real
   site has them.
2. For one such row, open that agent's profile page and confirm they genuinely
   have no phone listed.
3. **Then check the row immediately after it.** Open that agent's profile and
   confirm the phone in the CSV is theirs. This is the exact assertion the old
   flat scrape failed: one missing value shifted every later phone up a row.
4. Repeat for `email` and for one agent with `socials`.

A pass here is worth more than every number above. A fail invalidates them.

## T4 — the duplicate-page trap

Point the loop at a param the site ignores — `?p={page}` instead of `?page={page}`:

```json
{ "url_template": "https://www.kw.com/agents?p={page}", "...": "same spec", "limit": 100 }
```

Expect `stopped_because: "duplicate_page"`, ~12 rows, 2 pages fetched, and a
warning saying pagination is not advancing. A run that returns 100 rows here is
returning the same 12 records eight times and is the failure mode this halt
exists for.

## T5 — the false-negative probe

Use the wrong-but-plausible record boundary that fooled the original run —
`.agent-card-info`, which excludes the sibling holding the socials:

```json
{ "record": ".agent-card-info",
  "fields": { "name": {"sel": "a.agent-card-name", "get": "text"},
              "socials": {"sel": "a.agent-card-social-button", "get": "href", "many": true} } }
```

Expect `fill_rates.socials: 0` **and** a warning naming the page-wide match
count and saying the boundary is likely too narrow. Silence here means the tool
would still let you report "these agents have no social accounts".

## T6 — does it still steal your tab?

Open a tab, put something in it you would not want to lose, make it the active
tab. Then call `browser_navigate` with no `session` and no `tabId`.

Expect: a new tab opens, yours is untouched. Then navigate again — expect it to
reuse the tab it made rather than opening a second one.

## Results table

| Task | Metric | Baseline | New | Verdict |
|---|---|---|---|---|
| T1 | calls / 24 records | | | |
| T1 | bytes into context | | | |
| T1 | manual reassembly needed | | | |
| T2 | calls / 100 records | | | |
| T2 | wall clock | | | |
| T2 | inline bytes | | | |
| T3 | field↔record alignment | | | pass/fail |
| T4 | duplicate page halted | | | pass/fail |
| T5 | empty field explained | | | pass/fail |
| T6 | active tab preserved | | | pass/fail |

## What would falsify the work

Worth writing down before running, so the numbers are not read generously
after the fact:

- T3 fails → the primitive does not deliver its one guarantee. Everything else
  is irrelevant.
- T2 needs more than 2–3 calls → the loop is not actually taking the model out
  of the loop.
- T1's new path needs a call per field → record scoping is not covering real
  field shapes.
- T4 or T5 silent → the halt conditions and the probe are decoration.
- T2 saves less than ~10× on bytes for the list phase → `output_file` and the
  compact summary are not earning their complexity.
