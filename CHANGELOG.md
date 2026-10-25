# Changelog

All notable changes to PolterTab are documented here.

## [1.12.0](https://github.com/abhinav162/poltertab/compare/v1.11.0...v1.12.0) (2026-10-25)


### Features

* **registry:** publish to the official MCP Registry on stable releases ([#71](https://github.com/abhinav162/poltertab/issues/71)) ([f61e807](https://github.com/abhinav162/poltertab/commit/f61e807631777e3ea82606d15fd2fdd667589321))


### Bug Fixes

* **bridge:** bind the WebSocket server to loopback only ([#74](https://github.com/abhinav162/poltertab/issues/74)) ([d6fa272](https://github.com/abhinav162/poltertab/commit/d6fa2724392931b268f0c89594f28e42e945f509))
* **bridge:** require a paired or Store extension to hold the browser connection ([#75](https://github.com/abhinav162/poltertab/issues/75)) ([0ec8428](https://github.com/abhinav162/poltertab/commit/0ec8428095986729e99dddfbfe2ba89bcc31e9f7))
    * Unpacked installs must pair once: `poltertab uploads pair`.
* **copy:** correct options footer outbound-call claim and 4-character pair code ([#73](https://github.com/abhinav162/poltertab/issues/73)) ([b61ef2a](https://github.com/abhinav162/poltertab/commit/b61ef2ac51ace56109d33be7158eb2abcf8b67b8))


### Documentation

* launch trust docs, discovery badges, and Add to Cursor ([#72](https://github.com/abhinav162/poltertab/issues/72)) ([e187550](https://github.com/abhinav162/poltertab/commit/e1875503b067771d49c7c259d939dd194758827e))
* **pair-flow:** note onCancel's reliance on undocumented rl.closed ([#68](https://github.com/abhinav162/poltertab/issues/68)) ([68cd92a](https://github.com/abhinav162/poltertab/commit/68cd92a20d8c384e3ec92511845fa6833c34051c))
* state loopback-only bind and the 1.12.0 pairing requirement ([#76](https://github.com/abhinav162/poltertab/issues/76)) ([17ebf42](https://github.com/abhinav162/poltertab/commit/17ebf42e7ff853f813259357d845ca214d512427))

## [1.11.0](https://github.com/abhinav162/poltertab/compare/v1.10.1...v1.11.0) (2026-10-23)


### Features

* **setup:** offer the Chrome Web Store extension with a compatibility check ([#64](https://github.com/abhinav162/poltertab/issues/64)) ([8fa30e4](https://github.com/abhinav162/poltertab/commit/8fa30e4bd31ab199ecb49c2bbb675f148927cb05))


### Bug Fixes

* **setup:** cancel on Ctrl-C / Ctrl-D during the Store lookup ([#67](https://github.com/abhinav162/poltertab/issues/67)) ([1cec9ee](https://github.com/abhinav162/poltertab/commit/1cec9eeef6df8db4d061abab5dd8e2d756f3d29f))
* **setup:** make Ctrl-C cancel every interactive prompt and the extension wait ([#66](https://github.com/abhinav162/poltertab/issues/66)) ([cc81db1](https://github.com/abhinav162/poltertab/commit/cc81db15495322fb8e2d00b4def42c724988efdf))


### Documentation

* make the Chrome Web Store the main extension install path ([#63](https://github.com/abhinav162/poltertab/issues/63)) ([d020b62](https://github.com/abhinav162/poltertab/commit/d020b625fc318b460128d9b4a73865b153ed86de))

## [1.10.1](https://github.com/abhinav162/poltertab/compare/v1.10.1-beta.1...v1.10.1) (2026-10-19)


### Miscellaneous Chores

* release 1.10.1 final ([#60](https://github.com/abhinav162/poltertab/issues/60)) ([2073b53](https://github.com/abhinav162/poltertab/commit/2073b5393e0e0c121a9b4d03a71c986c7a53b163))

## [1.10.1-beta.1](https://github.com/abhinav162/poltertab/compare/v1.10.0...v1.10.1-beta.1) (2026-10-19)


### Bug Fixes

* **bridge:** trust the Chrome Web Store extension id ([#57](https://github.com/abhinav162/poltertab/issues/57)) ([5cd3f2a](https://github.com/abhinav162/poltertab/commit/5cd3f2a0638e2ae129ad4bfc018fe981e1852c95))


### Miscellaneous Chores

* remove release-as after 1.10.0 final ([#56](https://github.com/abhinav162/poltertab/issues/56)) ([1b91802](https://github.com/abhinav162/poltertab/commit/1b91802d07edb9a28bda6002bb62341c00ffb13a))

## [1.10.0](https://github.com/abhinav162/poltertab/compare/v1.10.0-beta.2...v1.10.0) (2026-10-18)


### Miscellaneous Chores

* release 1.10.0 final ([#54](https://github.com/abhinav162/poltertab/issues/54)) ([ba6c098](https://github.com/abhinav162/poltertab/commit/ba6c0982b6f6cf6f385011d62eedf4a413b8f780))

## [1.10.0-beta.2](https://github.com/abhinav162/poltertab/compare/v1.10.0-beta.1...v1.10.0-beta.2) (2026-10-18)


### Features

* **uploads:** pair with a short code and choose an upload folder during setup ([#48](https://github.com/abhinav162/poltertab/issues/48)) ([d591ff8](https://github.com/abhinav162/poltertab/commit/d591ff8945dbf87ab8bd42187360bc2903bf9331))


### Bug Fixes

* **uploads:** keep the pair code stable and visible, and exit after pairing ([#52](https://github.com/abhinav162/poltertab/issues/52)) ([362b6ef](https://github.com/abhinav162/poltertab/commit/362b6ef34c9706108a64ca7fa48b83dc9b7b6fe3))
* **uploads:** pairing follow-ups from review ([#50](https://github.com/abhinav162/poltertab/issues/50)) ([4a19277](https://github.com/abhinav162/poltertab/commit/4a19277f448c279d71ec644097bc411adc97ef48))

## [1.10.0-beta.1](https://github.com/abhinav162/poltertab/compare/v1.9.0...v1.10.0-beta.1) (2026-10-16)


### Features

* **extension:** Daylight redesign of popup and options, new icon ([#45](https://github.com/abhinav162/poltertab/issues/45)) ([8f1f1c8](https://github.com/abhinav162/poltertab/commit/8f1f1c89c8fee0213a2448cc1f0015c72f9645cb))
* **extension:** manage upload folders from the settings page ([#47](https://github.com/abhinav162/poltertab/issues/47)) ([3040815](https://github.com/abhinav162/poltertab/commit/3040815230356e9ac12bad7dc66b2a8b5fda8511))
* **uploads:** manage upload folders from the CLI and extension, with activity log ([#46](https://github.com/abhinav162/poltertab/issues/46)) ([149a91c](https://github.com/abhinav162/poltertab/commit/149a91cbbe337db9f3657974d208b081400c2f71))


### Miscellaneous Chores

* remove release-as and add exclude-paths after 1.9.0 final ([#43](https://github.com/abhinav162/poltertab/issues/43)) ([75bcd6a](https://github.com/abhinav162/poltertab/commit/75bcd6ad68987a5e6dd29405873fd875b31c3dc8))

## [1.9.0](https://github.com/abhinav162/poltertab/compare/v1.9.0-beta.2...v1.9.0) (2026-10-15)


### Miscellaneous Chores

* release 1.9.0 final ([#42](https://github.com/abhinav162/poltertab/issues/42)) ([0e14ad3](https://github.com/abhinav162/poltertab/commit/0e14ad38bca199866617d804be28d4bb06df230c))
* **site:** redesign landing page ([#40](https://github.com/abhinav162/poltertab/issues/40)) ([db245a7](https://github.com/abhinav162/poltertab/commit/db245a7987e737fbf78e6aed9f0d6b7ff33e76eb))

## [1.9.0-beta.2](https://github.com/abhinav162/poltertab/compare/v1.9.0-beta.1...v1.9.0-beta.2) (2026-10-15)


### Bug Fixes

* **extension:** Chrome Web Store readiness — zip root + remove redundant activeTab ([#36](https://github.com/abhinav162/poltertab/issues/36)) ([f7b0476](https://github.com/abhinav162/poltertab/commit/f7b04769c79c894261d822110b72b025282f43a4))


### Miscellaneous Chores

* **site:** add demo stills ([#39](https://github.com/abhinav162/poltertab/issues/39)) ([12fa8c7](https://github.com/abhinav162/poltertab/commit/12fa8c7020fb663a641f851a976ae6b7d1298ab2))
* **site:** add PolterTab landing page and GitHub Pages workflow ([#37](https://github.com/abhinav162/poltertab/issues/37)) ([c082580](https://github.com/abhinav162/poltertab/commit/c0825808a82054ee45eace14eca2d32309665aee))

## [1.9.0-beta.1](https://github.com/abhinav162/poltertab/compare/v1.8.1-beta.1...v1.9.0-beta.1) (2026-10-15)


### Features

* **extension,mcp:** file upload via browser_upload_file ([#35](https://github.com/abhinav162/poltertab/issues/35)) ([568eedc](https://github.com/abhinav162/poltertab/commit/568eedcb437f175e0da013bf70139fc6ad8a0789))


### Bug Fixes

* **ci:** single publish path and drop last-release-sha ([#33](https://github.com/abhinav162/poltertab/issues/33)) ([a872613](https://github.com/abhinav162/poltertab/commit/a872613f64c053c279b6f09ed7b997c1d995d8ca))

## [1.8.1-beta.1](https://github.com/abhinav162/poltertab/compare/v1.8.0...v1.8.1-beta.1) (2026-10-15)


### Bug Fixes

* **ci:** beta versioning and v-prefixed tags for release-please ([#30](https://github.com/abhinav162/poltertab/issues/30)) ([dc843c1](https://github.com/abhinav162/poltertab/commit/dc843c14dfe82776f7e0f076c06f81dc041df43d))
* **ci:** start release-please changelog at v1.8.0 on main ([#32](https://github.com/abhinav162/poltertab/issues/32)) ([087c46d](https://github.com/abhinav162/poltertab/commit/087c46dc7d77d24640837837f66f5795225f483a))

## 1.8.0 — 2026-10-14

Builds on 1.7.0. Contains PR-1 (#22), PR-2 (#23), PR-3 (#24), the macOS legacy-bind
fix (#25), PR-4 (extension reconnect + version handshake, #26) and the docs (#27).
1.8.0-beta.1 through beta.3 carried everything except PR-4.
Update **both** the npm package and the Chrome extension: the extension reconnect
needs the 1.8.0 extension.
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
