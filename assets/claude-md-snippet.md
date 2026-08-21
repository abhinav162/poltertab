<!-- poltertab -->
## Browser Control (PolterTab)

PolterTab drives the user's real Chrome profile through MCP tools prefixed
`browser_` — already-logged-in sessions, in a window the user can see. There is
no headless browser to launch.

Start with `browser_snapshot` to see the page (it pierces shadow DOM and child
frames), then act with `browser_click`, `browser_fill`, `browser_navigate`, or
`browser_scrape`. For virtualized or obfuscated pages, prefer
`browser_smart_scroll` + `browser_get_network_state` over DOM scraping.

Read the `browser-navigation-strategy` skill before working a complex site.

Because this is the user's live browser, confirm before anything that sends,
buys, posts, or deletes.
<!-- /poltertab -->
