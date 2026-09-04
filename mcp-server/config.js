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

module.exports = {
  POLTERTAB_HOME,
  MEMORY_DIR: path.join(POLTERTAB_HOME, "navigation_memory"),
  DOWNLOADS_DIR: path.join(POLTERTAB_HOME, "downloads"),

  DEFAULT_WS_PORT,
  resolvePort,

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

  // More concurrent agents than this sharing one browser stops being useful and
  // starts being a way to lose track of which tab belongs to whom.
  MAX_SECONDARIES: 5,

  // Lazy-loaded content arrives after the scroll returns. Long enough for the
  // XHR it triggered to land in the capture buffer, short enough that a
  // scroll-and-read loop is not dominated by waiting.
  SMART_SCROLL_SETTLE_MS: 2000,
};
