---
name: browser-navigation-strategy
description: Use when driving a real browser with PolterTab's browser_* tools — navigating, scraping, or clicking through a site whose DOM is virtualized, obfuscated, shadow-rooted, or iframe-sandboxed, and selectors keep going stale.
---

# Browser Navigation Strategy

PolterTab drives the user's real Chrome profile. Sessions are already logged in,
and every action happens in a window the user can see. That makes it powerful and
unforgiving: a wrong click lands on a real account.

## Read the page before you touch it

`browser_snapshot` is the first call on any unfamiliar page. It returns visible,
interactive elements with `@e1`-style refs, and it descends into shadow roots and
child frames — so what it shows you is the page as it really is, not just the
top-level light DOM.

Never guess a selector from a URL or a screenshot. Snapshot, then act on what
came back.

## Prefer the network over the DOM

On a virtualized list (LinkedIn, most infinite feeds), the DOM holds only the
rows currently on screen, under class names that change between deploys. Scraping
it yields a fraction of the data and breaks next week.

The reliable path:

1. `browser_set_intercept_patterns` if the site uses endpoints outside the
   defaults (`graphql`, `/api/`, `voyager`, `feed`).
2. `browser_smart_scroll` to trigger lazy loading. It yields until new requests
   land, so you do not have to guess a wait.
3. `browser_get_network_state` to read the structured JSON the page itself
   received.

Pass `output_file` on `browser_get_network_state` for anything large. The payload
goes to disk and you get a summary — a 4 MB GraphQL response does not belong in
the context window.

## Shadow DOM, iframes, and late modals

PolterTab handles these without special flags, which is worth knowing so you do
not work around problems it already solves:

- **Shadow roots** — including closed ones — are pierced automatically. A
  selector that matches inside a web component just works.
- **Child frames** are searched in parallel when the top frame misses, so an
  element inside a sandboxed iframe is reachable by plain selector.
- **Late-rendering elements** get retried for ~3s. A modal that mounts a beat
  after the click that opened it does not need a manual wait.

If an element genuinely is not there, you get `Element not found` after the
retry window. Treat that as "not on this page", not "try again immediately".

## Selectors, in order of durability

1. `#id` and `[data-testid]` — survive redesigns.
2. `[aria-label="..."]`, `[role=...]`, `[placeholder="..."]` — semantic, stable.
3. Exact visible text — PolterTab matches it across shadow boundaries.
4. Structural CSS (`div > div:nth-child(3)`) — last resort, expect breakage.

Long generated class chains (`.css-1x2y3z4`) are the worst of both worlds:
brittle and unreadable. Reach for a `@e` ref from the last snapshot instead.

## Carry knowledge between sessions

`browser_get_site_memory(hostname)` at the start of work on a site, and
`browser_save_site_memory` the moment you solve something non-obvious — a cookie
wall that intercepts the first click, a required query parameter, the shape of a
GraphQL response worth reusing.

The point is to not rediscover the same obstacle next week. Save the obstacle and
the fix together; a note saying "this page is tricky" helps nobody.

## Multiple tabs

`browser_session_create` gives a named tab you can return to. Every page-facing
tool takes `session` (or `tabId`) to target it. Omit both and PolterTab uses the
last tab it navigated, falling back to the active tab — fine for single-track
work, ambiguous the moment two flows interleave. Name your sessions when running
more than one.

Close what you opened with `browser_session_close`.

## Pitfalls

- Do not use `browser_get_text` or `browser_scrape` on virtualized lists. Use
  `browser_smart_scroll` then `browser_get_network_state`.
- Do not invent intercept patterns. Check the defaults, then set only what the
  site actually needs.
- Do not paste large scraped payloads into the conversation. Use `output_file`.
- Do not retry a failed selector unchanged. The retry already happened inside
  the tool — snapshot again and find out what the page really contains.
- This is the user's live browser. Anything that sends, buys, deletes, or posts
  gets confirmed with them first.
