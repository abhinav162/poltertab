// Policy for learned extraction recipes: what is worth remembering, what
// counts as the same task, what must never reach the store, and how a recorded
// preamble is ordered.
//
// Storage lives elsewhere. This module touches no filesystem and requires
// nothing but Node built-ins, so every rule below is decidable in a unit test —
// which matters because these are the rules that decide whether a wrong spec
// gets written down as truth and replayed for weeks.

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
//
// Derived from the fields alone: no clock, no counter, no hash. Two runs of the
// same task must land on the same recipe rather than accumulating
// "agents-2", "agents-3" until the store is a pile of near-duplicates. The
// collision is the point — the same field set *is* the same task.
function deriveName(fields) {
  const parts = Object.keys(fields || {})
    .slice(0, 3)
    .map((k) => k.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""))
    .filter(Boolean);
  return parts.length ? parts.join("-") : "default";
}

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

// Decides "same task, new page variant" against "a second recipe". Only the
// extraction contract counts: anchor, url_template, max_text and targeting are
// per-run choices, not identity. Nothing looser than exact equality of
// {record, fields} — a false positive merges two different tasks into one
// recipe, and the resulting rows look like data.
function sameSpec(a, b) {
  if (!a || !b) return false;
  const shape = (s) =>
    JSON.stringify(canonical({ record: s.record, fields: s.fields || {} }));
  return shape(a) === shape(b);
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

const SCROLLS = new Set(["scroll", "smart_scroll"]);

// targetKey is opaque here — it encodes session and tab, and this module never
// parses it. Buffers are keyed strictly by it so two tasks in two tabs cannot
// borrow each other's preamble.
const buffers = new Map();

function noteStep(targetKey, step, now = Date.now()) {
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
  if (!buffers.delete(targetKey)) return;
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
  if (!buf || !buf.host || !host || buf.host === host) return;
  clearSteps(
    targetKey,
    `navigated from ${buf.host} to ${host} — a flow that crossed sites is not one preamble`,
  );
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

// Fills a missing extract spec from what was learned on this page. Every
// ambiguity is an error rather than a guess: a recipe belonging to another task
// returns that task's records, and rows that came from the wrong spec look
// exactly like rows that came from the right one.
function hydrate(action, args, page) {
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
    throw new Error(
      `Recipe "${picked.name}" on ${where} has ${variantNames.length} variants: ${variantNames.join(", ")}. Pass \`variant\` to say which one.`,
    );
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

  if (ctx.hydrated) {
    patch.used_recipe = `${ctx.name}/${ctx.variant}`;
    const ratios = ratiosOf(view);
    // Zero records is not a degraded page, it is the record selector being
    // gone: there is nothing left to measure a fill rate against.
    const dead = view.records_found === 0;
    const gone = dead ? [] : collapsed(ctx.baseline, ratios, a.fill_tolerance);
    if (dead || gone.length) {
      noteRecipeFail(ctx.host, ctx.pattern, ctx.name, ctx.variant);
      patch.stale = true;
      warnings.push(
        dead
          ? `recipe ${patch.used_recipe} is stale: the record selector "${a.record}" matched nothing — re-derive the spec from a browser_snapshot rather than replaying this recipe.`
          : `recipe ${patch.used_recipe} is stale: ${gone
              .map(
                (n) =>
                  `${n} ${(ratios[n] * 100).toFixed(0)}% vs the learned ${(ctx.baseline[n] * 100).toFixed(0)}%`,
              )
              .join(
                ", ",
              )} — re-derive those fields from a browser_snapshot. The rows below are what the stale spec produced.`,
      );
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

  const asked = String(a.remember || "");
  const cut = asked.indexOf("/");
  let name = (cut === -1 ? asked : asked.slice(0, cut)) || deriveName(a.fields);
  const variant = (cut === -1 ? "" : asked.slice(cut + 1)) || "default";

  // The same {record, fields} IS the same task, so this is another slice of a
  // recipe that already exists rather than a second recipe describing it.
  const bucket = getRecipes(ctx.host, ctx.pattern);
  for (const existing of Object.keys(bucket)) {
    if (sameSpec(bucket[existing] && bucket[existing].extract, spec)) {
      name = existing;
      break;
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
        steps: takeSteps(targetKey),
        baseline: ratiosOf(view),
        lastOk: Date.now(),
        failCount: 0,
      },
    },
  });
  patch.learned_recipe = `${name}/${variant}`;
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
  qualityOk,
  deriveName,
  ratiosOf,
  collapsed,
  sameSpec,
  redactValue,
  noteStep,
  takeSteps,
  clearSteps,
  noteNavigation,
  hydrate,
  observe,
  ago,
  hintFor,
  describeRecipes,
  RECIPES_NOTE,
};
