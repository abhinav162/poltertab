# Multi-tab support: report

**Result:** one agent can now open, list, switch, act on and close many tabs,
and each agent keeps its own current tab. Unit suite: 226/226 and 61/61 pass.
I have not tested this in a live browser yet (see "Needs the human").

## What was broken (line numbers are at `8781a86`, before this change)

Tabs were tied to sessions, and the session state had several real bugs.

1. **One global pointer for every agent.** `chrome-extension/background.js:52`
   (`activeSession`) and `:57` (`lastNavigatedTabId`) were single values in the
   extension. One extension serves the primary server and up to 5 secondaries,
   and `resolve()` set `activeSession` on any call that named a session
   (`:222`, `:232`). So a secondary's call moved the primary's pointer, and the
   primary's next untargeted click landed in the secondary's tab.
2. **A new session took over the active tab.** In `resolve()`, an unknown
   `session` fell through to the active session (`:235` → `:239`). Then
   `navigate()` bound the new name to that same tab (`:688-707`). So
   `browser_navigate({session:"b"})` navigated session a's tab, and a and b
   ended up sharing one tab. Non-navigate tools with an unknown session also
   acted silently on whatever tab was active.
3. **Secondaries fell into the same hole.** `mcp-server/bridge.js:540-543`
   added `session: "agent_<nodeId>"` to every secondary call. That session did
   not exist before the secondary's first navigate, so it fell through (bug 2)
   to the primary's tab. It also overrode anything the secondary targeted.
4. **No clear error when a tab was gone.** An explicit `tabId` went straight to
   Chrome (`background.js:213`) and came back as "No tab with id". When the
   current tab was closed, `resolve()` cleared it (`:247-261`) and
   `resolveOrFallback()` then silently acted on the tab the user had focused
   (`:273`).
5. **The pointer did not survive the worker sleeping.** Both pointers were
   in-memory only, so when the MV3 service worker was suspended the next call
   went to the user's focused tab.
6. **No tab tools.** `mcp-server/tools.js:397-447` had only session tools. There
   was no way to list open tabs or pick one by id, and `browser_session_context`
   reported a tab only when the current one had a session name (`background.js:338-362`).

What already worked: an explicit `tabId` or a known `session` on every
page-facing tool, recovering a session's closed tab from its stored URL, and
the first navigate opening its own tab.

## What changed

- `chrome-extension/background.js`, `SessionManager`:
  - `current`: a current-tab pointer per agent (`{session, tabId, goneTabId}`),
    keyed by `params._client` (default `"primary"`). Saved to
    `chrome.storage.session`, so it survives the worker sleeping but not a
    browser restart (tab ids get reused across restarts).
  - `owned`: the tabs PolterTab opened.
  - `resolve()` order:
    1. An explicit `tabId` is checked and used, and does not move the pointer.
    2. A known `session` is used (and reopened if its tab was closed), and
       becomes current.
    3. An unknown `session` opens a new tab on navigate, and errors on any
       other tool.
    4. Otherwise the agent's current tab is used.
    5. If that tab was closed, the call errors with the closed tab's id.
       Navigate opens a fresh tab instead.
  - New routes `tab_new`, `tab_list` (`all` for every tab), `tab_switch`
    (`focus` to bring it to the front) and `tab_close`. `tab_close` refuses the
    user's own tabs unless `force` is set.
  - `session_create` takes `tabId` to adopt a tab that is already open.
    `session_context` reports the current tab even when it has no session name,
    plus `closedTabId`.
- `mcp-server/bridge.js`: the primary adds `_client: ws.nodeId` to each
  command it proxies from a secondary, taken from the socket rather than the
  message. Secondaries no longer add a session.
- `mcp-server/tools.js`: four new tools (27 in total) and clearer `tabId` and
  `session` descriptions.
- `README.md` and `skills/browser-navigation-strategy/SKILL.md`: document the
  current tab and the tab tools.
- Tests: new `mcp-server/test/group-q.js` (Q1 to Q13), run against the real
  `background.js`. The background sandbox in `harness.js` now models closed
  tabs and unfiltered `tabs.query`. The tool count in D1 went from 23 to 27.

Single-tab behaviour is unchanged. The first navigate opens a tab and later
calls reuse it (Q12, C1-C3). With nothing navigated, a read still uses the
user's focused tab (Q12).

## Test result

`npm test` was run outside the sandbox, because the sandbox blocks binding a
local port (EPERM):

```
PolterTab regression suite
...
Q. one agent, many tabs
  PASS  Q1 tab_new opens a tab and makes it current
  PASS  Q2 an explicit tabId acts on that tab without moving the pointer
  PASS  Q3 tab_switch moves where untargeted calls land
  PASS  Q4 navigate with a second session opens it its own tab
  PASS  Q5 an unknown session on a non-navigate call errors instead of borrowing a tab
  PASS  Q6 a closed current tab is reported, not swapped for the user's tab
  PASS  Q7 an explicit dead tabId gets a clear error
  PASS  Q8 each agent keeps its own current tab
  PASS  Q9 tab_list shows PolterTab's tabs and marks the current one
  PASS  Q10 tab_close closes PolterTab's tabs but refuses the user's
  PASS  Q11 tab_switch by session, and a session's tab_close drops the session
  PASS  Q12 single-tab use is unchanged: first navigate opens a tab, the rest reuse it
  PASS  Q13 the bridge stamps the proxying agent instead of injecting a session

226/226 passed
61 passed, 0 failed
```

## How to test it live

1. Reload the unpacked extension in `chrome://extensions` and restart the MCP
   server (both halves changed).
2. Call `browser_tab_new({url:"https://example.com"})` and then
   `browser_tab_new({url:"https://wikipedia.org"})`. Then call
   `browser_tab_list`: it should show both tabs, with the second one current.
3. Call `browser_snapshot`: it should show Wikipedia. Then call
   `browser_snapshot({tabId:<example id>})`: it should show example.com.
   `browser_get_url` should still return Wikipedia.
4. Call `browser_tab_switch({tabId:<example id>})` and then `browser_click`
   something: the click should happen on example.com.
5. Close the current tab by hand and call `browser_snapshot`: it should fail
   with "…(tab N) was closed…".
6. Call `browser_tab_close({tabId:<a tab the user opened>})`: it should be
   refused unless `force: true` is passed.
7. Two agents: start a second Claude session so it runs as a secondary. Each
   one's `browser_navigate` should get its own tab, and neither should move the
   other's current tab.

## Needs the human

Steps 1 to 7 need someone to reload the extension and watch Chrome. I did not
touch the live profile.

## Live test results

Run on 2026-10-10 in the test Chrome profile with the dev MCP server on port
7826, the extension reloaded from `chrome-extension/`, and branch
`feature/multi-tab` at 2237afa.

| Step | Expected | Actual | Result |
|---|---|---|---|
| 1 | Extension and server are on the new code | `browser_get_url` connected. `browser_tab_list` answered with `{current:null, count:0}` and no "Unknown action". | PASS |
| 2 | Two new tabs are listed and the second is current | Opened example.com (399727333) and wikipedia.org (399727334). The list showed both, with `current: 399727334`. | PASS |
| 3 | A plain snapshot shows Wikipedia; `tabId` targets example.com; `get_url` stays on Wikipedia | Snapshot title "Wikipedia". Snapshot with `tabId:399727333` returned "Example Domain". `get_url` returned wikipedia.org on 399727334. | PASS |
| 4 | After switching, a click happens on example.com | `tab_switch(399727333)` then `click("a")` clicked "Learn more". Tab 399727333 went to iana.org and the Wikipedia tab did not change. | PASS |
| 5 | Closing the current tab by hand makes the next snapshot fail with "…(tab N) was closed…" | The human closed 399727333. The snapshot error was "The tab this agent was working in (tab 399727333) was closed. Pick another…". `tab_list` showed `closedTabId: 399727333, current: null`. | PASS |
| 6 | Closing the user's tab is refused without `force`; closing a PolterTab tab works without it | The user's `chrome://extensions` tab was refused with "was not opened by PolterTab, so it is the user's own tab. Pass force: true only if the user asked…". The owned tab 399727334 closed without force. I did not force-close the user's tab. | PASS (step text corrected: it said "a tab you opened yourself") |
| 7 | Two agents each get their own tab and neither moves the other's current tab | A second server process logged "Port 7826 in use, switching to Secondary Mode". Agent B navigated to tab 399727337 (example.org). Agent A then navigated to tab 399727338 (example.net). 45s later, B's `get_url` was still 399727337 and A's was still 399727338. | PASS |

Note: in both agents, `browser_tab_list` lists every PolterTab-owned tab, the
other agent's included, with only the agent's own tab marked current. That
matches the tool description.

`npm test`: 226/226 and 61/61 passed. Group D binds local ports, so it times
out inside a sandbox that blocks binding and has to run unsandboxed.
