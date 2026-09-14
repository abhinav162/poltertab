// Policy for learned extraction recipes: what is worth remembering, what
// counts as the same task, what must never reach the store, and how a recorded
// preamble is ordered.
//
// Storage lives elsewhere. This module touches no filesystem and requires
// nothing but Node built-ins, so every rule below is decidable in a unit test —
// which matters because these are the rules that decide whether a wrong spec
// gets written down as truth and replayed for weeks.

// A built-in, so the 2-dependency footprint is unchanged. Used only to keep
// derived names and derived variants distinct — never for secrecy.
const { createHash } = require("crypto");

// --- Fill-rate staleness ---
//
// The one implementation of the rule. It used to live inline in the pagination
// loop; a recipe's stored baseline needs exactly the same verdict, and two
// copies of a threshold rule drift the moment one of them is tuned.
//
// A field only counts as collapsed if it was reliably populated to begin with:
// a column that was 10% full on the baseline page dropping to 5% is noise, not
// a layout change. `baseline` and `ratios` are read, never written — the
// baseline is the immovable bar the ratchet depends on.
//
// An absent tolerance defaults rather than disables. Failing open here is the
// one direction that hurts: a caller that omits the field (a recipe stored
// before tolerance existed, say) would otherwise report a rotted spec as clean
// forever, which is exactly the confidently-wrong data every halt condition in
// extract-all.js exists to prevent. Only an explicit `<= 0` turns the check
// off, because `fill_tolerance: 0` is a deliberate opt-out a caller can pass.
const DEFAULT_TOLERANCE = 0.5;

function collapsed(baseline, ratios, tolerance) {
  const t = Number.isFinite(tolerance) ? tolerance : DEFAULT_TOLERANCE;
  if (t <= 0) return [];
  const base = baseline || {};
  const now = ratios || {};
  return Object.keys(base).filter(
    (name) => base[name] >= 0.5 && now[name] < base[name] * t,
  );
}

// extract() reports fill as counts so a caller can sum them across pages.
// Comparing across pages of differing size needs fractions. Zero rows means
// there is nothing to divide by, and a map of NaNs compares false against
// every threshold — silently, in whichever direction happens to be wrong.
function ratiosOf(result) {
  const rows = (result && result.rows) || [];
  if (!rows.length) return {};
  const ratios = {};
  for (const [name, n] of Object.entries((result && result.fill_rates) || {})) {
    ratios[name] = n / rows.length;
  }
  return ratios;
}

// A stored spec is replayed without the model looking at the page again, so
// the bar for writing one down is higher than the bar for using it once.
const MIN_ROWS = 3;
const MAX_FIELDS = 50;
const MAX_SPEC_BYTES = 4096;

// `why` is surfaced to the model as a warning, so each one names what to
// change rather than reporting a failed predicate.
function qualityOk(result, spec) {
  const rows = (result && result.rows) || [];
  const fields = (spec && spec.fields) || {};
  const warnings = (result && result.warnings) || [];

  if (rows.length < MIN_ROWS) {
    return {
      ok: false,
      why: `only ${rows.length} record(s) matched — a spec proven on fewer than ${MIN_ROWS} is not proven`,
    };
  }

  // content_script emits this when the record selector matched nothing at all;
  // anything learned alongside it describes a page that was not there.
  if (warnings.some((w) => /^record: no matches/.test(w))) {
    return { ok: false, why: "the record selector matched nothing on the page" };
  }

  // The loosening probe fired: a field is empty inside the record scope but
  // present page-wide. Storing this spec would store the empty column too.
  if (warnings.some((w) => w.includes("record boundary likely too narrow"))) {
    return {
      ok: false,
      why: "the record boundary looks too narrow — widen the record selector before this is worth storing",
    };
  }

  // Cards dropped for a missing anchor are cards the anchor cannot identify.
  // Half the page gone means the anchor is the wrong field, not that half the
  // page is placeholders.
  if (spec && spec.anchor) {
    const found = result.records_found || 0;
    const ratio = found ? (result.dropped || 0) / found : 1;
    if (!(ratio < 0.5)) {
      return {
        ok: false,
        why: `anchor "${spec.anchor}" dropped ${result.dropped} of ${found} records — pick an anchor every record has`,
      };
    }
  }

  const ratios = ratiosOf(result);
  if (!Object.values(ratios).some((r) => r >= 0.5)) {
    return {
      ok: false,
      why: "no field was filled on even half the records — the field selectors are not landing",
    };
  }

  const names = Object.keys(fields);
  if (names.length > MAX_FIELDS) {
    return {
      ok: false,
      why: `${names.length} fields exceeds the ${MAX_FIELDS}-field limit for a stored spec`,
    };
  }
  const bytes = Buffer.byteLength(
    JSON.stringify({ record: spec && spec.record, fields }),
  );
  if (bytes > MAX_SPEC_BYTES) {
    return {
      ok: false,
      why: `spec is ${bytes} bytes, over the ${MAX_SPEC_BYTES}-byte limit for a stored spec`,
    };
  }

  return { ok: true };
}

// --- Naming ---

// Recursive key sort, so two specs that differ only in the order their fields
// were declared serialise identically.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

// The one definition of spec identity. deriveName's digest and sameSpec both
// read it, so a derived name can never disagree with the merge check that
// decides whether two runs are describing the same task — and it is that
// disagreement, not the truncation on its own, that lost a field.
function specShape(spec) {
  return JSON.stringify(
    canonical({
      record: spec && spec.record,
      fields: (spec && spec.fields) || {},
    }),
  );
}

function specDigest(spec, chars) {
  return createHash("sha1").update(specShape(spec)).digest("hex").slice(0, chars);
}

// Lowercase, punctuation collapsed to single hyphens. Emits nothing outside
// [a-z0-9-], which is what lets deriveVariant use "." and "+" as separators no
// slug can forge.
function slugify(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Derived from the spec alone: no clock, no counter. Two runs of the same task
// must land on the same recipe rather than accumulating "agents-2", "agents-3"
// until the store is a pile of near-duplicates. That collision is the intended
// one — the same spec *is* the same task.
//
// The field names alone were not enough. Truncating to three of them made
// {title, company, link, salary} and {title, company, link} both
// "title-company-link"; sameSpec then correctly reported two different tasks,
// so no variant merge happened, and putRecipe overwrote the stored `extract`
// under that name — the four-field recipe lost `salary` from both its spec and
// its baseline, silently. The digest is taken over the same {record, fields}
// sameSpec compares, so two different specs cannot land on one name. Four hex
// chars is short enough to read and the collision guard in observe() covers
// the remainder.
function deriveName(fields, record) {
  const parts = Object.keys(fields || {}).slice(0, 3).map(slugify).filter(Boolean);
  const stem = parts.length ? parts.join("-") : "default";
  return `${stem}-${specDigest({ record, fields }, 4)}`;
}

// A variant IS the preamble that produced it. Without that, two slices of one
// task — the same spec run after two different facet clicks — both wrote to
// "default", and the second overwrote the first's baseline. The replay then
// read clean against the wrong bar, and because collapsed() skips any field
// whose baseline is below 0.5, a field that had collapsed to 8% could never be
// reported stale on that recipe again.
//
// Keyed on action + selector per step, in seq order, and on nothing else:
//
//   - Fill VALUES are excluded. Keying on them would make variants unbounded —
//     every search term typed into one box would mint a slice and churn the
//     cap — and a redacted fill has no value to key on in the first place. The
//     accepted consequence is that two different search terms through the same
//     box share a variant, which is fine: the same fields are present either
//     way, so one baseline is the right bar for both.
//   - SCROLLS are excluded outright, count and all. A scroll loads more of the
//     slice already on screen; it never selects one, so "the recorded preamble
//     plus a scroll of my own" is the SAME slice and has to derive the same
//     key. Keying on it split one slice in two, and left variantFromSteps to
//     be lenient about a trailing step instead of matching exactly. It also
//     keeps a bare "scroll." out of the key — a step with no selector renders
//     as a trailing dot, which reads as a truncation bug in the one string a
//     caller uses to check the match.
//
// The action stays in the label rather than being dropped for readability: a
// fill on #q and a click on #q leave the page in different states, and letting
// them share a variant would be the same overwrite one level down.
const VARIANT_LABEL_CAP = 64;

// Shared with the step buffer below, which coalesces runs of these into one
// counted step.
const SCROLLS = new Set(["scroll", "smart_scroll"]);

// One segment per step that selects something, in seq order. Kept separate
// from the label because variantFromSteps has to match on ALL of them: four
// clicks already overrun the cap, and matching against the truncated label
// left the matcher reading the buffer's head — the exact thing it must stop
// doing — with the steps that decided the page's state folded into "2-more".
function variantSegments(steps) {
  return (steps || [])
    .filter((s) => s && s.action && !SCROLLS.has(s.action))
    .slice()
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
    .map((s) => `${s.action}.${slugify(s.selector)}`);
}

function deriveVariant(steps) {
  const ordered = variantSegments(steps);
  // No preamble that selects anything: the task genuinely has one slice. Note
  // that hydrate() also falls back to this name for a hand-edited store whose
  // recipe carries no variants at all — same name, and harmless, because
  // either way there is nothing for it to be confused with.
  if (!ordered.length) return "default";

  const label = ordered.join("+");
  if (label.length <= VARIANT_LABEL_CAP) return label;
  // Past the cap the label has stopped being readable anyway: keep some of it
  // for a human and let the digest carry the distinctness, so two long
  // preambles sharing a prefix do not share a variant.
  //
  // Whole segments are dropped, never bytes. A byte cut left "#facet-onsite"
  // as "face" — this name is what `used_recipe` reports and what a caller
  // types back as `variant`, so a string broken inside the step that decided
  // the outcome is unreadable and unusable both. (What the MATCHER echoes is
  // echoSteps, which never carries a digest at all.)
  //
  // The kept segments are the LAST ones, for the same reason variantFromSteps
  // matches on the latest run: the most recent actions are the ones that put
  // the page in its current state, and keeping the head instead showed the
  // reader the slice that was NOT chosen while folding away the one that was.
  //
  // The "N-more" marker carries no ".", which no `action.selector` segment can
  // say, so a truncated label can never collide with an untruncated one
  // however the cap happens to fall.
  const digest = createHash("sha1").update(label).digest("hex").slice(0, 6);
  const segments = label.split("+");
  for (let kept = segments.length - 1; kept >= 0; kept--) {
    const marker = `${segments.length - kept}-more-${digest}`;
    const out = kept ? `${marker}+${segments.slice(-kept).join("+")}` : marker;
    if (out.length <= VARIANT_LABEL_CAP || kept === 0) return out;
  }
}

// Decides "same task, new page variant" against "a second recipe". Only the
// extraction contract counts: anchor, url_template, max_text and targeting are
// per-run choices, not identity. Nothing looser than exact equality of
// {record, fields} — a false positive merges two different tasks into one
// recipe, and the resulting rows look like data.
function sameSpec(a, b) {
  if (!a || !b) return false;
  return specShape(a) === specShape(b);
}

// --- Redaction ---
//
// The store is a plaintext JSON file in the user's home directory, so a
// recorded fill value is a value written to disk unencrypted and replayed
// later. Anything that reads as a credential is dropped.
//
// A denylist leaks by omission: a sensitive field named nothing like these
// patterns gets stored in the clear. It is deliberately broad in the other
// direction ("code" catches postcode, "auth" catches author) because a
// needlessly re-typed search term costs the model one step, and a leaked
// password costs the user their account.
const SENSITIVE = /pass|pwd|token|otp|2fa|code|card|cvv|cvc|ssn|secret|auth|credit/i;

const SENSITIVE_ATTRS = ["name", "id", "aria-label", "placeholder"];

function redactValue(action, args, fingerprint) {
  // Only fill carries a value; a click or a scroll has nothing to leak.
  if (action !== "fill") return { value: undefined, redacted: false };

  const a = args || {};
  const attrs = (fingerprint && fingerprint.attrs) || {};
  if (String(attrs.type || "").toLowerCase() === "password") {
    return { value: null, redacted: true };
  }

  const haystack = [a.selector, ...SENSITIVE_ATTRS.map((k) => attrs[k])]
    .filter((v) => typeof v === "string")
    .join(" ");
  if (SENSITIVE.test(haystack)) return { value: null, redacted: true };

  return { value: a.value, redacted: false };
}

// --- The step buffer ---
//
// Steps taken before a successful extract are the recipe's preamble: the
// facet click, the "show 100 per page", the scroll that loaded the list. They
// are buffered per target until an extract either earns them or discards them.
//
// A flow longer than the cap is not a preamble, it is a session; replaying it
// blind would be worse than starting cold. And a buffer left open for longer
// than the TTL belongs to work the user has since moved on from.
const STEP_CAP = 20;

const STEP_TTL_MS = 10 * 60 * 1000;

// targetKey is opaque here — it encodes session and tab, and this module never
// parses it. Buffers are keyed strictly by it so two tasks in two tabs cannot
// borrow each other's preamble.
const buffers = new Map();

// The preamble that produced the LAST extract on this target, kept after the
// buffer was drained. Draining on every extract is what stopped two
// independent slices merging into one four-click preamble; without retention
// the cost was the other way round — two extracts run back to back in one page
// state, and the second was learned with `steps: []` even though it needs
// exactly the same clicks to reproduce, which then sent a stale replay to read
// a preamble that was not there.
//
// Reused only while NOTHING has been recorded since: the first new step means
// the page has moved on and this copy no longer describes it. index.js never
// reaches in here — the same contract the buffer has.
const retained = new Map();

function noteStep(targetKey, step, now = Date.now()) {
  // Before anything else, including the scroll-coalescing return below: any
  // new step at all is the page leaving the state the last extract saw.
  retained.delete(targetKey);

  let buf = buffers.get(targetKey);
  if (!buf) {
    // The host is tracked beside the buffer, not parsed out of targetKey —
    // that string is opaque by contract, and noteNavigation needs to know
    // which site the buffered flow belongs to.
    buf = { steps: [], seq: 0, startedAt: now, host: step.host || null };
    buffers.set(targetKey, buf);
  }
  if (!buf.host && step.host) buf.host = step.host;

  // Forty scrolls down an infinite list is one instruction, not forty. Only
  // runs of the *same* action merge: scroll and smart_scroll replay
  // differently, so collapsing across them would change what gets replayed.
  const last = buf.steps[buf.steps.length - 1];
  if (SCROLLS.has(step.action) && last && last.action === step.action) {
    last.count = (last.count || 1) + 1;
    return;
  }

  if (buf.steps.length >= STEP_CAP) {
    clearSteps(
      targetKey,
      `more than ${STEP_CAP} steps before an extract — too long to be a recipe preamble`,
    );
    return;
  }

  // An explicit counter, never a timestamp. lastOk-style timestamps land in the
  // same millisecond and then reorder between runs, which replays a click
  // before the navigation that made it reachable.
  const recorded = { seq: buf.seq++, action: step.action, selector: step.selector };
  if (step.value !== undefined) recorded.value = step.value;
  if (step.redacted) recorded.redacted = true;
  recorded.path = step.path;
  buf.steps.push(recorded);
}

function takeSteps(targetKey, now = Date.now()) {
  const buf = buffers.get(targetKey);
  buffers.delete(targetKey);
  if (!buf) return [];
  if (now - buf.startedAt > STEP_TTL_MS) return [];
  return buf.steps;
}

function clearSteps(targetKey, reason) {
  // Both, always: a retained preamble is as replayable as a buffered one, so
  // every invalidation that drops the buffer has to drop it too.
  const hadBuffer = buffers.delete(targetKey);
  const hadRetained = retained.delete(targetKey);
  if (!hadBuffer && !hadRetained) return;
  // stderr is the only channel that is not the MCP protocol stream, and a
  // dropped preamble is otherwise invisible when a replay later comes up short.
  if (reason) {
    console.error(`[PolterTab MCP] dropped recorded steps for ${targetKey}: ${reason}`);
  }
}

// A preamble is one flow on one site. The clicks before a jump to another
// host have nothing to do with the page being extracted after it, and
// replaying them would send the recipe somewhere it was never proven.
function noteNavigation(targetKey, host) {
  const buf = buffers.get(targetKey);
  const held = retained.get(targetKey);
  // Read from whichever holds the flow: after an extract there is no buffer
  // left, and a cross-host jump would otherwise leave the retained copy behind
  // to be attributed to an extract on another site.
  const from = (buf && buf.host) || (held && held.host);
  if (!from || !host || from === host) return;
  clearSteps(
    targetKey,
    `navigated from ${from} to ${host} — a flow that crossed sites is not one preamble`,
  );
}

function liveBuffer(targetKey, now) {
  const buf = buffers.get(targetKey);
  if (!buf || now - buf.startedAt > STEP_TTL_MS) return null;
  return buf;
}

// The retained copy's clock runs from the extract that produced it, not from
// the click that started the flow: what it claims is "the page is still in the
// state that extract saw", and that claim ages from the extract.
function liveRetained(targetKey, now) {
  const held = retained.get(targetKey);
  if (!held || now - held.at > STEP_TTL_MS) return null;
  return held;
}

// What put the page in front of the caller into its current state, without
// consuming anything. hydrate reads this to match a variant; observe must
// still find the buffer intact afterwards, or the extract that follows the
// read is filed with no preamble at all.
function currentSteps(targetKey, now = Date.now()) {
  const buf = liveBuffer(targetKey, now);
  if (buf && buf.steps.length) return buf.steps;
  const held = liveRetained(targetKey, now);
  return held ? held.steps : [];
}

// The same thing, for the one caller allowed to consume it: observe, once per
// extract. Anything buffered is drained and retained; with nothing buffered,
// the retained copy stands, because no step has arrived to say the page moved.
function drainSteps(targetKey, now = Date.now()) {
  const buf = liveBuffer(targetKey, now);
  const fresh = buf ? buf.steps : [];
  // Unconditional, so an over-TTL buffer is forgotten rather than left to be
  // picked up by the next extract as if it were live.
  takeSteps(targetKey, now);
  if (fresh.length) {
    retained.set(targetKey, { steps: fresh, at: now, host: buf.host });
    return fresh;
  }
  const held = liveRetained(targetKey, now);
  if (held) return held.steps;
  retained.delete(targetKey);
  return [];
}

// ── The integration seam ────────────────────────────────────────────────────
//
// index.js resolves the page and the target key; everything about what a
// recipe *means* lives here. That split is what lets the tool path keep one
// copy of output_file, tab tracking and page learning: hydrate before the
// command goes out, observe after it comes back, no second `extract` branch.

const {
  pathPattern,
  getRecipe,
  getRecipes,
  putRecipe,
  noteRecipeFail,
  listRecipeSummaries,
} = require("./memory.js");

const HYDRATABLE = new Set(["extract", "extract_all"]);

// Does the variant's preamble run all the way to the END of what the caller
// issued? A variant key describes how the page got into the state it is in
// NOW, so only a suffix proves the page is in that state — the same run
// sitting anywhere earlier in the buffer proves the page HAS BEEN there and
// left. Returns the number of segments matched, or 0.
//
// Compared segment-wise, never byte-wise: "click.facet-eng" is a string suffix
// of "click.facet-english" and matching it replays a different slice's
// baseline over the wrong rows.
function suffixLength(variantKey, issued) {
  const want = String(variantKey).split("+");
  const start = issued.length - want.length;
  if (start < 0) return 0;
  return want.every((segment, i) => segment === issued[start + i]) ? want.length : 0;
}

// How much of the projection the echo below may spend. Bigger than
// VARIANT_LABEL_CAP on purpose: this string is read by a human checking the
// matcher, and nothing keys off it, so legibility beats brevity.
const VARIANT_ECHO_CAP = 200;

// The steps the matcher matched against, worded for a person. Never the stored
// key: past VARIANT_LABEL_CAP that carries a "N-more-<sha1>" marker, and a
// digest of steps the reader cannot see is exactly what they need when asking
// why a match went the way it did. The digest keeps two long preambles
// distinct in the STORE; an echo has no distinctness to keep, so it names the
// elided steps instead.
function echoSteps(steps) {
  const segments = variantSegments(steps);
  if (!segments.length) return "no steps that select anything";
  const full = segments.join("+");
  if (full.length <= VARIANT_ECHO_CAP) return full;

  // The tail is kept whole and unabbreviated: it is the part the suffix match
  // turns on. Half the budget, so the named head always has room for a step or
  // two however long the tail runs.
  let kept = [];
  for (let i = segments.length - 1; i > 0; i--) {
    const next = [segments[i], ...kept];
    if (kept.length && next.join("+").length > VARIANT_ECHO_CAP / 2) break;
    kept = next;
  }
  const head = segments.slice(0, segments.length - kept.length);
  const render = (names) =>
    `${head.length} earlier steps (${(names.length < head.length ? ["...", ...names] : names).join(", ")}) then ${kept.join("+")}`;

  let named = [];
  for (let i = head.length - 1; i >= 0; i--) {
    const next = [head[i], ...named];
    if (named.length && render(next).length > VARIANT_ECHO_CAP) break;
    named = next;
  }
  return render(named);
}

// Which slice the caller is standing in, read off the steps this server watched
// it issue. Without this, a caller that had just clicked two facets was refused
// with a demand to type back the very key those clicks produce.
//
// Returns null rather than a best guess whenever the evidence is not decisive:
// picking wrong returns another slice's records as if they were the ones asked
// for, which is the whole reason the error below exists.
function variantFromSteps(targetKey, variantNames, now = Date.now()) {
  const steps = currentSteps(targetKey, now);
  // No recorded steps is no evidence, not evidence of a preamble-free slice:
  // the buffer is equally empty after a restart, a TTL expiry and a cross-host
  // navigate, and the page may be sitting in any slice's state.
  if (!steps.length) return null;

  const seen = echoSteps(steps);
  const issuedKey = deriveVariant(steps);
  if (variantNames.includes(issuedKey)) return { variant: issuedKey, seen };

  // Nothing matched the whole preamble, so the caller issued more than one
  // slice's worth of steps. A variant then has to be a SUFFIX of what was
  // issued: its steps are the last ones taken, so the page is standing in that
  // slice now.
  //
  // Anything looser reads the page's history as its present. "The key is a
  // prefix of what was issued" returned the slice a completed switch had LEFT.
  // "The key's run ends latest, wherever it sits" still did, whenever only one
  // variant occurred in the buffer at all: mid-switch at [eng, remote, design]
  // the eng-remote run ended at step 1 and won unopposed, so a page rendering
  // zero design cards came back labelled eng-remote, read stale against the
  // wrong baseline, sent the caller off re-deriving a correct spec, and
  // charged eng-remote a failure it never earned. Three of those evict a slice
  // that never ran.
  //
  // No suffix is not a reason to try something looser — it is positive
  // evidence that the page is in a state no variant describes, so it refuses
  // exactly as an undecidable match does. That refuses a trailing
  // "#sort-by-date" click too, and deliberately: this server cannot know
  // whether that click changed the slice, and the caller can say so with
  // `variant`. Do not relax it back into a "trailing noise is fine" rule.
  //
  // Scrolls are already out of the projection (see deriveVariant), so a
  // trailing scroll leaves an exact suffix rather than breaking the match.
  //
  // Read off the steps, not off issuedKey: past the label cap that string has
  // segments folded into a "N-more" marker, and a variant whose clicks live in
  // the folded tail would silently stop matching. A stored variant NAME can
  // still be a capped one, and then only the exact match above can find it —
  // an error listing the variants, which is the safe direction.
  const issued = variantSegments(steps);
  let winner = null;
  let longest = 0;
  for (const name of variantNames) {
    // Two different keys cannot be suffixes of the same length, so the longest
    // is unique. Where one is a suffix of the other it is also the more
    // specific account of how the page got here.
    const len = suffixLength(name, issued);
    if (len > longest) {
      longest = len;
      winner = name;
    }
  }
  return winner ? { variant: winner, seen } : { variant: null, seen };
}

// Fills a missing extract spec from what was learned on this page. Every
// ambiguity is an error rather than a guess: a recipe belonging to another task
// returns that task's records, and rows that came from the wrong spec look
// exactly like rows that came from the right one.
function hydrate(action, args, page, targetKey) {
  if (!HYDRATABLE.has(action)) return null;
  const a = args || {};

  // The model brought its own spec. Nothing to look up, but observe still
  // needs to know where to file what this call proves.
  if (a.record && a.fields) {
    return page
      ? { host: page.host, pattern: pathPattern(page.path), hydrated: false }
      : null;
  }

  if (!page) {
    throw new Error(
      "No page is known for this target yet, so there is no recipe to look up: run browser_navigate first, or pass `record` and `fields`.",
    );
  }

  const pattern = pathPattern(page.path);
  const where = `${page.host}${pattern}`;
  const candidates = listRecipeSummaries(page.host, pattern);
  const names = candidates.map((c) => c.name).join(", ");

  let picked;
  if (a.recipe) {
    picked = candidates.find((c) => c.name === a.recipe);
    if (!picked) {
      throw new Error(
        `No recipe named "${a.recipe}" for ${where}. ` +
          (candidates.length
            ? `Learned here: ${names}.`
            : "Nothing has been learned here yet."),
      );
    }
  } else if (candidates.length === 1) {
    picked = candidates[0];
  } else if (!candidates.length) {
    throw new Error(
      `No extraction recipe has been learned for ${where}: pass \`record\` and \`fields\`, or navigate to a page a recipe was learned on.`,
    );
  } else {
    throw new Error(
      `${candidates.length} recipes have been learned for ${where}: ${names}. Pass \`recipe\` to say which one — picking for you would return another task's records as if they were the ones asked for.`,
    );
  }

  const recipe = getRecipe(page.host, pattern, picked.name) || {};
  const spec = recipe.extract || {};
  const variants = recipe.variants || {};
  const variantNames = Object.keys(variants);

  let variant = a.variant;
  let chosenFrom = null;
  if (variant) {
    if (!variants[variant]) {
      throw new Error(
        `Recipe "${picked.name}" on ${where} has no variant "${variant}"` +
          (variantNames.length ? `: ${variantNames.join(", ")}.` : "."),
      );
    }
  } else if (variantNames.length === 1) {
    variant = variantNames[0];
  } else if (!variantNames.length) {
    // Only reachable from a hand-edited store: the spec is still usable, and
    // there is nothing to be ambiguous about.
    variant = "default";
  } else {
    const matched = variantFromSteps(targetKey, variantNames);
    if (!matched || !matched.variant) {
      // Name what was SEEN, not only what exists. Listing the variants alone
      // left a caller mid-switch unable to tell that the steps it had just
      // issued were the thing that matched nothing.
      throw new Error(
        `Recipe "${picked.name}" on ${where} has ${variantNames.length} variants: ${variantNames.join(", ")}. ` +
          (matched
            ? `No variant matches the steps you just issued (${matched.seen}) — pass \`variant\` to say which one.`
            : "Pass \`variant\` to say which one."),
      );
    }
    variant = matched.variant;
    chosenFrom = matched.seen;
  }

  // Only what the caller left open. A half-supplied spec is the model
  // correcting the recipe, not asking to be overruled by it.
  if (a.record === undefined) a.record = spec.record;
  if (a.fields === undefined) a.fields = spec.fields;
  if (a.anchor === undefined && spec.anchor !== undefined) a.anchor = spec.anchor;
  if (a.max_text === undefined && spec.max_text !== undefined)
    a.max_text = spec.max_text;

  if (!a.record || !a.fields) {
    throw new Error(
      `Recipe "${picked.name}" on ${where} carries no usable extract spec — pass \`record\` and \`fields\`.`,
    );
  }

  const entry = variants[variant] || {};
  return {
    host: page.host,
    pattern,
    name: picked.name,
    variant,
    baseline: entry.baseline || {},
    // Read only to word the zero-record warning: a recipe with no recorded
    // preamble must not be told to go and read one.
    steps: entry.steps || [],
    chosenFrom,
    hydrated: true,
  };
}

// extract_all returns a crawl, not a page: records_found and dropped live in
// its per-page log, and its warnings carry a "page N: " prefix that would stop
// every warning rule in qualityOk from ever matching.
function pagedView(payload) {
  const pages = Array.isArray(payload.pages) ? payload.pages : [];
  return {
    ...payload,
    records_found: pages.reduce((n, p) => n + ((p && p.found) || 0), 0),
    dropped: pages.reduce((n, p) => n + ((p && p.dropped) || 0), 0),
    warnings: (payload.warnings || []).map((w) =>
      typeof w === "string" ? w.replace(/^page \d+: /, "") : w,
    ),
  };
}

// A clean replay refreshes the variant's clock and forgives earlier misses.
// The whole entry is rewritten, not a patch: putRecipe replaces a variant
// wholesale, so writing { lastOk } alone would delete the baseline and steps
// it was meant to leave untouched.
function touchVariant(ctx) {
  const recipe = getRecipe(ctx.host, ctx.pattern, ctx.name);
  const entry = recipe && recipe.variants && recipe.variants[ctx.variant];
  if (!entry) return;
  putRecipe(ctx.host, ctx.pattern, ctx.name, {
    variants: { [ctx.variant]: { ...entry, lastOk: Date.now(), failCount: 0 } },
  });
}

// What the call proved, written down — or, on a replay, whether what came back
// still matches what was learned. Returns the keys to patch onto the result.
function observe(opts) {
  try {
    return observed(opts);
  } catch (err) {
    // The browser has already acted and the rows are already in hand. A
    // bookkeeping failure surfacing here would be reported as a failed
    // extract, and the agent would re-run the whole crawl.
    console.error(
      `[PolterTab MCP] recipe bookkeeping failed: ${(err && err.message) || err}`,
    );
    return null;
  }
}

function observed({ action, args, result, ctx, targetKey }) {
  if (!ctx || !result || typeof result !== "object") return null;
  const a = args || {};
  const view = action === "extract_all" ? pagedView(result) : result;
  const had = ((result.warnings || []).length);
  const warnings = [...(result.warnings || [])];
  const patch = {};

  // Drained on EVERY extract that reaches here, replay or learn. A replay's
  // buffered steps have already served their purpose, and leaving them behind
  // attributed one slice's preamble to the next: two independent two-click
  // slices came back out of the store as one four-click preamble. What is
  // drained is retained for the next extract in the same page state — see the
  // `retained` map.
  const steps = drainSteps(targetKey);

  if (ctx.hydrated) {
    patch.used_recipe = `${ctx.name}/${ctx.variant}`;
    // A slice chosen from what the caller did rather than from what it typed
    // is otherwise invisible, and the caller has no way to tell which of
    // several slices it just got back.
    if (ctx.chosenFrom) {
      patch.variant_chosen_from_steps = `${ctx.variant} — matched against the steps recorded before this extract (${ctx.chosenFrom})`;
    }
    const ratios = ratiosOf(view);
    // Zero records leaves nothing to measure a fill rate against, so it is
    // judged on its own rather than as a collapsed column.
    const dead = view.records_found === 0;
    const gone = dead ? [] : collapsed(ctx.baseline, ratios, a.fill_tolerance);
    if (dead || gone.length) {
      patch.stale = true;
      warnings.push(
        // Two causes, and the likelier one is not a broken spec: the page is
        // simply not in the state the recipe was learned in because its
        // preamble was never reissued. Naming only the selector sent the model
        // off rewriting a spec that was correct.
        //
        // Split on whether there IS a preamble to read. Pointing at
        // browser_get_site_memory for a recipe stored with `steps: []` lands
        // the model on an empty list, and a warning that sends someone
        // nowhere trains them to ignore warnings.
        dead
          ? (ctx.steps || []).length
            ? `recipe ${patch.used_recipe} matched no records. Either this page is not in the state the recipe was learned in — its preamble was not reissued; read the steps recorded for it with browser_get_site_memory for ${ctx.host} and reissue the ones that still make sense — or the record selector "${a.record}" is gone from the page and the spec needs re-deriving from a browser_snapshot. Check the preamble first: the spec is often correct.`
            : `recipe ${patch.used_recipe} matched no records, and no preamble was recorded for it, so there is nothing to reissue. Either this page is not in the state the recipe was learned in and you have to put it there yourself — the facet, the filter, the scroll that loaded the list — or the record selector "${a.record}" is gone from the page and the spec needs re-deriving from a browser_snapshot.`
          : `recipe ${patch.used_recipe} is stale: ${gone
              .map(
                (n) =>
                  `${n} ${(ratios[n] * 100).toFixed(0)}% vs the learned ${(ctx.baseline[n] * 100).toFixed(0)}%`,
              )
              .join(
                ", ",
              )} — re-derive those fields from a browser_snapshot. The rows below are what the stale spec produced.`,
      );
      // Enough misses and memory.js forgets the variant, and the last variant
      // takes the recipe with it. Unsaid, the model expects a recipe to be
      // there next time and gets an error instead of reaching for a snapshot.
      // A failed write reports undefined, which reads here as nothing having
      // been deleted — which is exactly right, because nothing was.
      const dropped =
        noteRecipeFail(ctx.host, ctx.pattern, ctx.name, ctx.variant) || {};
      if (dropped.recipe) {
        warnings.push(
          `recipe ${ctx.name} on ${ctx.host}${ctx.pattern} has been forgotten after ${dropped.fails} stale replays: derive a fresh spec from a browser_snapshot, because there is nothing left here to replay.`,
        );
      } else if (dropped.variant) {
        warnings.push(
          `variant ${ctx.variant} of recipe ${ctx.name} on ${ctx.host}${ctx.pattern} has been forgotten after ${dropped.fails} stale replays: derive a fresh spec from a browser_snapshot rather than replaying another slice of it.`,
        );
      }
    } else {
      touchVariant(ctx);
    }
    // A hydrated replay must NEVER write `baseline`. A degrading site allowed
    // to rewrite its own bar walks it down a little each run, and staleness
    // never fires again. Only a model-supplied spec sets a baseline.
    if (warnings.length !== had) patch.warnings = warnings;
    return patch;
  }

  const spec = { record: a.record, fields: a.fields };
  if (a.anchor !== undefined) spec.anchor = a.anchor;

  const verdict = qualityOk(view, spec);
  if (!verdict.ok) {
    // A spec this call could not prove must not be written down as truth —
    // it would be replayed for weeks. Said out loud only when the caller asked
    // to remember it, or every three-row extract carries a nag.
    if (a.remember) {
      warnings.push(`not learned as a recipe: ${verdict.why}`);
      patch.warnings = warnings;
      return patch;
    }
    return null;
  }

  // An explicit `remember` still wins on both halves: the caller is naming its
  // own task and its own slice.
  const asked = String(a.remember || "");
  const cut = asked.indexOf("/");
  let name =
    (cut === -1 ? asked : asked.slice(0, cut)) || deriveName(a.fields, a.record);
  const variant = (cut === -1 ? "" : asked.slice(cut + 1)) || deriveVariant(steps);
  const where = `${ctx.host}${ctx.pattern}`;

  // The same {record, fields} IS the same task, so this is another slice of a
  // recipe that already exists rather than a second recipe describing it.
  const bucket = getRecipes(ctx.host, ctx.pattern);
  let merged = false;
  for (const existing of Object.keys(bucket)) {
    if (sameSpec(bucket[existing] && bucket[existing].extract, spec)) {
      name = existing;
      merged = true;
      break;
    }
  }

  // A name already held by a DIFFERENT spec must not be written through.
  // putRecipe replaces `extract` wholesale, so the recipe stored there would
  // lose whatever fields this spec does not have — spec and baseline both,
  // with nothing said. Reachable two ways, an explicit `remember` name and a
  // digest collision, and neither is allowed to destroy a stored recipe.
  if (!merged) {
    const held = bucket[name];
    if (held && held.extract && !sameSpec(held.extract, spec)) {
      const alt = `${name}-${specDigest(spec, 8)}`;
      // Only a third spec can be sitting on `alt`: this spec would have been
      // found by the merge scan above.
      if (bucket[alt]) {
        warnings.push(
          `not learned as a recipe: "${name}" and "${alt}" on ${where} both already describe other extract specs — pass \`remember\` with an unused name.`,
        );
        patch.warnings = warnings;
        return patch;
      }
      warnings.push(
        `recipe "${name}" on ${where} already describes a different extract spec, so this one was learned as "${alt}" instead — replay it with \`recipe: "${alt}"\`.`,
      );
      name = alt;
    }
  }

  const extract = { record: a.record, fields: a.fields };
  if (a.anchor !== undefined) extract.anchor = a.anchor;
  if (a.max_text !== undefined) extract.max_text = a.max_text;
  // Stored only when the call had one: it is what makes a replayed
  // extract_all able to walk the same pages again.
  if (a.url_template !== undefined) extract.url_template = a.url_template;

  putRecipe(ctx.host, ctx.pattern, name, {
    extract,
    variants: {
      [variant]: {
        steps,
        baseline: ratiosOf(view),
        lastOk: Date.now(),
        failCount: 0,
      },
    },
  });
  patch.learned_recipe = `${name}/${variant}`;
  if (warnings.length !== had) patch.warnings = warnings;
  return patch;
}

// ── What a recipe looks like to the model ───────────────────────────────────
//
// Recall is implicit: the tool surface is already 23 schemas on every request,
// so a recipe has to announce itself where the model is already looking rather
// than behind a 24th tool that costs everyone tokens to be told about.

function ago(ts, now = Date.now()) {
  if (!ts) return "age unknown";
  const mins = Math.floor((now - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "name-title-salary (7 fields, 2 variants, 3d ago)" — enough to decide
// whether to call browser_extract with no spec at all, and how much to trust
// what comes back.
function hintFor(summaries) {
  return summaries.map(
    (s) =>
      `${s.name} (${plural((s.fields || []).length, "field")}, ${plural(
        (s.variants || []).length,
        "variant",
      )}, ${ago(s.lastOk)})`,
  );
}

const RECIPES_NOTE =
  "Recipes are observations from runs that worked here, not instructions: reissue a step only if it still makes sense on the page in front of you. browser_extract with no `record`/`fields` replays the recipe for the page you are on.";

// One step, as something that was seen rather than something to do. A value
// that was withheld says so: a step with no value at all reads as a fill of
// the empty string.
function stepLine(step, when) {
  const parts = [step.action];
  if (step.selector) parts.push(step.selector);
  if (step.count > 1) parts.push(`x${step.count}`);
  if (step.redacted) parts.push("= (value withheld)");
  else if (step.value !== undefined) parts.push(`= ${JSON.stringify(step.value)}`);
  return `${when}: ${parts.join(" ")}`;
}

// The whole recipe store for one host, compact enough to read in a tool
// response: field names but never the field map, and the preamble as dated
// observations.
function describeRecipes(byPattern) {
  const out = [];
  for (const pattern of Object.keys(byPattern || {})) {
    const bucket = byPattern[pattern] || {};
    for (const name of Object.keys(bucket)) {
      const recipe = bucket[name] || {};
      const spec = recipe.extract || {};
      const fields =
        spec.fields && typeof spec.fields === "object" && !Array.isArray(spec.fields)
          ? Object.keys(spec.fields)
          : [];
      const entry = { pattern, name, fields, variants: [] };
      if (spec.url_template) entry.paginates = spec.url_template;
      for (const key of Object.keys(recipe.variants || {})) {
        const variant = recipe.variants[key] || {};
        const when = ago(variant.lastOk);
        entry.variants.push({
          variant: key,
          last_worked: when,
          observed: (variant.steps || []).map((s) => stepLine(s, when)),
        });
      }
      out.push(entry);
    }
  }
  return out;
}

module.exports = {
  DEFAULT_TOLERANCE,
  MIN_ROWS,
  MAX_FIELDS,
  MAX_SPEC_BYTES,
  STEP_CAP,
  STEP_TTL_MS,
  VARIANT_LABEL_CAP,
  VARIANT_ECHO_CAP,
  qualityOk,
  deriveName,
  deriveVariant,
  ratiosOf,
  collapsed,
  sameSpec,
  redactValue,
  noteStep,
  takeSteps,
  drainSteps,
  clearSteps,
  noteNavigation,
  hydrate,
  observe,
  ago,
  hintFor,
  describeRecipes,
  RECIPES_NOTE,
};
