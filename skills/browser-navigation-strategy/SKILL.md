---
name: browser-navigation-strategy
description: Use when driving a real browser with PolterTab's browser_* tools — extracting repeating records, paginating a listing, navigating, scraping, or clicking through a site whose DOM is virtualized, obfuscated, shadow-rooted, or iframe-sandboxed, and selectors keep going stale.
---

# Browser Navigation Strategy

PolterTab drives the user's real Chrome profile. Sessions are already logged in,
and every action happens in a window the user can see. That makes it powerful and
unforgiving: a wrong click lands on a real account.

## Pick the right tool before you start

| What you want | Use |
| --- | --- |
| Many similar records on a page (cards, rows, listings) | `browser_extract` |
| Those records across many pages | `browser_extract_all` |
| One element's text | `browser_get_text` |
| Page title, og: tags, schema.org data | `browser_scrape` with `fields` |
| To find out what a page contains | `browser_snapshot` |
| Data the DOM does not hold (virtualized/obfuscated) | intercept + `browser_get_network_state` |

Getting this wrong is the most expensive mistake available. Scraping 100 records
one field at a time costs a round-trip per page and leaves you reassembling
records by hand; `browser_extract_all` is one call.

## Repeating records: use browser_extract

A flat scrape returns a list per selector, so you have to work out which value
belongs to which record. That works until a field is optional — then one missing
value shifts every later record and the result looks completely plausible.

`browser_extract` takes a container and resolves each field *inside* it:

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

- A missing field is `null`. It never shifts.
- `sel` is relative to the record; omit it (or `"."`) for the record itself.
- `get`: `text` (default), `href`, `src`, or any attribute name. `href`/`src`
  come back absolute.
- `anchor` names the field every real record has. Records without it — the
  placeholder cards padding a last page — are dropped and counted.

**Read the response before trusting it.** `fill_rates` and `warnings` tell you
whether the spec is right:

```
fill_rates: { name: 12, phone: 10, socials: 0 }
warnings: ["socials: 0/12 within record scope, but 40 matches page-wide
            for a.social-button — record boundary likely too narrow"]
```

That warning means the container you picked excludes a sibling holding the
field. Widen `record` and re-run. Without it, an empty column reads as "these
records have no socials" — confidently wrong.

A field at 0 with *no* page-wide matches means the selector is wrong, not the
boundary. The message distinguishes the two; act on which one you got.

## Paginating: use browser_extract_all

Same spec plus a `url_template` containing `{page}`. It runs the loop itself, so
pages cost a browser round-trip instead of a model round-trip.

Dedup on `key` — a stable per-record id, the detail URL or an element `id`, never
position. It halts on the first of `limit_reached`, `empty_page`,
`duplicate_page`, `fill_rate_deviation`, or `max_pages`, and always says which.

Two of those are worth understanding:

- **`duplicate_page`** — the page returned records already seen. This is what a
  site does with a param it does not recognise: it serves page 1 again. Without
  the check you would collect the same 12 records eight times.
- **`fill_rate_deviation`** — a field well-populated on page 1 collapsed on a
  later page, so the learned spec no longer fits. Everything collected so far is
  returned; re-run from `start_page` with a spec covering both layouts. Set
  `fill_tolerance: 0` if a site is legitimately heterogeneous.

## Take the free structured data first

Before writing any selector, try:

```json
{ "fields": ["meta", "jsonld"] }
```

on `browser_scrape`. `title`, every `og:`/`twitter:` tag, and any schema.org
`ld+json` blob come back with no selectors at all. Real estate, jobs, products,
events and profile pages very often ship a complete typed record this way —
name, telephone, email, postal address, employer — which beats any selector you
could write and does not break on redesign.

This is the cheapest call available on a detail page. Try it before building an
enrichment scrape.

## Prefer the network over the DOM — when the DOM is the problem

On a virtualized list (LinkedIn, most infinite feeds), the DOM holds only the
rows on screen, under class names that change between deploys. There, the
network is the reliable path:

1. `browser_set_intercept_patterns` if the site uses endpoints outside the
   defaults (`graphql`, `/api/`, `voyager`, `feed`).
2. `browser_smart_scroll` to trigger lazy loading. It yields until new requests
   land, so you do not have to guess a wait.
3. `browser_get_network_state` to read the JSON the page itself received.

**But check first that there is a network path at all.** Plenty of sites are
server-rendered: the records ship in the initial HTML and no XHR ever fires.
Chasing the network there costs several calls and returns an empty buffer that
looks identical to "you set the wrong pattern". If `browser_extract` already
returns full records, or `fields: ["jsonld"]` has the data, the page is
server-rendered — use the DOM and move on.

The default intercept patterns include `/api/`, which matches analytics and maps
traffic on most sites. An almost-empty-looking buffer full of Google requests is
that, not your data.

## Shadow DOM, iframes, and late modals

PolterTab handles these without special flags, which is worth knowing so you do
not work around problems it already solves:

- **Shadow roots** — including closed ones — are pierced automatically, in
  `browser_extract`'s record scope too.
- **Child frames** are searched in parallel when the top frame misses, so an
  element inside a sandboxed iframe is reachable by plain selector.
- **Late-rendering elements** get retried for ~3s. A modal that mounts a beat
  after the click that opened it does not need a manual wait.

`Element not found` after that window means "not on this page", not "try again".
`browser_extract` does not throw for this — it returns `records_found: 0` with
the warnings above, which tell you more than an error would.

## Selectors, in order of durability

1. `#id` and `[data-testid]` — survive redesigns.
2. `[aria-label="..."]`, `[role=...]`, `[placeholder="..."]` — semantic, stable.
3. Exact visible text — PolterTab matches it across shadow boundaries.
4. Structural CSS (`div > div:nth-child(3)`) — last resort, expect breakage.

Long generated class chains (`.css-1x2y3z4`) are the worst of both worlds:
brittle and unreadable. Reach for a `@e` ref from the last snapshot instead.

## Keep payloads out of the context window

Every read tool takes `output_file`. The payload goes to
`~/.poltertab/downloads/` and you get back row count, field names, fill rates
and two sample records. Use it for anything bigger than a glance.

`.csv` and `.jsonl` are written in those formats, so the file is the deliverable
— never re-type extracted records into a file by hand, which costs more than the
extraction did.

`browser_snapshot` on a real page runs to tens of KB. Narrow it with
`interactive_only` or `max_nodes`, or send it to `output_file`.

Text fields are cut at `max_text` (default 500) and the result says when it
happened. Raise it rather than assuming you have the whole value.

## Known limits — do not fight these

- **Records spanning sibling elements.** `browser_extract` needs one container
  per record. A table where an item's fields live in two sibling `<tr>`s (Hacker
  News is the canonical case) has no such container. Extract twice and join on a
  shared id — never on position.
- **Pagination that is not a URL parameter.** `browser_extract_all` only drives
  `{page}` in a URL. Infinite scroll, a "Load more" button, and cursor tokens
  need `browser_smart_scroll` or clicking, in a loop you run yourself.
- **Virtualized lists.** `browser_extract` reads the DOM, so it sees only the
  rendered window. Use the network path.
- **`output_file` writes only to `~/.poltertab/downloads/`.** A path is reduced
  to its basename; the returned `file` is where it actually went.

## Carry knowledge between sessions

`browser_get_site_memory(hostname)` at the start of work on a site, and
`browser_save_site_memory` the moment you solve something non-obvious. Save the
record root, the field spec that worked, the pagination parameter, and any
obstacle with its fix. `www.` is normalized and a full URL is accepted, so
lookups do not miss.

A note saying "this page is tricky" helps nobody. Save what you would need to
skip the discovery entirely next time.

## Multiple tabs

`browser_session_create` gives a named tab you can return to. Every page-facing
tool takes `session` (or `tabId`).

Omit both and the first `browser_navigate` opens its own tab — it does not
commandeer the tab the user is looking at — and later calls reuse it. That is
fine for single-track work and ambiguous the moment two flows interleave, so
name your sessions when running more than one. Close what you opened with
`browser_session_close`.

## Pitfalls

- Do not scrape repeating records field-by-field. Use `browser_extract`, and
  read its `warnings`.
- Do not zip flat arrays into records by position. One optional field silently
  ruins the whole dataset.
- Do not loop pages yourself when `url_template` covers the site.
- Do not use `browser_get_text` or `browser_scrape` on virtualized lists. Use
  `browser_smart_scroll` then `browser_get_network_state`.
- Do not invent intercept patterns, and do not assume an empty buffer means you
  asked wrong — the site may be server-rendered.
- Do not paste large scraped payloads into the conversation. Use `output_file`.
- Do not retry a failed selector unchanged. The retry already happened inside
  the tool — snapshot again and find out what the page really contains.
- This is the user's live browser. Anything that sends, buys, deletes, or posts
  gets confirmed with them first.
