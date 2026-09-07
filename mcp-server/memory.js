// Site memory: the notes an agent leaves itself about a domain, keyed by
// hostname. The key arrives from a model, so it is untrusted input rather than
// a filename — see memoryFile.

const fs = require("fs");
const path = require("path");
const { MEMORY_DIR } = require("./config.js");

fs.mkdirSync(MEMORY_DIR, { recursive: true });

// Installs predating the move kept memory beside the code. Copy it forward once
// so an upgrade does not look like the agent forgot everything it learned.
// Never overwrite: if both sides have a note for a domain, the one already in
// the new location is the live one.
(() => {
  const legacy = path.join(__dirname, "navigation_memory");
  if (legacy === MEMORY_DIR || !fs.existsSync(legacy)) return;
  let copied = 0;
  for (const name of fs.readdirSync(legacy)) {
    const to = path.join(MEMORY_DIR, name);
    if (!name.endsWith(".json") || fs.existsSync(to)) continue;
    try {
      fs.copyFileSync(path.join(legacy, name), to);
      copied++;
    } catch (_) {
      // A read-only or half-removed legacy dir is not worth failing startup.
    }
  }
  if (copied) {
    console.error(
      `[PolterTab MCP] Migrated ${copied} site memory file(s) to ${MEMORY_DIR}`,
    );
  }
})();

// Site memory is keyed by hostname, and that key arrives from a model — so it
// is untrusted input rather than a filename. Two failures this closes: a note
// saved under kw.com was invisible to a lookup for www.kw.com (the same site),
// and the raw value was interpolated straight into a path, so "../.." reached
// outside MEMORY_DIR.
function memoryFile(rawHost) {
  let host = String(rawHost).trim().toLowerCase();

  // The parameter is also documented as accepting `url`, so a full URL turning
  // up here is expected rather than a caller mistake.
  if (host.includes("/")) {
    try {
      host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
    } catch {
      host = host.split("/")[0];
    }
  }

  host = host.replace(/[^a-z0-9.-]/g, "").replace(/^\.+/, "");
  if (!host) throw new Error(`Not a usable hostname: ${rawHost}`);

  // Existing notes live under whichever spelling first created them — the store
  // already holds both kw.com.json and www.linkedin.com.json — so try the
  // variants before concluding this is a new file.
  const bare = host.replace(/^www\./, "");
  for (const name of [bare, host, `www.${bare}`]) {
    const p = path.join(MEMORY_DIR, `${name}.json`);
    if (fs.existsSync(p)) return p;
  }
  return path.join(MEMORY_DIR, `${bare}.json`);
}

// Free-text notes are capped so a chatty agent can't grow one file without
// bound; selectors likewise, evicting the least-recently-used first.
const NOTES_CAP = 100;
const SELECTORS_CAP = 200;
// A learned recipe carries a whole extract spec plus replay steps per variant,
// so it is orders of magnitude larger than a selector entry — cap it far
// tighter, and count across path patterns because the file size is what the
// cap actually protects.
const RECIPES_CAP = 20;
// A selector that keeps missing even with its fingerprint has drifted past
// recognition — stop trusting it rather than relocating against a dead signature.
const MAX_FAILS = 3;

// Normalize any on-disk shape — including the original bare array — to the
// current { notes, selectors, recipes } form. Old files upgrade in place on the
// next write, so there is no migration step.
function normalize(raw) {
  if (Array.isArray(raw)) return { notes: raw, selectors: {}, recipes: {} };
  return {
    notes: raw && Array.isArray(raw.notes) ? raw.notes : [],
    selectors:
      raw && raw.selectors && typeof raw.selectors === "object"
        ? raw.selectors
        : {},
    // An array here would survive the typeof check and then hand out numeric
    // recipe names from Object.keys, so reject anything but a plain object.
    recipes:
      raw &&
      raw.recipes &&
      typeof raw.recipes === "object" &&
      !Array.isArray(raw.recipes)
        ? raw.recipes
        : {},
  };
}

function readMemory(rawHost) {
  const file = memoryFile(rawHost);
  if (!fs.existsSync(file)) return normalize(null);
  // getSelector sits on the click/fill path, so an unreadable file here used to
  // brick every click on the host. A truncated or hand-edited file is not worth
  // that: read it as empty and let the action proceed on its own selector.
  try {
    return normalize(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (_) {
    return normalize(null);
  }
}

// writeFileSync truncates in place, so a crash — or a second MCP process, which
// bridge.js explicitly supports — mid-write leaves a half-written file that the
// next read cannot parse. Write a sibling temp file and rename: rename is atomic
// within a directory, so a reader sees the old file or the new one, never a
// partial one.
function writeMemory(rawHost, data) {
  const file = memoryFile(rawHost);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      // Nothing to clean up.
    }
    throw err;
  }
}

// The selector store is bookkeeping for an action that already happened, so a
// failed write must never surface as a failed click — the agent would retry and
// double-submit. saveMemory stays strict: it IS the user's action.
function bestEffort(fn) {
  try {
    fn();
  } catch (_) {
    // Read-only or full home: keep the healing we cannot persist to ourselves.
  }
}

function saveMemory(rawHost, obstacle, solution) {
  const data = readMemory(rawHost);
  // Re-saving an identical note is a no-op, not another copy of the same line.
  const dup = data.notes.some(
    (n) => n.obstacle === obstacle && n.solution === solution,
  );
  if (!dup) {
    data.notes.push({ obstacle, solution, timestamp: Date.now() });
    if (data.notes.length > NOTES_CAP)
      data.notes = data.notes.slice(-NOTES_CAP);
  }
  writeMemory(rawHost, data);
  return data.notes.length;
}

// Selector entries are keyed by action + page path + selector, not by selector
// alone. Host-only keying meant a fingerprint learned for "#submit" on
// /checkout was injected into a click on "#submit" on /settings, and one
// recorded by fill was injected into a click — different elements, and on
// destructive controls that is a wrong click, then persisted as the new truth.
function selectorKey(action, path, selector) {
  return `${action}|${path || "/"}|${selector}`;
}

function getSelector(rawHost, selector) {
  return readMemory(rawHost).selectors[selector] || null;
}

function recordSelector(rawHost, selector, fingerprint) {
  if (!fingerprint) return; // nothing worth remembering
  bestEffort(() => {
    const data = readMemory(rawHost);
    data.selectors[selector] = {
      fingerprint,
      lastOk: Date.now(),
      failCount: 0,
    };
    evictSelectors(data.selectors);
    writeMemory(rawHost, data);
  });
}

function noteSelectorFail(rawHost, selector) {
  bestEffort(() => {
    const data = readMemory(rawHost);
    const entry = data.selectors[selector];
    if (!entry) return;
    entry.failCount = (entry.failCount || 0) + 1;
    if (entry.failCount >= MAX_FAILS) delete data.selectors[selector];
    writeMemory(rawHost, data);
  });
}

// Bound the store: when a host accrues too many selectors, drop the ones whose
// last success is oldest.
function evictSelectors(selectors) {
  const keys = Object.keys(selectors);
  if (keys.length <= SELECTORS_CAP) return;
  keys
    .sort((a, b) => (selectors[a].lastOk || 0) - (selectors[b].lastOk || 0))
    .slice(0, keys.length - SELECTORS_CAP)
    .forEach((k) => delete selectors[k]);
}

// ── Learned extraction recipes ──────────────────────────────────────────────
//
// A recipe is what the agent worked out about a listing page: the record
// selector and field map that produced clean rows, and — per variant, a slice
// of the same task with its own filters — the steps that got there and the
// fill rate to expect next time. Keyed by path pattern → recipe name →
// variant, so /jobs/12345 and /jobs/99 share what was learned once.

const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Volatile path segments have to collapse or every record page teaches a recipe
// that nothing ever reads back: /jobs/12345 is the same page shape as /jobs/99,
// and a recipe learned on one is what makes the other free.
function pathPattern(rawPath) {
  let p = rawPath == null ? "" : String(rawPath);

  // Callers pass a pathname, but what the page reported is often the full URL.
  if (p.includes("://")) {
    try {
      p = new URL(p).pathname;
    } catch {
      // Not parseable as a URL; the query/hash strip below still applies.
    }
  }
  p = p.split("#")[0].split("?")[0];

  const segments = p
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      if (/^\d+$/.test(seg)) return ":n";
      if (UUID_SEGMENT.test(seg)) return ":id";
      // A long run of letters and digits with no separator is an opaque id.
      // Slugs are excluded by the separator rule on purpose: "senior-engineer-2024"
      // names a page shape, and collapsing it would merge unrelated pages into
      // one recipe.
      if (seg.length >= 12 && /\d/.test(seg) && /^[a-z0-9]+$/i.test(seg))
        return ":id";
      return seg;
    });

  return segments.length ? `/${segments.join("/")}` : "/";
}

// A recipe is as fresh as its freshest variant: one dead filter combination
// must not make the whole learned spec look stale to eviction.
function recipeLastOk(recipe) {
  const variants = recipe && recipe.variants ? recipe.variants : {};
  return Object.keys(variants).reduce(
    (max, k) => Math.max(max, (variants[k] && variants[k].lastOk) || 0),
    0,
  );
}

function getRecipes(rawHost, pattern) {
  return readMemory(rawHost).recipes[pattern] || {};
}

function getRecipe(rawHost, pattern, name) {
  return getRecipes(rawHost, pattern)[name] || null;
}

// Same contract as recordSelector: the extract that taught us this already
// returned its rows, so a failed write must not surface as a failed extract —
// the agent would re-run the whole crawl.
function putRecipe(rawHost, pattern, name, recipe) {
  if (!recipe) return;
  bestEffort(() => {
    const data = readMemory(rawHost);
    const bucket = data.recipes[pattern] || (data.recipes[pattern] = {});
    const existing = bucket[name];
    bucket[name] = {
      extract: recipe.extract || (existing && existing.extract),
      // Merge: variants of one task are learned one run at a time, so writing
      // the second must not forget the first.
      variants: {
        ...(existing && existing.variants),
        ...(recipe.variants || {}),
      },
    };
    evictRecipes(data.recipes);
    writeMemory(rawHost, data);
  });
}

function noteRecipeFail(rawHost, pattern, name, variant) {
  bestEffort(() => {
    const data = readMemory(rawHost);
    const bucket = data.recipes[pattern];
    const recipe = bucket && bucket[name];
    const entry = recipe && recipe.variants && recipe.variants[variant];
    if (!entry) return;
    entry.failCount = (entry.failCount || 0) + 1;
    if (entry.failCount >= MAX_FAILS) {
      delete recipe.variants[variant];
      // Unwind the empty levels above it, or the file accumulates husks that
      // every later read has to page in and every hint has to filter out.
      if (!Object.keys(recipe.variants).length) delete bucket[name];
      if (!Object.keys(bucket).length) delete data.recipes[pattern];
    }
    writeMemory(rawHost, data);
  });
}

// Bound the store the way evictSelectors does, but across path patterns: a
// crawler that walks a thousand listing URLs would otherwise learn a recipe per
// pattern and grow one host's file without limit.
function evictRecipes(recipes) {
  const entries = [];
  for (const pattern of Object.keys(recipes))
    for (const name of Object.keys(recipes[pattern]))
      entries.push({
        pattern,
        name,
        lastOk: recipeLastOk(recipes[pattern][name]),
      });
  if (entries.length <= RECIPES_CAP) return;
  entries
    .sort((a, b) => a.lastOk - b.lastOk)
    .slice(0, entries.length - RECIPES_CAP)
    .forEach(({ pattern, name }) => {
      delete recipes[pattern][name];
      if (!Object.keys(recipes[pattern]).length) delete recipes[pattern];
    });
}

// What a recipe offers, without what it costs: the hint that tells an agent a
// recipe exists is worth nothing if quoting it costs as much context as the
// extract it saves, so the field map and the replay steps stay on disk.
function listRecipeSummaries(rawHost, pattern) {
  const bucket = getRecipes(rawHost, pattern);
  return Object.keys(bucket).map((name) => {
    const recipe = bucket[name];
    const fields = recipe && recipe.extract && recipe.extract.fields;
    return {
      name,
      fields:
        fields && typeof fields === "object" && !Array.isArray(fields)
          ? Object.keys(fields)
          : [],
      variants: recipe && recipe.variants ? Object.keys(recipe.variants) : [],
      lastOk: recipeLastOk(recipe),
    };
  });
}

module.exports = {
  memoryFile,
  selectorKey,
  readMemory,
  saveMemory,
  getSelector,
  recordSelector,
  noteSelectorFail,
  RECIPES_CAP,
  pathPattern,
  getRecipes,
  getRecipe,
  putRecipe,
  noteRecipeFail,
  listRecipeSummaries,
};
