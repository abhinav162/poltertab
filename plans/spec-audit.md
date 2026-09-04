# Audit: "AI-Browser MCP Extension Bridge" spec vs. PolterTab as it stands

Checked against `chrome-extension/{manifest.json,content_script.js,background.js}`
and `mcp-server/index.js` on `feat/extraction-loop`.

| Spec row | Status | Evidence |
|---|---|---|
| AXTree extraction | **partial** | `snapshot()` c_s.js:179 |
| Set-of-Mark IDs | **broken** | `data-zc-ref` written c_s.js:220, read nowhere |
| Shadow DOM piercing | **done, exceeds spec** | `deepQuery`/`shadowRoots`, closed roots too |
| Iframe aggregation | **done** | `all_frames: true`; bg.js:772, 902 |
| Event trust (CDP) | **not implemented** | synthetic `MouseEvent`, no `debugger` permission |
| React inputs | **done, exceeds spec** | c_s.js:535-554, + contenteditable branch |
| Auto-wait / stabilization | **partial** | `waitForElement` backoff ~3s; no DOM-quiet gate |
| Multi-tab tracking | **partial** | sessions + `onRemoved`/`onUpdated`; no `onCreated` |
| Action caching | **not implemented** | `site_memory` is the model-written stand-in |
| Visual fallback | **partial** | `browser_screenshot` only; nothing acts on it |
| (4.4) Overlay sniffer | **not implemented** | no z-index/cookie-banner heuristic anywhere |
| (2.3) Viewport culling | **deliberately not** | visibility yes, viewport no — see below |

## The one actual bug

`snapshot()` stamps `data-zc-ref="@e1"`, returns those refs to the model, and
`skills/browser-navigation-strategy` tells agents to prefer them over class
chains. **Nothing resolves them.** `resolveElement` tries CSS, XPath, exact
text, then the piercing versions of the same — none maps `@e1` back to
`[data-zc-ref="@e1"]`. Repo-wide grep: the attribute is written once and never
read. Every `@e` click fails with `Element not found: @e1` after paying the full
3s retry.

Second half: refs are a per-frame counter, so frame 0 and an iframe both emit
`@e1` (visible in the existing test, `mcp-server/test/run.js:1464`). Resolution
has to be frame-scoped or the ref is ambiguous once aggregated.

## Where the AXTree gap actually bites

`snapshot()` reads `getAttribute("role")` and visible text. It never computes an
accessible name: `aria-label`, `aria-labelledby`, `alt`, `title` are all
ignored. So an icon-only button — `<button aria-label="Close">` wrapping an
`<svg>` — has no text, and `compact` mode **drops it from the snapshot
entirely**. The agent cannot see the control it is being asked to click. That is
a bigger reliability hole than the missing `[role] Name (state)` output format.

Also missing: state (`disabled`, `aria-expanded`, `aria-checked`, `selected`)
and implicit roles (`<button>` reports no role at all).

## What I would not build

- **Action caching / page fingerprinting / selector synthesis.** The largest
  section of the spec and the weakest case here. A cache that silently fires a
  stale selector against the user's live logged-in browser is the same class of
  failure as the zip-shift bug this branch exists to fix — plausible wrong
  output, no error. `site_memory` already carries the durable knowledge, and
  `extract_all` already costs 1 call per 100 records, so the LLM round-trips the
  cache would save are largely gone.
- **Viewport culling.** Off-screen records must stay extractable; `extract`
  reading only the visual viewport would break every listing page.
- **Rewriting snapshot output to `[role] Name (state)` strings.** Adding `name`
  and state fields to the existing node shape gets the value; the format change
  is churn.
- **CDP trusted events, for now.** Needs the `debugger` permission, which paints
  a "PolterTab is debugging this browser" bar across the user's real Chrome.
  Real cost, speculative benefit — no site has been observed rejecting our
  click. Add when one does.

## Order I would do the rest in

1. Resolve `@e` refs (frame-scoped) — the system already promises this.
2. Accessible name + state in `snapshot()`.
3. Overlay/cookie-banner sniffer — a real-world blocker, cheap heuristic.
4. `tabs.onCreated` auto-follow — OAuth popups lose context today.
5. MutationObserver quiet gate — only if flakiness is measured; the element
   retry already covers the common case.
