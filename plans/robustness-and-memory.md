# PolterTab: robustness + memory-layer design memo

Design memo, not code. Grounds the deep-research findings (Skyvern, Scrapling,
Playwright, CAPTCHA, learned-state) in PolterTab's actual call sites and ranks
what to adopt by **robustness gained per KB spent**. Sources cited inline.

> Reconstructed 2026-09-07 from session context — the original was written
> during the research session but never committed, and was lost when work moved
> machines. Research content is unchanged; a status block and two corrections
> (§6, and the T5 coverage note) have been added from what shipping taught us.

## Status

**Shipped in `v1.6.0-beta.1`** (PRs #11 → #14, all browser-verified):

| Item | Where |
|---|---|
| §1/§2 actionability gate + `pollUntil` | #11, made actually reachable in #14 |
| §3 fingerprint relocation | #12 (+ ambiguity refusal, visibility shortlist, probe suppression in #14) |
| §4 escalation ladder (selector → fingerprint) | #12/#13 — the "model re-picks from a fresh snapshot" tier was never coded; the agent does that itself on failure |
| §6 `@e` ref | **no work needed** — see the correction below |
| Memory **Layer A** (self-healing selector store) | #13, hardened in #14: page/action-keyed, LRU + fail eviction, atomic writes, notes dedup/cap |

**Implemented on `feat/learned-extraction-recipes`, browser-verified through
pass 4:**

| Item | Where |
|---|---|
| Memory **Layer B** (learned extraction recipes + step preambles) | `memory.js` store, new `recipes.js` policy, `index.js` hydrate/observe, `tools.js` schema. Suite 213/213. |

Four browser passes in `poltertab-testing-environment` found **twelve** defects
between them; all are fixed. Pass 4 passed every case in its grid **and still
found a real bug outside it**, which is the pattern worth remembering: the grid
confirms what was already thought through, the free-form look is what finds the
next thing.

Cross-session persistence is proven rather than assumed — captures and replays
ran under different MCP server PIDs, so the file was read by a process that
never wrote it.

**Still unverified in a browser:** LB9 (a slice switch caught half-finished),
added after pass 4 and covering the fix in `b7ea6ac`. Unit-covered by P75-P79.

**The matcher took four rounds to get right**, which is worth recording because
each wrong rule looked reasonable. A variant's key is its preamble; the question
is how to match it against the steps a caller just issued.
`prefix-of-buffer` returned the slice a completed switch had *left*.
`latest-run-end-anywhere` still did, whenever only one variant occurred in the
buffer at all. Only `suffix-of-buffer` is right — the last actions are what put
the page in the state it is in — and it only became viable once scrolls were
excluded from the key, since otherwise a scroll before extracting broke every
match. Each failure returned another slice's records under the wrong label,
called a healthy page stale against the wrong baseline, and charged `failCount`
to a variant that never ran.

**Remaining** (verified absent in the code as of `v1.6.0-beta.1`):

- **§7 real `smart_scroll`.** Still the stub: `scroll` + a fixed 2 s sleep +
  "use browser_get_network_state to read".
- **CAPTCHA detect + handoff.** Zero references anywhere in the codebase.
- **Multi-field form fill.** `fill` is still one field via the native value
  setter — no `<select>`, checkbox/radio, or batched `fill_form`.
- **Layer C semantic recall.** Nothing, lexical or embedding.
- **§5 remainder.** `role` and `aria-label` are *inside* the fingerprint
  (`FP_ATTRS`), but there is no distinct role + accessible-name anchor used as
  the primary lookup, which is what §5 actually proposed.

---

## TL;DR — the one insight

The three tools solve DOM fragility three ways, at three price points:

| Strategy | Cost | Fits a lite extension? |
|---|---|---|
| **Playwright** — check the element is *actionable* before touching it | ~0 KB, pure JS | **Yes — do first** |
| **Scrapling** — fingerprint the element, relocate by similarity when the selector misses | small, pure JS, zero deps | **Yes — do second** |
| **Skyvern** — vision-LLM swarm reasons over every step | 30+ LLM calls/task, 4–5 min for a 6-field form (issues #4375/#4439) | **No — borrow the *patterns*, not the swarm** |

Skyvern's robustness is real but comes from a planner-actor-validator-navigator
loop that screenshots every step — the wrong architecture for real-time,
user-facing use. What's portable is two *patterns*: **selector-first, LLM-on-miss**
and **record/replay/self-heal caching**. Both are cheap. The heavy part stays behind.

Note: Skyvern is *hybrid*, not pure vision — it sends a textual list of
interactable DOM elements alongside screenshots. Several "pure vision replaces
selectors" claims were **refuted** in verification. Don't model it as vision-only.

---

## Ranked adoption list (robustness per KB)

### 1. Actionability gate before every click/fill — highest ROI, ~0 KB
**Finding:** Playwright gates every action on four checks and only then acts,
else `TimeoutError`: resolves to **exactly one** element, **Visible**, **Stable**
(not animating), **Receives Events** (hit-test at the click point so an overlay
can't intercept), **Enabled**. (playwright.dev/docs/actionability)

**Then:** `waitForElement` polled only for *existence*; `fill` did
scrollIntoView→focus→set value with no visibility/enabled/overlay check, and
click fired on the node regardless of overlays.

**Do:** poll `visible && enabled && hitTestAtPoint(el)` before click/fill. The
`elementFromPoint` hit-test is ~5 lines and kills the most common silent failure
(a modal/cookie banner intercepts the click, the action "succeeds" on the wrong
node). Pure JS, no deps.

### 2. Poll-until verification, not one-shot — ~0 KB
**Finding:** Playwright's web-first assertions poll and retry until true;
`isVisible()` returns instantly without waiting.
(playwright.dev/docs/best-practices)

**Do:** one shared `pollUntil(predicate, timeout)` helper, reused by the gate and
by extract/verify steps. `browser_extract`'s loosening probe and `extract_all`'s
halt checks already want this shape — factor it once.

### 3. Structural-fingerprint self-healing selectors — memory priority #1, small + zero deps
**Finding:** Scrapling relocates an element after DOM drift with **no AI**: it
stores a fingerprint (own tag, text, attributes name+value, sibling tags, path by
tag, **plus parent** tag/attrs/text), then scores fuzzy similarity against every
element on the changed page (class-order aware) and returns the best match.
Persisted in SQLite, compared with `SequenceMatcher` above a threshold.
(scrapling.readthedocs.io/en/latest/parsing/adaptive.html)

**Then:** `resolveElement` had a 4-tier ladder (CSS → XPath → text →
shadow-pierce) but no fingerprint, no relocation, no self-healing — a stale
selector just failed.

**Do:** add a **5th tier** that fires only when tiers 1–4 miss:
1. Record a fingerprint alongside the selector at action time.
2. On a miss, walk the DOM once and score each node against the stored
   fingerprint (JS has no `SequenceMatcher` — token-overlap / Dice over
   {tag, attrs, text, sibling-tags, parent} is enough); take the best above a
   threshold.
3. **Write the healed selector back to memory.** This is the piece Scrapling's
   runtime *doesn't* do — it heals per-call; persisting the repair is what makes
   it compound.

Cost: O(n) DOM scan **only on miss**, gated behind the cheap tiers. No headless
browser, no model, no new dep.

### 4. Selector-first, LLM-on-miss, then persist — closes the loop
**Finding:** Skyvern's SDK has an **AI-fallback mode** — try the CSS/XPath
selector, invoke LLM element-location only if it fails. As documented the
fallback recovers the *action*; it doesn't persist a repaired selector.
(skyvern docs/browser-automations/overview)

**Do:** escalation becomes cheap selector (tiers 1–4) → fingerprint relocation
(tier 5) → **only then** ask the calling model to pick from a fresh
`browser_snapshot`. Whatever resolves, write the working anchor+fingerprint back.
The model is the last resort, not the hot path.

### 5. Prefer role/name/text anchors over CSS in memory — ~0 KB, complements §3
**Finding:** Playwright recommends user-facing attributes (role, name, text) over
DOM-structure selectors because classes/XPath break on restyle.
(playwright.dev/docs/best-practices)

**Then (still true):** `snapshot()` **already captures** `role`, `text`, `type`,
`placeholder` per node. That data exists and is thrown away for targeting.

**Do:** when storing a recipe step, prefer a role+accessible-name anchor as the
*primary* key and keep the structural fingerprint (§3) as the *fallback*. They're
complementary: role/text survives restyles; fingerprint survives text/label
changes. Free, because the snapshot already has both.

### 6. The `@e` ref — CORRECTION: not dead
The original memo claimed `snapshot()`'s `ref="@eN"` / `data-zc-ref` was
generated but never consumed, and listed wiring-or-deleting it as work. **That
was wrong** — an exploration agent's grep missed the translation.
`resolveElement` already rewrites `@e5` into `[data-zc-ref="@e5"]`, and test E9
covers it. No work was needed. A later code review repeated the same "dead code"
claim; it is still wrong.

### 7. Zero-LLM nav primitives — mostly already done
**Finding:** LaVague hardcodes frequent nav ops (scroll up/down, wait) as
pre-defined code that skips both RAG and the LLM.
(LaVague action-engine.md)

**Then and now:** PolterTab already does this for scroll/click/fill. Gap:
`smart_scroll` is a stub — `scroll` + fixed 2 s sleep + "go read network state
yourself".

**Do:** make `smart_scroll` a real primitive: scroll, then `pollUntil` (§2)
network-idle *or* new records appeared, capped. Covers virtualized/infinite-scroll
lists, which the `browser-navigation-strategy` skill already flags as the
stale-selector hot zone. No model call.

---

## Memory layer redesign

Original state: free-text `{obstacle, solution, timestamp}` appended to
`~/.poltertab/navigation_memory/<host>.json`, keyed by hostname. **No
selector/recipe schema, no dedup, no cap, no success/failure signal, unbounded
growth.** The keying (hostname, www-collapsing) is good — keep it.

Three layers, shippable independently, in this order.

### Layer A — Self-healing selector store (priority #1) — SHIPPED
Structured section next to the existing notes (keep free-text; it's useful to the
model). Per anchor:

```
selectors: {
  "<key>": {
    anchor:      { role, name, text },          // primary, from snapshot (§5)
    selector:    "<last-known-good CSS/XPath>",  // fast path
    fingerprint: { tag, attrs, text, siblingTags, pathTags, parent }, // §3 fallback
    last_ok, fail_count
  }
}
```

Resolution writes back the healed selector and bumps `last_ok`/`fail_count`;
`fail_count` past a threshold demotes the entry.

*As shipped:* the key is `action|path|selector` rather than the bare selector —
host-only keying let a fingerprint learned by `fill` on `/checkout` fire on a
`click` on `/settings`. The `anchor` sub-object was not implemented (see §5
remainder); role/aria-label live inside the fingerprint instead.

### Layer B — Learned extraction recipes (priority #2) — IMPLEMENTED, see corrections
Skyvern's **code-caching** is the model: record the successful action/extract
sequence on the first run, replay deterministically after, fall back to the agent
and regenerate the cache on breakage — automatically.
(skyvern docs/features/code-caching)

`browser_extract` already produces exactly the reusable artifact: `record`
selector, `fields` map, pagination template, and `fill_rates`/`warnings`
diagnostics. Persist that as a recipe:

```
recipes: {
  "<flow-name>": {
    extract: { record, fields, pagination },   // straight from a good extract run
    steps:   [ ...actions with Layer-A anchors ],
    baseline_fill_rates, last_ok, fail_count
  }
}
```

The staleness signal is **free and already computed**: `extract_all`'s
`fill_rate_deviation` halt is the "recipe went stale" trigger — when a replay's
fill rate drops below tolerance against `baseline_fill_rates`, mark it stale and
re-derive. No new machinery, just persist + compare what exists.

**What shipped differs from that sketch in four ways, each for a reason found
while building it:**

1. **Keying is three levels, not one flow name:** path pattern → recipe (the
   task, identified by its `{record, fields}`) → variant (a slice of it). One
   flat name cannot express "multiple tasks on one site, each with variations",
   which is the normal case, not the exception.
2. **`baseline` is per *variant*, not per recipe.** This is the load-bearing
   one. Two slices of the same task legitimately differ in fill rate — an
   "engineering remote" listing always shows salary, "design onsite" rarely
   does. A shared baseline reads the sparse slice as permanently stale and
   evicts it after three runs.
3. **`steps` are recorded and shown back, never replayed by the server.**
   Skyvern's code-caching replays actions; here that would fire real side
   effects on the user's live logged-in profile, and Layer A's fingerprint
   healing makes it worse — healing relocates a stale `#send` onto whatever now
   scores highest. Steps come back as dated observations; the model reissues
   them itself. Deterministic replay stays a separate PR behind a confirm gate.
4. **Recording is gated and the store never learns from a bad run.** A quality
   bar (>= 3 rows, no boundary/no-match warnings, anchor drop < 50%, one field
   at >= 50% fill, spec under 4 KB / 50 fields) decides what is worth keeping,
   and steps flush only when the terminating extract clears it. That is *why* a
   side-effecting flow like "apply to job" can never enter the store: it does
   not end in an extraction. The safety property is a consequence of the shape
   rather than a check anyone has to remember.

**Two traps worth keeping written down:**

- **The ratchet.** A hydrated replay must never write `baseline`. Allowed to,
  a site that decays slightly each week walks its own bar down, every replay
  looks fine against the last one, and staleness never fires again. The
  signature is a replay that reports stale once and clean afterwards, which is
  why LB4 re-runs the same degraded page a second time.
- **Fail-open staleness.** `collapsed()` first read an omitted tolerance as
  "check disabled". Invisible in `extract-all.js`, which always passes a
  destructured default — but the recipe path is a new caller, and a rotted
  recipe would have reported clean forever. It now defaults and disables only
  on an explicit `<= 0`.

### Layer C — Semantic/embedding recall (priority #3) — the weight decision
**Finding:** LaVague runs embedding-RAG over page structure to retrieve the
relevant slice *before* querying the LLM. (LaVague action-engine.md)

This is the one item that fights "keep it lite" — PolterTab has **2 runtime deps**
and no build step. Options, cheapest first:

- **C0 (do this first): don't embed.** Lexical recall over recipe names and the
  free-text notes (token overlap / BM25-lite, ~30 lines, zero deps) answers "how
  do I do X on site Y" well enough at PolterTab's scale — one file per host, a
  handful of recipes. Ship it; measure before adding vectors.
- **C1 (only if C0 proves weak): hosted embeddings, no local model.** Embed at
  save/recall time, store vectors as plain JSON floats, cosine in JS. Adds a
  network dep and a key, not a heavy local runtime.
- **C2 (avoid): local embedding model / vector DB.** transformers.js or a WASM
  model is tens of MB — the whole "lite" property gone for a feature C0 likely
  covers.

Recommendation: **A and B first, ship C0, gate C1/C2 behind a measured need.**
~90% of the recall value for ~0 KB, and the door stays open.

---

## CAPTCHA / anti-bot — narrow but clear

Research was thin (one surviving claim): Skyvern's CAPTCHA solvers, proxies and
anti-bot are **cloud-only, excluded from the open-source core**.
(github.com/skyvern-ai/skyvern) No open-source solving technique was extractable.

For PolterTab the answer is unusually clean, because it drives the user's **real,
logged-in Chrome profile**:

- **Fingerprint spoofing is moot** — the user's genuine profile *is* the
  fingerprint. Don't add stealth machinery.
- **Solver services are the wrong call** — shipping an authenticated session's
  challenge to a third party is an ethics/ToS hazard. Don't.
- **Human-in-the-loop handoff is the viable pattern.** Detect a CAPTCHA, pause,
  and hand control back to the user who is sitting right there.

**Do (small):** a detection check for the known widget iframes/containers
(`iframe[src*="recaptcha"]`, `[src*="hcaptcha"]`,
`[src*="challenges.cloudflare"]` / Turnstile). When a click/fill/extract stalls,
run it; if positive, return a distinct `blocked_by_captcha` status so the calling
model says "solve the CAPTCHA in your browser and I'll continue" instead of
thrashing. Detection is cheap and selector-based; no solving, no deps. (Detection
specifics were **not** in the research — this is a pragmatic minimum, to be tuned
against real challenges.)

---

## Form filling — incremental

`browser_fill` is single-field: no multi-field orchestration, no
select/checkbox/radio handling, no file upload. Skyvern's form strength is its
vision loop — too heavy to copy. Lite path:

- Extend `fill` to handle `<select>` (set value + dispatch `change`) and
  checkbox/radio (set `checked`), gated by §1's actionability check.
- Multi-field: a thin `browser_fill_form({fields})` that loops single fills with
  the gate between each — no new engine, just batching.
- Field auto-mapping (label/placeholder/aria → value) can reuse snapshot's
  role/name/placeholder data (§5) later; not needed for v1.

---

## Original sequencing (with outcomes)

1. **Actionability gate + `pollUntil`** (§1, §2) — ✅ #11/#14
2. **Wire up or delete `@e` ref** (§6) — ✅ no-op, claim was wrong
3. **Memory Layer A: fingerprint self-healing** (§3, §4, §5) + dedup/cap/flags — ✅ #12/#13/#14
4. **Memory Layer B: learned recipes** — 🟡 code done (178/178), LB1-LB5 pending
5. **`smart_scroll` real primitive** (§7) + **CAPTCHA detect + handoff** — ⬜ next
6. **Form filling extensions** — ⬜
7. **Semantic recall C0**; revisit C1 only on measured need — ⬜

Everything above is pure JS on the existing 2-dep footprint except C1/C2, which
are explicitly gated. Robustness compounds because each healed selector and
recipe writes back — the tool gets more reliable per site the more it is used.

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

**Research gaps (flagged for honesty):** Scrapling's stealth internals;
Playwright's iframe / shadow / virtualized-scroll specifics; concrete CAPTCHA
detection signatures; whether Skyvern runs on Playwright under the hood
(verification errored, unconfirmed). The CAPTCHA selectors and the §7 scroll
approach are pragmatic proposals, not research-backed specifics.

## Coverage lesson from shipping this

The browser fixture for §1 claimed T5 passing "proves `pollUntil` waits for
actionability". It did not: the gate's polling was unreachable in production (the
frame-0 `_noWait` probe gave it a zero timeout and the resulting error was not
treated as a frame-search miss), and T5's own log order is equally explained by
the click simply landing after the 2.5 s timer. It passed without exercising the
path it claimed to prove.

More generally, the three defects that survived to a code review all survived
because the **test harness was more forgiving than a browser**: the fake
`elementFromPoint` did not retarget shadow-DOM hits, elements had no
`getRootNode`, and `scrollIntoView` was synchronous. A fake that is wrong in the
direction of "everything works" hides exactly the bugs worth catching. See
`plans/review-findings-11-12-13.md`.
