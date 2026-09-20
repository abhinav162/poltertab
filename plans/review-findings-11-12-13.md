# Code review — PRs #11 / #12 / #13 (15 findings)

Reviewed by subagents against each PR's stacked base. Line numbers are against
the stack tip (`feat/self-healing-persistence`). Suite green at every level
(104 → 110 → 117), so none of this is caught by the existing tests.

Verification status is marked per finding: **[verified]** = mechanism confirmed
by reading the code in this session; **[repro]** = subagent reproduced it
end-to-end; **[unverified]** = plausible from the subagent's reading, not
independently re-checked.

## PR #11 — actionability gate

1. **HIGH [verified]** `content_script.js:732` (+`:761` fill) — the gate's
   polling is dead code in production. `background.js:968` always probes frame 0
   with `_noWait: true`, so `timeout: params._noWait ? 0 : ELEMENT_WAIT_MS`
   yields timeout 0 → one check → throws `Element not actionable`.
   `isElementMiss` (background.js:809) only matches
   `/not found|Receiving end|No response/i`, so line 996 rethrows instead of
   falling through to step 3's waited retry. There is no single-frame shortcut.
   Fix: treat "not actionable" as a miss, or don't zero the timeout on the probe.
2. **HIGH [unverified]** `content_script.js:730` — `scrollIntoView({behavior:
   "smooth"})` is async, but the first predicate check runs synchronously in the
   same task, so the element hasn't moved yet. Off-viewport targets hit-test at
   stale coords → "covered by another element". Compounds #1.
3. **HIGH [verified]** `content_script.js:359` —
   `hit === el || el.contains(hit) || hit.contains(el)` can never succeed for a
   shadow-DOM element: `elementFromPoint` retargets to the outermost shadow
   *host*, and `Node.contains` does not cross shadow boundaries. Every click on
   an element inside a shadow root is rejected as covered — the core E1/E2/E10
   capability. Invisible to the suite because the fake `elementFromPoint` never
   models retargeting. Fix: `el.getRootNode().elementFromPoint(...)` or compare
   via `composedPath()`.
4. **MEDIUM [unverified]** `content_script.js:330` — no `pointer-events` check,
   and the `hit.contains(el)` branch accepts any ancestor as the hit target. A
   `pointer-events: none` button (common busy/loading pattern) passes the gate.
5. **LOW [unverified]** `content_script.js:342` — `isElementEnabled` inspects
   only the element. `<input>` inside `<fieldset disabled>` reports
   `disabled === false`; ancestor `aria-disabled="true"` ignored. Use
   `el.matches(":disabled")` + ancestor walk.

## PR #12 — self-healing selectors

6. **HIGH [unverified]** `content_script.js:262` — `relocate` accepts the top
   scorer with no uniqueness or margin check, and `score > bestScore` breaks ties
   toward first-in-DOM. N identical `<button class="row-del">Delete</button>`
   rows all score ~0.65 after a class rename → row 1 clicked, reported
   `healed: true`. Nothing positional is scored (`siblingTags` has no index;
   captured `parent.id`/`parent.class` are never read), and
   `attrsSim({}, {}) === 1` gives attribute-less siblings 0.75 on nothing.
   Fix: refuse when runner-up is within a small margin.
7. **HIGH [unverified]** `content_script.js:292` — the relocation attempt sits
   *before* `if (noWait) throw`, and background.js fans the `_noWait` probe to
   **all child frames in parallel** with `fingerprint` forwarded untouched. Every
   iframe runs a fingerprint scan and *performs* the action if anything scores
   ≥0.6 — two "Send" buttons in two frames both get clicked. Suppress healing on
   the probe pass.
8. **MEDIUM [unverified]** `content_script.js:256` — `relocate` scans
   `deepQuery("*", true)` with no visibility filter, so a `display:none` mobile
   twin wins, then dies in the gate with "not visible" after 3s.
9. **MEDIUM [unverified]** `content_script.js:746` — `fingerprint(el)` is
   computed in the return statement, i.e. *after* the click fired, so it captures
   post-click state (`Follow` → `Following`). Next run scores ~0.55 and the heal
   fails. Same for `fill` (after `form.submit()`). Capture right after
   `waitForElement` resolves.
10. **MEDIUM [unverified]** `content_script.js:188` — `el.className` on SVG is an
    `SVGAnimatedString` (truthy even with no class), short-circuiting the
    `getAttribute("class")` fallback and storing
    `"[object SVGAnimatedString]"` for every SVG → icons heal onto each other.
    Read `getAttribute("class")` first.

## PR #13 — fingerprint persistence

11. **HIGH [repro + verified]** `index.js:247` — `recordSelector` runs after the
    command succeeded, inside the try/catch that converts throws to
    `isError: true`. A read-only/full `~/.poltertab` turns a **completed** click
    into a reported failure → agent retries → double-click on Send/Submit/Buy.
    Reproduced at mode 0400: `EACCES` returned after the click was dispatched.
    Fix: wrap `recordSelector`/`noteSelectorFail` in try/catch.
12. **HIGH [repro + verified]** `memory.js:91` — unguarded `JSON.parse`, now on
    the click/fill hot path via `getSelector` (`index.js:227`) *before* the
    command is sent. Any truncated memory file permanently bricks every
    `browser_click`/`browser_fill` on that host (`writeFileSync` truncates in
    place, so a kill mid-write leaves a partial file). Reproduced:
    "Unterminated string in JSON at position 18", extension never saw the click.
13. **HIGH [verified]** `index.js:227` — PR #12 designed relocation as caller
    opt-in (N6 asserts a miss stays a miss without a fingerprint). This PR opts
    every click/fill in, keyed by **host only** — no path, no action. A
    fingerprint from `#submit` on `/checkout` is injected into `#submit` on
    `/settings`; one recorded by `fill` is injected into a `click`. Relocation
    runs on the first `_noWait` probe before any wait, and 0.6 is reachable with
    no text match, so an absent/late element clicks a neighbour — and
    `recordSelector` then persists the wrong element with `failCount: 0`, making
    the mistake the new stored truth.
14. **MEDIUM [unverified]** `index.js:83` — `hostForTab` falls back to a
    process-global `lastHost` and ignores `session` entirely, yet click/fill
    responses carry neither `url` nor `tabId`, so `hostByTab` is essentially
    never populated for them. Cross-session bleed: click in `s1` resolves to
    `s2`'s host.
15. **MEDIUM [unverified]** `memory.js:96` — every mutation is an unsynchronized
    read-modify-write, no lock, no atomic rename, over a file shared by all MCP
    processes (bridge.js has an explicit multi-process design). Concurrent
    sessions silently lose entries and can read a half-written file — which trips
    #12.

Dropped (low, over cap): `content_script.js:99` — the `textFallbackOk` guard also
disables the exact-text tier for legitimate labels starting with `#`/`.`/`[`;
`memory.js:117` — `SELECTORS_CAP` bounds entry count but not entry size
(`siblingTags` unbounded, pretty-printed: ~7 KB/fingerprint on a 1000-row table,
re-parsed and rewritten synchronously on every click).

## Test-coverage correction

`TESTS.md` T5 claims passing "proves `pollUntil` waits for actionability". It does
not. Per finding #1 the polling can't run in production, and T5's own log order
(`(late-overlay removed)` **before** `clicked: late-btn`) is equally consistent
with the click simply arriving after the 2.5 s timer — navigate + MCP round-trip
easily exceeds 2.5 s. T5 passed without exercising the path it claims to prove.
The shadow-DOM gate interaction (#3) has no browser coverage at all: neither
fixture uses a shadow root.
