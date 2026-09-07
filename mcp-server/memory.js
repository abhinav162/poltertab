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
// A selector that keeps missing even with its fingerprint has drifted past
// recognition — stop trusting it rather than relocating against a dead signature.
const MAX_FAILS = 3;

// Normalize any on-disk shape — including the original bare array — to the
// current { notes, selectors } form. Old files upgrade in place on the next
// write, so there is no migration step.
function normalize(raw) {
  if (Array.isArray(raw)) return { notes: raw, selectors: {} };
  return {
    notes: raw && Array.isArray(raw.notes) ? raw.notes : [],
    selectors:
      raw && raw.selectors && typeof raw.selectors === "object"
        ? raw.selectors
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

module.exports = {
  memoryFile,
  selectorKey,
  readMemory,
  saveMemory,
  getSelector,
  recordSelector,
  noteSelectorFail,
};
