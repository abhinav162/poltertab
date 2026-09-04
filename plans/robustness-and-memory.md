# PolterTab: robustness + memory-layer design memo

Design memo, not code. Grounds the deep-research findings (Skyvern, Scrapling,
Playwright, CAPTCHA, learned-state) in PolterTab's actual call sites and ranks
what to adopt by **robustness gained per KB spent**. Sources cited inline.

---

## TL;DR — the one insight

The three tools solve DOM fragility three ways, at three price points:

| Strategy | Cost | Fits a lite extension? |
|---|---|---|
| **Playwright** — check the element is *actionable* before touching it | ~0 KB, pure JS | **Yes — do first** |
| **Scrapling** — fingerprint the element, relocate by similarity when the selector misses | small, pure JS, zero deps | **Yes — do second** |
| **Skyvern** — vision-LLM swarm reasons over every step | 30+ LLM calls/task, 4–5 min for a 6-field form ([issues #4375/#4439]) | **No — borrow the *patterns*, not the swarm** |

Skyvern's robustness is real but comes from a planner-actor-validator-navigator
loop that screenshots every step — the wrong architecture for real-time,
user-facing use. What's portable from Skyvern is two *patterns*: **selector-first,
LLM-on-miss** and **record/replay/self-heal caching**. Both are cheap. The heavy
part stays behind.

Note: Skyvern is *hybrid*, not pure vision — it sends a textual list of
interactable DOM elements alongside screenshots. Several "pure vision replaces
selectors" claims were **refuted** in verification. Don't model it as vision-only.

---

## Ranked adoption list (robustness per KB)

### 1. Actionability gate before every click/fill — highest ROI, ~0 KB
**Finding:** Playwright gates every action on four checks and only then acts,
else `TimeoutError`: resolves to **exactly one** element, **Visible**, **Stable**
(not animating), **Receives Events** (hit-test at the click point so an overlay
can't intercept), **Enabled**. ([playwright.dev/docs/actionability])

**Today:** `content_script.js:161` `waitForElement` polls with backoff to
`ELEMENT_WAIT_MS=3000`, but only for *existence*. `fill()` (`:522`) does
scrollIntoView→focus→set value with no visibility/enabled/overlay check.
`click` fires on the node regardless of overlays — the exact failure a hit-test
catches.

**Do:** extend the wait to poll `visible && enabled && hitTestAtPoint(el)` before
click/fill. The `elementFromPoint` hit-test is ~5 lines and kills the most common
silent failure (modal/cookie-banner intercepts the click, action "succeeds" on
the wrong node). Pure JS, no deps.

### 2. Poll-until verification, not one-shot — ~0 KB
**Finding:** Playwright's web-first assertions poll and retry until true;
`isVisible()` returns instantly without waiting. ([playwright.dev/docs/best-practices])

**Do:** one shared `pollUntil(predicate, timeout)` helper, reused by
extract/verify steps and by the actionability gate above. `browser_extract`'s
loosening probe (`content_script.js:395`) and `extractAll`'s halt checks already
want this shape — factor it once.

### 3. Structural-fingerprint self-healing selectors — the memory-priority #1, small + zero deps
**Finding:** Scrapling relocates an element after DOM drift with **no AI**: it
stores a fingerprint (own tag, text, attributes name+value, sibling tags, path by
tag, **plus parent** tag/attrs/text), then scores fuzzy similarity against every
element on the changed page (class-order aware) and returns the best match.
Persisted in SQLite, compared with `SequenceMatcher` above a threshold.
([scrapling.readthedocs.io/.../adaptive.html])

**Today:** `resolveElement` (`content_script.js:57`) has a 4-tier ladder
(CSS → XPath → text → shadow-pierce) but **no fingerprint, no relocation, no
self-healing** — a stale selector just fails.

**Do:** add a **5th tier** that fires only when tiers 1–4 miss:
1. At scrape/action time, record a fingerprint alongside the selector.
2. On a miss, walk the DOM once, score each node's fingerprint vs the stored one
   (JS has no `SequenceMatcher` — a small token-overlap / Jaccard score over
   {tag, attrs, text, sibling-tags, parent} is enough), take the best above a
   threshold.
3. **Write the healed selector back to memory** (see §Memory). This is the piece
   Scrapling's runtime *doesn't* do — it heals per-call; persisting the repair is
   what makes it compound.

Cost: O(n) DOM scan **only on miss**, gated behind the cheap tiers. No headless
browser, no model, no new dep. This is the cheapest durable robustness win after
the actionability gate.

### 4. Selector-first, LLM-on-miss, then persist — closes the self-healing loop
**Finding:** Skyvern's SDK has an **AI-fallback mode** — try the CSS/XPath
selector, invoke LLM element-location only if it fails. But as documented the
fallback recovers the *action*; it doesn't persist a repaired selector.
([skyvern docs/browser-automations/overview])

**Do:** PolterTab's escalation ladder becomes: cheap selector (tiers 1–4) →
fingerprint relocation (tier 5, §3) → **only then** ask the calling model to pick
from a fresh `browser_snapshot`. Whatever resolves, write the working
anchor+fingerprint back to memory so the next run skips straight to it. The model
is the last resort, not the hot path — keeps token cost near zero on repeat runs.

### 5. Prefer role/name/text anchors over CSS in memory — ~0 KB, complements §3
**Finding:** Playwright recommends user-facing attributes (role, name, text) over
DOM-structure selectors because classes/XPath break on restyle.
([playwright.dev/docs/best-practices])

**Today:** `snapshot()` (`content_script.js:179`) **already captures** `role`,
`text`, `type`, `placeholder` per node. That data exists and is thrown away for
targeting.

**Do:** when storing a recipe step, prefer a role+accessible-name anchor as the
*primary* key and keep the structural fingerprint (§3) as the *fallback*. They're
complementary: role/text survives restyles; fingerprint survives text/label
changes. Free, because the snapshot already has both.

### 6. Wire up (or delete) the dead `@e` ref — correctness debt
**Finding (codebase):** `snapshot()` assigns `ref="@e"+counter` and sets
`data-zc-ref` (`content_script.js:219-220`), emitted per node — but grep finds
**zero readers**. `resolveElement` has no `@e`/`data-zc-ref` branch, so any
returned ref fails through all tiers. Dead output.

**Do:** either delete it, or (better) make `resolveElement` consume
`[data-zc-ref="..."]` as tier 0. Wiring it up gives snapshot→action a stable
handle and a natural key to attach fingerprints to. Small change, removes a
confusing footgun.

### 7. Zero-LLM nav primitives — mostly already done
**Finding:** LaVague hardcodes frequent nav ops (scroll up/down, wait) as
pre-defined code that skips both RAG and the LLM.
([LaVague action-engine.md])

**Today:** PolterTab already does this for scroll/click/fill. Gap:
`smart_scroll` is a stub — `scroll` + fixed 2s sleep + "go read network state
yourself" (`index.js:1388-1413`).

**Do:** make `smart_scroll` a real primitive: scroll, then `pollUntil` (§2)
network-idle *or* new records appeared, capped. Covers virtualized/infinite-scroll
lists, which the `browser-navigation-strategy` skill already flags as the stale-
selector hot zone. No model call.

---

## Memory layer redesign

Current state (`index.js:1429-1455`): free-text `{obstacle, solution, timestamp}`
appended to `~/.poltertab/navigation_memory/<host>.json`, keyed by hostname.
**No selector/recipe schema, no dedup, no cap, no success/failure signal, grows
unbounded.** Keying (hostname, www-collapsing) is actually good — keep it.

The redesign has three layers, matching your three priorities. Ship them in this
order; each stands alone.

### Layer A — Self-healing selector store (priority #1)
Add a structured section next to the existing notes (don't remove free-text — it's
useful for the LLM). Per anchor:

```
selectors: {
  "<logical-name>": {
    anchor:      { role, name, text },        // primary, from snapshot (§5)
    selector:    "<last-known-good CSS/XPath>",// fast path
    fingerprint: { tag, attrs, text, siblingTags, pathTags, parent }, // §3 fallback
    last_ok, fail_count
  }
}
```

Resolution writes back the healed selector + bumps `last_ok`/`fail_count`.
`fail_count` past a threshold demotes the entry (stop trusting it first).

### Layer B — Learned extraction recipes (priority #2)
Skyvern's **code-caching** is the model: record the successful action/extract
sequence on first run, replay deterministically after, fall back to the agent +
regenerate the cache on breakage — automatically. ([skyvern docs/features/code-caching])

`browser_extract` already produces exactly the reusable artifact: `record`
selector, `fields` map, pagination template, and `fill_rates`/`warnings`
diagnostics (`content_script.js:326`, `index.js:1185`). Persist that as a recipe:

```
recipes: {
  "<flow-name>": {
    extract: { record, fields, pagination },  // straight from a good extract run
    steps:   [ ...actions with Layer-A anchors ],
    baseline_fill_rates, last_ok, fail_count
  }
}
```

Self-heal signal is **free and already computed**: `extractAll`'s
`fill_rate_deviation` halt (`index.js:1262`) is your "recipe went stale" trigger —
when a replay's fill-rate drops below tolerance vs `baseline_fill_rates`, mark the
recipe stale and re-derive. No new machinery, just persist + compare what exists.

Also fix the current gaps while touching this file: **dedup on save, cap array
growth, add a success/failure flag** (all absent today, `index.js:1442-1455`).

### Layer C — Semantic/embedding recall (priority #3) — the weight decision
**Finding:** LaVague runs embedding-RAG over page structure to retrieve the
relevant slice *before* querying the LLM. ([LaVague action-engine.md])

You picked this, but **it's the one item that fights "keep it lite."** PolterTab
today has **2 runtime deps** and no build step. Real options, cheapest first:

- **C0 (recommended first): don't embed yet.** Lexical recall over recipe names +
  the free-text notes (token overlap / BM25-lite, ~30 lines, zero deps) answers
  "how do I do X on site Y" well enough at PolterTab's scale (one file per host,
  a handful of recipes). Ship this; measure whether it's insufficient before
  adding vectors.
- **C1 (if C0 proves weak): hosted embeddings, no local model.** Call an embedding
  API at save/recall time, store vectors as plain JSON floats, cosine in JS. Adds
  a network dep + a key, **not** a heavy local runtime. Keeps the extension lite;
  moves weight to a call you already make LLM calls next to.
- **C2 (avoid): local embedding model / vector DB.** transformers.js or a WASM
  model is tens of MB — that's the whole "lite" property gone for a feature C0
  likely covers. Only if C0+C1 both measurably fail.

Recommendation: **build A and B now, ship C0, gate C1/C2 behind a measured need.**
That honors "keep it lite" while leaving the semantic door open — you get 90% of
the recall value for ~0 KB, and only pay weight if the data proves you must.

---

## CAPTCHA / anti-bot — narrow but clear

Research was thin here (only 1 claim survived): Skyvern's CAPTCHA solvers,
proxies, and anti-bot are **cloud-only, excluded from the open-source core**.
([github.com/skyvern-ai/skyvern]) No open-source solving technique was extractable.

For PolterTab specifically the answer is unusually clean: **it drives the user's
real, logged-in Chrome profile.** That means:

- **Anti-bot fingerprint spoofing is moot** — the user's genuine profile *is* the
  fingerprint. Nothing to spoof; don't add stealth machinery.
- **Solver services are the wrong call** — sending the user's authenticated
  session's CAPTCHA to a third-party solver is an ethics/ToS hazard and outward-
  facing. Don't.
- **The viable, ethical pattern is human-in-the-loop handoff.** Detect a CAPTCHA,
  **pause and hand control back to the user** who's sitting right there.

**Do (small):** a `browser_detect_captcha` check — look for the known widget
iframes/elements (`iframe[src*="recaptcha"]`, `[src*="hcaptcha"]`,
`[src*="challenges.cloudflare"]` / Turnstile, common challenge containers). When a
click/fill/extract stalls, run it; if positive, return a distinct
`blocked_by_captcha` status so the calling model tells the user "solve the CAPTCHA
in your browser, then I'll continue" instead of thrashing. Detection is cheap and
selector-based; no solving, no deps. (Detection specifics weren't in the research —
this is the pragmatic minimum, tune the selectors against real challenges.)

---

## Form filling — incremental

Today `browser_fill` is single-field only (`content_script.js:522`): no
multi-field orchestration, no select/checkbox/radio handling, no file upload.
Skyvern's form strength is its vision loop — too heavy to copy. Lite path:

- Extend `fill` to handle `<select>` (set value + dispatch `change`), checkbox/
  radio (set `checked`), gated by the actionability check from §1.
- Multi-field: a thin `browser_fill_form({fields})` that loops single fills with
  the actionability gate between each — no new engine, just batching + the gate.
- Field auto-mapping (label/placeholder/aria → value) can reuse snapshot's
  role/name/placeholder data (§5) later; not needed for v1.

---

## Suggested sequencing

1. **Actionability gate + `pollUntil`** (§1, §2) — biggest robustness, ~0 KB, unblocks everything else.
2. **Wire up or delete `@e` ref** (§6) — removes a footgun, gives a clean anchor handle.
3. **Memory Layer A: fingerprint self-healing** (§3, §4, §5) + dedup/cap/flags fix.
4. **Memory Layer B: learned recipes** (§B) reusing existing extract diagnostics.
5. **`smart_scroll` real primitive** (§7) + **CAPTCHA detect + handoff**.
6. **Form filling extensions.**
7. **Semantic recall C0**; revisit C1 only if measured need.

Every item above is pure JS on the existing 2-dep footprint except semantic C1/C2,
which is explicitly gated. Robustness compounds because each healed selector /
recipe writes back — the tool gets more reliable per site the more it's used.

---

## Sources (verified, 2/3+ adversarial vote)
- Skyvern architecture / heaviness / hybrid-not-vision: github.com/skyvern-ai/skyvern; skyvern.com/blog/how-skyvern-reads-and-understands-the-web; issues #4375/#4439
- Skyvern AI-fallback mode: skyvern.com/docs/developers/browser-automations/overview
- Skyvern code-caching (record/replay/self-heal): skyvern.com/docs/developers/features/code-caching
- Scrapling adaptive fingerprint + similarity relocation: scrapling.readthedocs.io/en/latest/parsing/adaptive.html
- Playwright actionability (visible/stable/hit-test/enabled): playwright.dev/docs/actionability
- Playwright web-first assertions + role/text locators: playwright.dev/docs/best-practices
- LaVague RAG-gating + zero-LLM nav primitives: github.com/lavague-ai/LaVague .../action-engine.md
- CAPTCHA cloud-only split: github.com/skyvern-ai/skyvern

**Research gaps (not covered by surviving evidence, flagged for honesty):**
Scrapling's stealth internals; Playwright's iframe/shadow/virtualized-scroll
specifics; concrete CAPTCHA detection signatures; whether Skyvern runs on
Playwright under the hood (verification errored, unconfirmed). The §CAPTCHA
detection selectors and §7 scroll approach are pragmatic proposals, not
research-backed specifics — validate against real pages.
