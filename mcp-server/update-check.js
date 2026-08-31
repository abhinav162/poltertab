// Update and version-skew checking.
//
// Two halves ship as one version but update on completely different schedules.
// The npm package updates when someone remembers to run `npm update -g`; the
// extension, loaded unpacked, never updates at all — Chrome only auto-updates
// what came from the Web Store. So the interesting failure is not "an update
// exists", it is skew: a 1.2 server sending a command a 1.0 extension does not
// implement. That surfaces as an element mysteriously not being found, which is
// indistinguishable from the page genuinely not having it.
//
// Nothing here may block startup or throw into a caller. A failed update check
// is a non-event; the browser tools have to keep working with no network.

const fs = require("fs");
const path = require("path");

const CACHE_FILE = "update-check.json";
const STATE_FILE = "state.json";
const OK_TTL_MS = 24 * 60 * 60 * 1000; // a day between successful checks
const FAIL_TTL_MS = 60 * 60 * 1000; // retry sooner after a failure

// Measured, not guessed: a cold connection to registry.npmjs.org costs ~4s here
// (DNS + TLS; the body itself arrives in ~5ms). Every check is cold, because it
// runs once at startup in a fresh process. An earlier 3s value aborted 100% of
// real lookups while every unit test passed, since those inject a fake fetch —
// so keep a wide margin over the observed cost. Nothing waits on this: the
// server fires it and forgets, and doctor prints local state first.
const FETCH_TIMEOUT_MS = 15000;

// --- semver ----------------------------------------------------------------

function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(
    String(version || "").trim().replace(/^v/, ""),
  );
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : [],
  };
}

// Full semver precedence, because the shortcuts are all wrong in ways that
// matter here: string compare puts "1.10.0" below "1.9.0", and ignoring the
// prerelease tail would tell someone on 1.2.0-beta.1 to "update" to 1.1.0.
function compareVersions(a, b) {
  const A = parse(a);
  const B = parse(b);
  if (!A || !B) return 0;

  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  }

  // 1.2.0 outranks every 1.2.0-anything.
  if (!A.pre.length && B.pre.length) return 1;
  if (A.pre.length && !B.pre.length) return -1;

  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined) return -1; // a shorter prerelease ranks lower
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1; // numeric identifiers rank below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

const isNewer = (candidate, current) => compareVersions(candidate, current) > 0;

// --- on-disk state ---------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null; // absent, unreadable, or truncated — all mean "no state"
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    return true;
  } catch (_) {
    return false; // a read-only home is not worth failing a browser command
  }
}

// The extension only ever talks to a running server, so `poltertab doctor` has
// no way to ask it directly. Recording the version here means doctor can report
// it — honestly labelled as last-seen — without any new protocol, and even when
// no server is running.
const readExtensionState = (home) => readJson(path.join(home, STATE_FILE));

function recordExtension(home, version, now = Date.now()) {
  if (!version) return false;
  return writeJson(path.join(home, STATE_FILE), {
    extensionVersion: version,
    seenAt: now,
  });
}

// --- registry --------------------------------------------------------------

function disabled() {
  const v = process.env.POLTERTAB_NO_UPDATE_CHECK;
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

// Resolves to a version string, or null for any failure at all — offline,
// 404 (the package is not published yet), timeout, garbage response.
async function fetchLatest(pkg = "poltertab", fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`,
      { signal: ac.signal, headers: { accept: "application/json" } },
    );
    if (!res || !res.ok) return null;
    const body = await res.json();
    return parse(body && body.version) ? body.version : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Cached so a per-session server start does not mean a per-session request.
// Returns the cached answer without touching the network when it is fresh.
async function checkForUpdate({
  current,
  home,
  pkg = "poltertab",
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  force = false,
} = {}) {
  const cacheFile = path.join(home, CACHE_FILE);
  const cached = readJson(cacheFile);

  if (!force && cached && typeof cached.checkedAt === "number") {
    const ttl = cached.latest ? OK_TTL_MS : FAIL_TTL_MS;
    if (now - cached.checkedAt < ttl) {
      return {
        latest: cached.latest || null,
        updateAvailable: !!cached.latest && isNewer(cached.latest, current),
        fromCache: true,
      };
    }
  }

  if (!force && disabled()) {
    return { latest: null, updateAvailable: false, disabled: true };
  }

  const latest = await fetchLatest(pkg, fetchImpl);
  writeJson(cacheFile, { checkedAt: now, latest });
  return {
    latest,
    updateAvailable: !!latest && isNewer(latest, current),
    fromCache: false,
  };
}

// --- skew ------------------------------------------------------------------

// Compares only major.minor. A patch-level difference between the two halves is
// normal — someone updates the package and reloads the extension a minute later
// — and warning about it would train people to ignore the warning.
function skew(serverVersion, extensionVersion) {
  if (!extensionVersion) return null;
  const s = parse(serverVersion);
  const e = parse(extensionVersion);
  if (!s || !e) return null;
  if (s.nums[0] === e.nums[0] && s.nums[1] === e.nums[1]) return null;
  const behind = compareVersions(extensionVersion, serverVersion) < 0;
  return {
    kind: behind ? "extension-behind" : "server-behind",
    server: serverVersion,
    extension: extensionVersion,
  };
}

// --- the one-line notice ---------------------------------------------------

const RELEASES = "https://github.com/abhinav162/poltertab/releases";

// Which extension build to send someone to.
//
// It must match the server that drives it: mismatched halves are the exact
// failure the rest of this module exists to detect, so a link that manufactures
// one is worse than no link. GitHub's /releases/latest deliberately skips
// prereleases — so telling a 1.5.0-beta.1 install to "get the latest release"
// hands it a 1.4.0 extension, and the skew warning then fires on a fresh
// install that followed the instructions exactly. Worse, that was also the
// remediation advice printed *for* skew, so the fix re-created the fault.
//
// Ask for the release matching the version in hand. Callers pass whichever
// version is right for what they are saying: the running server for "your
// halves disagree", the version being upgraded to for "an update is available".
// /releases/latest survives only as the fallback for a build whose version we
// cannot parse — a dev checkout — where a tag URL would 404.
function extensionUrl(version) {
  const v = String(version || "")
    .trim()
    .replace(/^v/, "");
  return parse(v) ? `${RELEASES}/tag/v${v}` : `${RELEASES}/latest`;
}

// Surfaced once per server process on a tool response, because it is the only
// channel the user reliably reads: doctor and the popup both require them to
// already suspect something is wrong.
function notice({ current, latest, updateAvailable, skew: sk }) {
  const parts = [];
  if (sk && sk.kind === "extension-behind") {
    parts.push(
      `The Chrome extension (${sk.extension}) is older than this server (${sk.server}) — ` +
        `browser commands may fail in ways that look like missing elements. ` +
        `Reload it from ${extensionUrl(sk.server)}`,
    );
  } else if (sk && sk.kind === "server-behind") {
    parts.push(
      `The Chrome extension (${sk.extension}) is newer than this server (${sk.server}). ` +
        `Update with: npm update -g poltertab`,
    );
  }
  if (updateAvailable && latest) {
    parts.push(
      `PolterTab ${latest} is available (running ${current}). ` +
        `Update with: npm update -g poltertab && poltertab setup, ` +
        `then reload the extension from ${extensionUrl(latest)}`,
    );
  }
  if (!parts.length) return null;
  return `[PolterTab] ${parts.join(" ")} (Mention this to the user once, then carry on.)`;
}

module.exports = {
  compareVersions,
  isNewer,
  parse,
  readExtensionState,
  recordExtension,
  fetchLatest,
  checkForUpdate,
  skew,
  notice,
  disabled,
  extensionUrl,
  CACHE_FILE,
  STATE_FILE,
};
