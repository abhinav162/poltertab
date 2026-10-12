// Every tunable the Node half has, in one place, because several of them are
// only correct relative to each other and that relationship was previously
// unwritten — three copies of a 35s timeout in one file, a port in five.
//
// ── The timeout budget ──────────────────────────────────────────────────────
//
// A DOM command crosses four processes, and each layer waits on the one below:
//
//   MCP server   COMMAND_TIMEOUT_MS         35s   ← must be the largest
//     extension  navigation wait            30s   + 500ms settle  (background.js)
//       frame    postToFrame                10s                   (background.js)
//         page   ELEMENT_WAIT_MS             3s                   (content_script.js)
//
// The invariant: **each layer's budget must exceed the sum of what it waits
// on.** Break it and a slow-but-successful page load surfaces at the top as a
// timeout, which the caller can only answer by guessing whether to retry — the
// single most expensive wrong answer this system can give, because the retry
// re-runs a scrape that already worked.
//
// The extension's half of these numbers cannot be required from here: it runs
// in Chrome, there is no build step, and MV3 forbids remote code. They are
// mirrored at the top of background.js with a pointer back to this comment. If
// you change one, change both.

const os = require("os");
const path = require("path");

// Anything the user accumulates lives outside the package. Under a global npm
// install __dirname resolves inside node_modules/poltertab/, so site memory
// written next to the code is destroyed by the next `npm update -g` — the
// upgrade would read as amnesia. Downloads have it worse: output_file exists to
// keep large payloads out of the context window, and burying them in
// node_modules makes them hard to find and just as easy to lose.
//
// POLTERTAB_HOME exists so the test suite can point this somewhere disposable
// instead of writing into the real one.
const POLTERTAB_HOME =
  process.env.POLTERTAB_HOME || path.join(os.homedir(), ".poltertab");

// Port: MCP_BROWSER_WS_PORT env, then --port CLI arg, then the default.
const DEFAULT_WS_PORT = 7822;
function resolvePort(argv = process.argv, env = process.env) {
  const i = argv.indexOf("--port");
  if (i !== -1 && argv[i + 1]) return parseInt(argv[i + 1], 10);
  if (env.MCP_BROWSER_WS_PORT) return parseInt(env.MCP_BROWSER_WS_PORT, 10);
  return DEFAULT_WS_PORT;
}

// The v2 Secondary ceiling: POLTERTAB_MAX_SECONDARIES if it is a whole number
// ≥ 0, else 50. 0 is honoured — it refuses every versioned Secondary (old ones
// are still accepted, see MAX_SECONDARIES below) — so an explicit 0 must not
// fall through to the default the way `parseInt(x) || 50` let it.
const DEFAULT_MAX_SECONDARIES = 50;
function resolveMaxSecondaries(env = process.env) {
  const raw = env.POLTERTAB_MAX_SECONDARIES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_SECONDARIES;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_SECONDARIES;
}

// How long a v2 Secondary may sit idle (no commands) before the Primary sends
// close code 4001. Only whole-number milliseconds > 0 are accepted; anything
// else falls back to the default. 0 would mean "evict immediately", which is
// not a meaningful setting, so it is treated as invalid.
const DEFAULT_IDLE_EVICTION_MS = 5 * 60 * 1000; // 5 minutes
function resolveIdleEvictionMs(env = process.env) {
  const raw = env.POLTERTAB_IDLE_EVICTION_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_IDLE_EVICTION_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_IDLE_EVICTION_MS;
}

module.exports = {
  POLTERTAB_HOME,
  MEMORY_DIR: path.join(POLTERTAB_HOME, "navigation_memory"),
  DOWNLOADS_DIR: path.join(POLTERTAB_HOME, "downloads"),

  DEFAULT_WS_PORT,
  resolvePort,
  resolveMaxSecondaries,
  resolveIdleEvictionMs,

  // See the budget above before changing this.
  COMMAND_TIMEOUT_MS: 35000,

  // Dead-connection detection. A socket that misses a ping/pong round is
  // terminated so the extension's own reconnect can take over.
  HEARTBEAT_MS: 60000,

  // The capture buffer is a bounded tail, not a log. Both caps exist to stop a
  // chatty tab from turning the bridge into a memory leak: the server holds
  // response bodies for tabs it may never be asked about again.
  NETWORK_TTL_MS: 5 * 60 * 1000,
  NETWORK_GC_INTERVAL_MS: 60000,
  NETWORK_MAX_REQUESTS: 500,
  NETWORK_MAX_BODY_BYTES: 1024 * 1024,

  // Promotion race: every orphaned Secondary tries to bind the freed port at
  // once, so they stagger themselves rather than all failing but one.
  PROMOTION_DELAY_MS: 500,
  PROMOTION_JITTER_MS: 2000,

  // A refused or unreachable Secondary retries on this schedule — 2 s, 4 s,
  // 8 s … ±25%, capped — and the whole probe/connect/promote cycle runs under
  // it, reset only when a Primary sends secondary_accepted. Without it a
  // refusal was answered by an immediate reconnect, refused again, forever.
  PROMOTION_BACKOFF_INITIAL_MS: 2000,
  PROMOTION_BACKOFF_MAX_MS: 60000,
  PROMOTION_BACKOFF_JITTER: 0.25,

  // A safety net against runaway processes, not a usage limit: at 5 it was
  // routinely hit by idle helpers, and every refusal fed the loop above. Only
  // Secondaries that declare a version count; an old one is always accepted,
  // because the only refusal it understands is a close it answers by trying to
  // promote.
  MAX_SECONDARIES: resolveMaxSecondaries(),

  // How long a v2 Secondary may sit idle before the Primary evicts it with
  // close code 4001. Configurable so tests can use a short value (e.g. 300 ms)
  // without slowing the suite.
  IDLE_EVICTION_MS: resolveIdleEvictionMs(),

  // Lazy-loaded content arrives after the scroll returns. Long enough for the
  // XHR it triggered to land in the capture buffer, short enough that a
  // scroll-and-read loop is not dominated by waiting.
  SMART_SCROLL_SETTLE_MS: 2000,
};
