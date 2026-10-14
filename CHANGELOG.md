# Changelog

All notable changes to PolterTab are documented here.

## 1.8.0 (beta — beta.1…beta.3 on npm `beta`; extension reconnect and version handshake not yet in any beta)

Builds on 1.7.0. 1.8.0-beta.1 through beta.3 are published (`npm install -g poltertab@beta`)
and contain PR-1 (#22), PR-2 (#23), PR-3 (#24), and the macOS legacy-bind fix (#25).
Only PR-4 (extension reconnect + version handshake, #26) is not yet in any beta.
All changes are in the MCP server (`mcp-server/bridge.js`, `mcp-server/config.js`)
and the Chrome extension (`chrome-extension/`). No breaking changes to MCP tool names or parameters.

### Extension reconnects automatically (PR-4)

The Chrome extension now reconnects on its own when the bridge server restarts
or the WebSocket drops. It dials immediately on disconnect, then backs off
exponentially (1 s, 2 s, 4 s … capped at 30 s), with a Chrome alarm as a
backstop that wakes the service worker if it was suspended mid-schedule. The
bridge reports the reconnection state to callers:

- `[extension_reconnecting port=P elapsed=Xs]` — reconnection in progress;
  retry shortly.
- `[extension_never_connected port=P]` — extension has never reached this
  server; check install and port.

A version handshake was added at connection time. The primary and each v2
secondary exchange their `package.json` version; if major versions disagree,
the primary sends close code **4002** and the secondary stops retrying until
restarted with a compatible version. `poltertab doctor` reports skew.

### Command queue (PR-3)

The primary now limits how many commands it sends to the extension at once
(`POLTERTAB_MAX_CONCURRENCY`, default 6). Commands beyond that limit are queued
per-secondary (up to `POLTERTAB_QUEUE_DEPTH`, default 3). The caller receives
an immediate `queued` acknowledgement and its 35 s timeout is re-armed, so
queue wait does not consume the execution budget. Errors:

- `[queue_full action=X]` — per-secondary queue full; retry after a short pause.
- `[queue_timeout action=X]` — command dropped because the caller's 35 s budget is nearly spent (2 s margin). `POLTERTAB_QUEUE_TIMEOUT_MS` (60 s) is a separate GC backstop for commands in a queue that never gets dequeued.

`GET http://127.0.0.1:7822/status` returns a JSON snapshot with queue depths,
connected agents, and wait-time percentiles (p50/p95/p99). The endpoint is
loopback-only; all other callers receive 404.

### Idle eviction and lazy reconnect (PR-2)

A v2 secondary that is idle for `POLTERTAB_IDLE_EVICTION_MS` (default 5 min)
is evicted with close code **4001**. On the next command the secondary dials
again transparently (lazy reconnect); the agent does not need to handle 4001.
The current tab pointer in the extension is preserved across evict/reconnect
cycles.

Concurrent lazy-reconnect callers share one dial attempt, so a burst of
commands after eviction costs one connection, not one per command.

### Connection-loop fix (PR-1, #22)

- Ended the secondary rejection/promotion loop: refused secondaries now receive
  versioned close codes and back off (2 s, 4 s … ±25%) instead of redialling at
  full speed.
- Fixed a handle leak: every lost promotion race used to leave an unbound server
  handle behind; those handles are now closed.

### macOS legacy-bind fix (#25)

- The primary binds `::` (IPv6 wildcard dual-stack) instead of specific loopback
  addresses, preventing a legacy 1.7.x server from winning the wildcard bind on
  macOS and posing as a false primary.
- `/status` is restricted to loopback callers by remote address (IP set) and by
  `Host` header (added in PR-4/#26); all other callers receive 404.

### Port probe (PR-3, #24)

- The bridge probes the port before calling `listen()`, so a true primary is
  detected before the socket is committed.

### New env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `POLTERTAB_MAX_SECONDARIES` | `50` | Maximum v2 secondaries (was hard-coded 5 in 1.7) |
| `POLTERTAB_IDLE_EVICTION_MS` | `300000` | Idle ms before a v2 secondary is evicted |
| `POLTERTAB_MAX_CONCURRENCY` | `6` | Extension command concurrency limit |
| `POLTERTAB_QUEUE_DEPTH` | `3` | Per-secondary queue depth |
| `POLTERTAB_QUEUE_TIMEOUT_MS` | `60000` | GC backstop for stuck queued commands |
| `POLTERTAB_COMMAND_TIMEOUT_MS` | `35000` | Per-command budget (ms). Must exceed the extension's 30 s navigation wait + 500 ms settle, or slow successful loads surface as timeouts. Adjust for tests only. |

### Upgrade path from 1.7.x

1.8 introduces the version handshake. A secondary whose major version does not
match the primary's receives close code 4002 and stops retrying; updating the npm
package (so all sessions run the same major) resolves it. The Chrome extension
should also be updated alongside the npm package to get the PR-4 reconnect
behaviour:

```bash
npm update -g poltertab
# then reload the extension from chrome://extensions/
```

A 1.7.x secondary that has not been updated does not speak the handshake and
is treated as a legacy secondary: it is never idle-evicted, bypasses the
command queue, and continues to work — but it counts against the old,
unversioned secondary path and will not benefit from queue management.

## 1.7.0

- Multi-tab support: per-agent current tab, `browser_tab_new`,
  `browser_tab_list`, `browser_tab_switch`, `browser_tab_close`.
- `browser_tab_close` on a user-opened tab returns `needs_user_permission`;
  retry with `force: true`. A tab Chrome does not have returns `tab_not_found`.
- `browser_session_close` applies the same `needs_user_permission` guard to
  adopted tabs.
- Screenshot serialised with a mutex; restores the previously-active tab.
- `tab_new` race fixed: concurrent calls both complete.
- Reserved envelope keys (`_client`, `id`, `action`) stripped from tool params.

## 1.6.0

- Learned extraction recipes (Layer B): step preambles, slice variants, replay.
- `browser_extract_all`: paginated extraction in one call, halts on
  `limit_reached`, `empty_page`, `duplicate_page`, `fill_rate_deviation`, or
  `max_pages`.
- `browser_scrape` `fields` param: select which parts of a full-page scrape to
  return (`["meta","jsonld"]` for og: tags and schema.org without body text).
