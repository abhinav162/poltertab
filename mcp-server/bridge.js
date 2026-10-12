// The bridge: this process's connection to the Chrome extension, and its
// arbitration with any other MCP server that wants the same browser.
//
// Two roles. Whoever binds the port is Primary and owns the extension socket;
// everyone else becomes a Secondary and proxies commands through it. A Primary
// that dies frees the port, and the orphaned Secondaries race (with jitter) to
// replace it. No lockfile, no supervisor.
//
// Everything mutable about that arrangement lives in this file. index.js sees
// four verbs — sendCommand, readNetworkState, isSecondary, noteActiveTab — and
// none of the state behind them.

const WebSocket = require("ws");
const crypto = require("crypto");
const net = require("net");
const {
  resolvePort,
  DEFAULT_WS_PORT,
  COMMAND_TIMEOUT_MS,
  HEARTBEAT_MS,
  NETWORK_TTL_MS,
  NETWORK_GC_INTERVAL_MS,
  NETWORK_MAX_REQUESTS,
  NETWORK_MAX_BODY_BYTES,
  PROMOTION_DELAY_MS,
  PROMOTION_JITTER_MS,
  PROMOTION_BACKOFF_INITIAL_MS,
  PROMOTION_BACKOFF_MAX_MS,
  PROMOTION_BACKOFF_JITTER,
  MAX_SECONDARIES,
  IDLE_EVICTION_MS,
  MAX_EXTENSION_CONCURRENCY,
  PER_SECONDARY_QUEUE_DEPTH,
  QUEUE_TIMEOUT_MS,
  POLTERTAB_HOME,
} = require("./config.js");
const updates = require("./update-check.js");
const OWN_VERSION = require("./../package.json").version;

let WS_PORT = resolvePort();

// Populated when the extension connects; stays null until then, which is itself
// worth reporting — a skew warning must not fire on "no extension yet".
let extensionVersion = null;

// Global state
let extensionSocket = null;
const pendingCommands = new Map();
const networkState = new Map(); // tabId -> { lastUpdated: number, requests: array }
const secondaryClients = new Map();
let primaryLastTabId = null;

let isSecondary = false;
let nodeId = null;
let wss = null;
let httpServer = null;
let httpServer6 = null; // IPv6 loopback companion; null if host has no IPv6

// Secondary-side retry state. One counter for the whole reconnect/probe/promote
// cycle, reset only by a Primary's secondary_accepted; `refusal` and
// `unreachable` say why this node is between connections, so a command sent
// meanwhile can name the cause instead of a generic "not connected".
let backoffAttempt = 0;
let retryTimer = null;
let refusal = null;
let unreachable = false;

// Idle eviction, Secondary side. A 4001 from the Primary parks this node: no
// reconnect, no probe, no promotion. The next sendCommand dials again, and
// `reconnect` is that dial while it is in flight, shared by every caller that
// arrives meanwhile so they cost one connection, not one each (R-S3).
let isEvicted = false;
let reconnect = null; // { promise, resolve, reject, timer }

// Command queue, Primary side (PR-3). At most MAX_EXTENSION_CONCURRENCY
// commands may be in flight to the extension at once. v2 Secondary commands
// beyond that wait in a per-secondary FIFO, served round-robin across
// secondaries and the primary itself. Legacy commands bypass the queue.
//
// queuedBySource maps sourceId → [{id, action, ackSentAt, callerWs, onDispatch,
// onTimeout}]. sourceId is the secondary ws for proxy commands, or the symbol
// PRIMARY_SOURCE for the primary's own commands. roundRobinOrder is the list of
// active sources in round-robin order; rrCursor is the next position to serve.
// waitHistory holds completed wait-times (ms) for /status percentiles.
let extensionInFlight = 0;
const PRIMARY_SOURCE = Symbol("primary");
const queuedBySource = new Map();
const roundRobinOrder = [];
let rrCursor = 0;
const waitHistory = [];

// Enqueue an item for a source. If the source has no queue yet, append it to
// the round-robin order so it gets served on the next dequeue.
function _rrEnqueue(sourceId, item) {
  if (!queuedBySource.has(sourceId)) {
    queuedBySource.set(sourceId, []);
    roundRobinOrder.push(sourceId);
  }
  queuedBySource.get(sourceId).push(item);
}

// Pop the next item according to the round-robin order. After taking from a
// source, advance the cursor: if the source is now empty, remove it and leave
// the cursor where it is (the next source slid into that slot); otherwise move
// the cursor to the next source.
function _rrDequeue() {
  if (roundRobinOrder.length === 0) return null;
  if (rrCursor >= roundRobinOrder.length) rrCursor = 0;
  const sourceId = roundRobinOrder[rrCursor];
  const items = queuedBySource.get(sourceId);
  const item = items.shift();
  if (items.length === 0) {
    queuedBySource.delete(sourceId);
    roundRobinOrder.splice(rrCursor, 1);
    if (rrCursor >= roundRobinOrder.length) rrCursor = 0;
  } else {
    rrCursor = (rrCursor + 1) % roundRobinOrder.length;
  }
  return item;
}

// Try to dispatch as many queued items as the in-flight cap allows. Skips items
// whose caller disconnected or whose deadline has passed (both are dropped
// without consuming a slot).
function _tryDequeue() {
  while (extensionInFlight < MAX_EXTENSION_CONCURRENCY) {
    if (roundRobinOrder.length === 0) break;
    const item = _rrDequeue();
    if (!item) break;

    // Deadline check: ackSentAt + budget − 2 s. The −2 s keeps the secondary's
    // own timeout from firing *after* the drop (the secondary re-arms to budget
    // on the queued frame, so the margin is budget − (budget − 2 s) = 2 s).
    if (Date.now() > item.ackSentAt + COMMAND_TIMEOUT_MS - 2000) {
      item.onTimeout();
      continue;
    }
    // Caller gone: drop silently.
    if (item.callerWs && item.callerWs.readyState !== WebSocket.OPEN) {
      continue;
    }
    // Extension disconnected since the item was enqueued: reject to caller
    // without consuming a slot. This is the guard against the MUST-1 crash:
    // _dispatchProxyNow calls extensionSocket.send() synchronously, so a null
    // socket inside a timer callback becomes an uncaughtException that kills
    // the Primary and every Secondary with it.
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      if (item.callerWs && item.callerWs.readyState === WebSocket.OPEN) {
        item.callerWs.send(
          JSON.stringify({ id: item.id, success: false, error: "Browser extension not connected to Primary." }),
        );
      }
      continue;
    }

    extensionInFlight++;
    const waitMs = Date.now() - item.ackSentAt;
    waitHistory.push(waitMs);
    if (waitHistory.length > 1000) waitHistory.shift();
    item.onDispatch();
    // onDispatch may or may not keep extensionInFlight++ live (it fires the
    // extension send); the loop re-checks the cap after each dispatch.
  }
}

function broadcastSessionState() {
  if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
    const sessions = [];
    sessions.push({
      id: "Primary Agent",
      nodeId: "primary",
      lastTabId: primaryLastTabId || null,
    });
    for (const [nodeId, clientWs] of secondaryClients.entries()) {
      sessions.push({
        id: "Secondary Agent",
        nodeId: nodeId,
        lastTabId: clientWs.lastTabId || null,
      });
    }
    extensionSocket.send(
      JSON.stringify({
        type: "state_update",
        sessions,
      }),
    );
  }
}

// The bridge listens on localhost, and localhost is reachable from any page the
// user happens to visit — browsers allow ws:// to loopback from an https origin.
// Nothing below the handshake distinguishes callers, so a drive-by page could
// send {type:"ping"}, be installed as `extensionSocket` (the nodeId-less branch
// in setupPrimaryWss), and thereby drop the real extension *and* receive every
// subsequent command — URLs, selectors — answering each with whatever it liked.
//
// Origin is the one thing the page cannot lie about: browsers set it themselves
// on the handshake request. The extension sends chrome-extension://<its id>, and
// a Node client (a Secondary MCP node) sends none at all. Both are us; a page is
// never either.
//
// ponytail: origin check only. It stops the drive-by, which is the reachable
// attack. It does not authenticate a hostile *local process* — that needs a
// shared token in POLTERTAB_HOME, and any local process able to make one is
// already able to read the browser profile directly.
function allowOrigin(info, cb) {
  const origin = info.origin || info.req.headers.origin;
  if (!origin || origin.startsWith("chrome-extension://")) return cb(true);
  // Loud on purpose: a rejected handshake is otherwise indistinguishable from
  // an extension that never connected, which is the worst thing to debug.
  console.error(
    `[PolterTab MCP] Refused WebSocket handshake from origin ${origin}`,
  );
  return cb(false, 403, "Forbidden");
}

function setupPrimaryServer() {
  const http = require("http");
  const handleRequest = (req, res) => {
    if (req.method === "GET" && req.url === "/status") {
      const now = Date.now();
      const secondaries = [];
      for (const [nid, ws] of secondaryClients.entries()) {
        const srcQueue = queuedBySource.get(ws);
        secondaries.push({
          nodeId: nid,
          version: ws.version || null,
          protocol: ws.supportsNewCloseCodes ? "v2" : "legacy",
          pid: ws.pid || null,
          idle_ms: Math.floor(now - ws.lastCommandAt),
          queued_commands: srcQueue ? srcQueue.length : 0,
        });
      }
      let totalQueued = 0;
      for (const items of queuedBySource.values()) totalQueued += items.length;
      const sorted = waitHistory.slice().sort((a, b) => a - b);
      const pct = (p) => sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : 0;
      const body = JSON.stringify({
        role: "primary",
        pid: process.pid,
        port: WS_PORT,
        version: OWN_VERSION,
        secondaries,
        queue: {
          in_flight: extensionInFlight,
          max_in_flight: MAX_EXTENSION_CONCURRENCY,
          queued: totalQueued,
          max_queued_per_secondary: PER_SECONDARY_QUEUE_DEPTH,
          wait_percentiles_ms: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
        },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  };
  httpServer = http.createServer(handleRequest);

  httpServer.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(
        `[PolterTab MCP] Port ${WS_PORT} in use, switching to Secondary Mode...`,
      );
      // A server that never bound is still a handle; every lost promotion race
      // used to leave one behind.
      httpServer.close();
      httpServer = null;
      startSecondaryMode();
      // NICE-2 residual race: a legacy (wildcard-binding) PolterTab that starts
      // in the ms between a successful probe and our listen() call will bind
      // undetected on macOS — SO_REUSEADDR lets 127.0.0.1 bind over 0.0.0.0,
      // so the new loopback Primary dual-binds silently.  That window is
      // milliseconds and requires two simultaneous starts; not worth a retry
      // loop, but do not remove the probe and rely on this handler alone.
    } else {
      console.error(`[PolterTab MCP] HTTP server error: ${e.message}`);
    }
  });

  // Why probe-first (SHOULD-1 narrative, real reason for this change):
  // PR-3 routes /status to loopback only, so the whole Primary now binds
  // 127.0.0.1 instead of 0.0.0.0.  On macOS, libuv sets SO_REUSEADDR, and
  // BSD/macOS lets a specific-address bind succeed silently over a live
  // wildcard listener — so the new loopback-binding Primary would start beside
  // a pre-1.8 (wildcard) PolterTab without getting EADDRINUSE, then steal all
  // loopback traffic.  S11 is the regression test: it places a wildcard fixture
  // and asserts the bridge-under-test demotes instead of dual-binding.  The
  // EADDRINUSE handler above remains as the fallback for same-host races.
  probePrimary().then((alive) => {
    if (alive) {
      console.error(
        `[PolterTab MCP] Port ${WS_PORT} in use, switching to Secondary Mode...`,
      );
      httpServer.close();
      httpServer = null;
      startSecondaryMode();
      return;
    }
    httpServer.listen(WS_PORT, "127.0.0.1", () => {
    wss = new WebSocket.WebSocketServer({
      server: httpServer,
      verifyClient: allowOrigin,
      perMessageDeflate: {
        zlibDeflateOptions: {
          chunkSize: 1024,
          memLevel: 7,
          level: 1,
        },
        zlibInflateOptions: {
          chunkSize: 10 * 1024,
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 1024,
      },
    });

    // Heartbeat mechanism to detect dead connections
    const interval = setInterval(() => {
      wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          console.error(
            `[PolterTab MCP] Terminating dead connection: ${ws.nodeId || "Extension/Unknown"}`,
          );
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, HEARTBEAT_MS);

    // Idle eviction (4001) for v2 Secondaries silent for IDLE_EVICTION_MS. An
    // old Secondary is never evicted: it answers any close by trying to
    // promote. One with a command in flight is skipped (R-S2) — its clock
    // restarts when the reply goes back. The check runs at half the idle
    // period, capped at the heartbeat, so an eviction lands at most that late.
    const evictionInterval = setInterval(() => {
      const now = Date.now();
      for (const ws of secondaryClients.values()) {
        if (!ws.supportsNewCloseCodes || ws.readyState !== WebSocket.OPEN) {
          continue;
        }
        const idleMs = now - ws.lastCommandAt;
        if (idleMs < IDLE_EVICTION_MS) continue;
        // NICE-1: also skip eviction when commands are queued for this source
        // (spec §3.3: "zero in-flight AND zero queued").
        const busy =
          [...pendingCommands.values()].some((c) => c.isProxy && c.sourceWs === ws) ||
          queuedBySource.has(ws);
        if (busy) continue;
        console.error(
          `[PolterTab MCP] Evicting idle secondary ${ws.nodeId} (idle ${idleMs} ms)`,
        );
        ws.close(
          4001,
          JSON.stringify({ reason: "idle_evicted", idle_ms: idleMs }),
        );
      }
    }, Math.max(100, Math.min(HEARTBEAT_MS, Math.floor(IDLE_EVICTION_MS / 2))));

    // GC: drop queued commands that have outlived QUEUE_TIMEOUT_MS. The
    // deadline check at dequeue handles most cases; this is a safety net for
    // commands in a source that never gets dequeued (e.g. its slot is always
    // occupied by a slow extension command). It fires the same onTimeout
    // handler, which sends [queue_timeout] to the caller and removes the item.
    const queueGcInterval = setInterval(() => {
      const now = Date.now();
      for (const [sourceId, items] of queuedBySource.entries()) {
        for (let i = items.length - 1; i >= 0; i--) {
          if (now - items[i].ackSentAt > QUEUE_TIMEOUT_MS) {
            const [expired] = items.splice(i, 1);
            expired.onTimeout();
          }
        }
        if (items.length === 0) {
          queuedBySource.delete(sourceId);
          const idx = roundRobinOrder.indexOf(sourceId);
          if (idx !== -1) {
            roundRobinOrder.splice(idx, 1);
            if (rrCursor > idx) rrCursor--;
            if (rrCursor >= roundRobinOrder.length) rrCursor = 0;
          }
        }
      }
    }, Math.min(QUEUE_TIMEOUT_MS, 10000));

    wss.on("close", () => {
      clearInterval(interval);
      clearInterval(evictionInterval);
      clearInterval(queueGcInterval);
    });

    // Network State Garbage Collector (TTL: 5 minutes)
    setInterval(() => {
      const now = Date.now();
      for (const [tabId, state] of networkState.entries()) {
        if (now - state.lastUpdated > NETWORK_TTL_MS) {
          console.error(
            `[PolterTab MCP] Garbage collecting network state for tab ${tabId}`,
          );
          networkState.delete(tabId);
        }
      }
    }, NETWORK_GC_INTERVAL_MS);

    setupPrimaryWss(wss);

    // Also listen on ::1 (IPv6 loopback) so Node 18 clients work: Node 18
    // resolves 'localhost' to ::1 first with no happy-eyeballs fallback.
    // Skip cleanly when the host has no IPv6 stack (EADDRNOTAVAIL/EAFNOSUPPORT).
    // On macOS, SO_REUSEADDR lets a specific-address ::1 bind succeed silently
    // over a live :: wildcard listener — but we only set up httpServer6 AFTER
    // probing 127.0.0.1, so a false-primary that owns :: would be caught by that
    // probe (it also owns 127.0.0.1) and we would have gone Secondary already.
    //
    // The "listening" log is delayed until ::1 is ready (or skipped) so that
    // any client connecting on the log signal can reach both addresses.
    const SKIP_IPV6 = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPROTONOSUPPORT"]);
    const logListening = () =>
      console.error(
        `[PolterTab MCP] Primary WebSocket server listening on ws://localhost:${WS_PORT}`,
      );
    httpServer6 = http.createServer(handleRequest);
    httpServer6.on("error", (e) => {
      if (SKIP_IPV6.has(e.code)) {
        httpServer6 = null;
      } else {
        console.error(`[PolterTab MCP] IPv6 loopback error: ${e.message}`);
      }
      logListening();
    });
    httpServer6.once("listening", logListening);
    httpServer6.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
    });
    httpServer6.listen(WS_PORT, "::1");
    });
  });
}

function startSecondaryMode() {
  isSecondary = true;
  // Once per process. The extension keys this agent's current tab by nodeId,
  // so a fresh one after a lost promotion race orphaned that pointer and the
  // agent's next untargeted command landed on the user's focused tab.
  if (!nodeId) nodeId = crypto.randomUUID();
  console.error(
    `[PolterTab MCP] Node ${nodeId} running as Secondary. Connecting to Primary...`,
  );

  connectToPrimary();
}

// The retry schedule: INITIAL × 2^attempt, capped, ±JITTER so a crowd of
// refused Secondaries does not come back in step. `rand` is injectable for
// the tests.
function _backoffDelay(attempt, rand = Math.random) {
  const base = Math.min(
    PROMOTION_BACKOFF_INITIAL_MS * 2 ** attempt,
    PROMOTION_BACKOFF_MAX_MS,
  );
  const jitter = 1 + PROMOTION_BACKOFF_JITTER * (2 * rand() - 1);
  return Math.min(Math.round(base * jitter), PROMOTION_BACKOFF_MAX_MS);
}

function scheduleRetry(fn, delay) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(fn, delay);
}

// Dial the Primary again after an eviction. Settles on secondary_accepted, not
// on the socket opening: a command sent before the ACK can land on a Primary
// that is about to refuse this node. A failed dial rejects at once with the
// cause (the close handler calls finishReconnect) and leaves the node on PR-1's
// ordinary schedule — backoff, probe, promote — so the caller is not held for
// the full command timeout and the port is still taken over if it is free.
// isEvicted is cleared here rather than on the ACK: from now on the node is
// reconnecting, and a node that promotes itself must not dial its own port.
function lazyReconnect() {
  if (reconnect) return reconnect.promise;
  isEvicted = false;
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  reconnect = {
    promise,
    ...settle,
    timer: setTimeout(
      () => finishReconnect(new Error(reconnectFailed())),
      COMMAND_TIMEOUT_MS,
    ),
  };
  connectToPrimary();
  return promise;
}

function finishReconnect(err) {
  if (!reconnect) return;
  const r = reconnect;
  reconnect = null;
  clearTimeout(r.timer);
  if (err) r.reject(err);
  else r.resolve();
}

function reconnectFailed() {
  return `[reconnect_failed port=${WS_PORT}] Could not reconnect to primary.`;
}

// Is anything listening on the port? Binding to find out is what leaked a
// server per attempt; a refused TCP connect is the only answer that means the
// Primary is gone.
function probePrimary() {
  return new Promise((resolve) => {
    // Dial 127.0.0.1 explicitly; 'localhost' resolves to ::1 first on Node 18
    // (no happy-eyeballs), which would give a false ECONNREFUSED when our own
    // Primary is listening on 127.0.0.1.
    const sock = net.connect(WS_PORT, "127.0.0.1");
    // A listener with a full accept backlog answers with neither connect nor
    // error, which would park this node with no retry scheduled. Treat silence
    // as "something is there": connectToPrimary's handshake timeout then sorts
    // a hung Primary from a live one and keeps the backoff running.
    sock.setTimeout(1000, () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", (err) => resolve(err.code !== "ECONNREFUSED"));
  });
}

async function promoteOrRejoin() {
  if (await probePrimary()) {
    connectToPrimary();
    return;
  }
  isSecondary = false;
  setupPrimaryServer();
}

function connectToPrimary() {
  // Dial 127.0.0.1 explicitly so Node 18 (which resolves 'localhost' to ::1
  // first with no fallback) does not get ECONNREFUSED against the IPv4 Primary.
  const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`, {
    perMessageDeflate: true,
    // A Primary that accepts TCP but never answers the upgrade (event loop
    // blocked, SIGSTOP) would otherwise hold this node forever.
    handshakeTimeout: 5000,
  });
  extensionSocket = ws;
  let opened = false;
  let accepted = false;
  let errCode = null;

  ws.on("open", () => {
    opened = true;
    console.error("[PolterTab MCP] Connected to Primary MCP Server.");
    // The version is what tells a Primary this node understands 4xxx closes.
    ws.send(
      JSON.stringify({
        type: "secondary_mcp",
        nodeId,
        version: OWN_VERSION,
        pid: process.pid,
        parentPid: process.ppid,
      }),
    );
  });

  ws.on("message", (message) => {
    try {
      const msg = JSON.parse(message);
      // Frames about this connection carry a type, never a command id, and
      // are handled before the id branch so none can settle a pending command.
      if (msg.type === "secondary_accepted") {
        accepted = true;
        backoffAttempt = 0;
        refusal = null;
        unreachable = false;
        finishReconnect();
        return;
      }
      // `queued` and `dispatched` frames re-arm the awaitReply timer (U11)
      // but never settle the command — the reply does that.
      if (
        (msg.type === "queued" || msg.type === "dispatched") &&
        msg.id &&
        pendingCommands.has(msg.id)
      ) {
        const entry = pendingCommands.get(msg.id);
        if (entry && entry.resetTimer) entry.resetTimer();
        return;
      }
      if (msg.id && pendingCommands.has(msg.id)) {
        const { resolve, reject, timer } = pendingCommands.get(msg.id);
        clearTimeout(timer);
        pendingCommands.delete(msg.id);

        if (msg.success) {
          resolve(msg.data);
        } else {
          reject(new Error(msg.error || "Unknown extension error"));
        }
      }
    } catch (err) {
      console.error(
        "[PolterTab MCP] Failed to parse message from Primary",
        err,
      );
    }
  });

  ws.on("close", (code, reason) => {
    if (extensionSocket === ws) extensionSocket = null;
    // Each branch below sets the one that applies; neither may outlive the
    // close that caused it.
    refusal = null;
    unreachable = false;

    const refused = code >= 4000 && code <= 4999;
    let info = {};
    if (refused) {
      try {
        info = JSON.parse(reason.toString());
      } catch (_) {}
    }

    // A lazy reconnect whose dial ended before the ACK fails now, with the
    // reason when the Primary gave one. The branches below still run, so the
    // node retries or promotes exactly as it would have without the caller.
    if (!accepted) {
      finishReconnect(
        new Error(
          info.reason === "capacity_rejected"
            ? `[capacity_rejected limit=${info.limit}] Primary (pid ${info.pid}) has ${info.limit} secondaries. Retry later.`
            : reconnectFailed(),
        ),
      );
    }

    // 4001 = idle_evicted. Park: no reconnect, no probe, no promotion — the
    // next sendCommand dials. A command already on the wire when the Primary
    // closed is lost, and retrying it could run it twice, so say so (R-S2).
    if (code === 4001) {
      isEvicted = true;
      for (const [, { reject, timer, action }] of pendingCommands) {
        clearTimeout(timer);
        reject(
          new Error(
            `[evicted_mid_command action=${action || "unknown"}] Session evicted while command was in progress. Not auto-retried.`,
          ),
        );
      }
      pendingCommands.clear();
      return;
    }

    // Reject all pending commands
    const aborted =
      info.reason === "capacity_rejected"
        ? `[capacity_rejected limit=${info.limit}] Primary (pid ${info.pid}) refused this node. Command aborted.`
        : "Primary node disconnected. Command aborted.";
    for (const [id, { reject, timer }] of pendingCommands) {
      clearTimeout(timer);
      reject(new Error(aborted));
      pendingCommands.delete(id);
    }

    // Refused by a live Primary: it is not dying, so promoting can only fail.
    if (refused) {
      const delay = _backoffDelay(backoffAttempt++);
      refusal = { ...info, retryAt: Date.now() + delay };
      console.error(
        `[PolterTab MCP] Primary refused this node (${code} ${info.reason || "unknown"}). Retrying as Secondary in ${delay}ms.`,
      );
      scheduleRetry(connectToPrimary, delay);
      return;
    }

    // Something holds the port but never completed the handshake: a hung
    // Primary, or not a PolterTab one. Promoting would only hit EADDRINUSE.
    if (!opened && errCode !== "ECONNREFUSED") {
      const delay = _backoffDelay(backoffAttempt++);
      unreachable = true;
      console.error(
        `[PolterTab MCP] Primary on port ${WS_PORT} is not responding (${errCode || code}). Retrying in ${delay}ms.`,
      );
      scheduleRetry(connectToPrimary, delay);
      return;
    }

    // The Primary went away, or closed this node without saying why (as a
    // pre-1.8 Primary does at its limit). Probe first; promote only if the port
    // is free. A node that was never accepted stays on the backoff schedule, so
    // even a codeless refusal cannot loop at full speed.
    const delay = accepted
      ? PROMOTION_DELAY_MS + Math.floor(Math.random() * PROMOTION_JITTER_MS)
      : _backoffDelay(backoffAttempt++);
    console.error(
      `[PolterTab MCP] Connection to Primary lost. Attempting to become Primary in ${delay}ms...`,
    );
    scheduleRetry(promoteOrRejoin, delay);
  });

  ws.on("error", (err) => {
    errCode = err.code || null;
    console.error(`[PolterTab MCP] Secondary WebSocket error: ${err.message}`);
  });
}

// Reading the capture buffer needs a tab, and the caller may not have named one
// — so ask the extension which tab it is actually on. Written out twice before
// (Primary answering a Secondary, and Primary answering itself), which is why
// the `clear` default and the envelope shape had to be kept in sync by hand.
async function readNetworkState(params = {}) {
  let tabId = params.tabId;
  if (!tabId) {
    const tabInfo = await sendCommand("get_url", params);
    tabId = tabInfo.tabId;
  }

  let data = [];
  if (tabId && networkState.has(tabId)) {
    data = networkState.get(tabId).requests;
    // Reading is destructive by default: the buffer is a tail of what happened
    // since the last read, and leaving it in place makes every later read
    // re-report traffic the caller already saw.
    if (params.clear !== false) {
      networkState.get(tabId).requests = [];
    }
  }

  return { tabId, capturedRequests: data.length, data };
}

// Dispatch a proxy command to the extension. Must be called AFTER
// extensionInFlight has already been incremented by the caller. Arms the
// command timeout; on either a reply or a timeout, decrements extensionInFlight
// and drains the queue so the next waiting command gets its turn.
function _dispatchProxyNow(callerWs, id, action, params) {
  const timer = setTimeout(() => {
    pendingCommands.delete(id);
    extensionInFlight--;
    _tryDequeue();
    if (callerWs.readyState === WebSocket.OPEN) {
      callerWs.send(
        JSON.stringify({ id, success: false, error: `Command '${action}' timed out.` }),
      );
    }
  }, COMMAND_TIMEOUT_MS);
  pendingCommands.set(id, { isProxy: true, sourceWs: callerWs, timer });
  // Belt-and-braces: _tryDequeue's open-check guards the common case; this
  // catches the narrow race where the extension socket closes between that
  // check and the actual send (both are synchronous, but the close event is
  // delivered between event-loop ticks, so the race is real on high-load paths).
  try {
    extensionSocket.send(
      JSON.stringify({ ..._buildEnvelope(action, params, callerWs.nodeId), id }),
    );
  } catch (err) {
    clearTimeout(timer);
    pendingCommands.delete(id);
    extensionInFlight--;
    _tryDequeue();
    if (callerWs.readyState === WebSocket.OPEN) {
      callerWs.send(
        JSON.stringify({ id, success: false, error: "Browser extension not connected to Primary." }),
      );
    }
  }
}

function setupPrimaryWss(wss) {
  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.supportsNewCloseCodes = false;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (message) => {
      try {
        const msg = JSON.parse(message);

        if (msg.type === "secondary_mcp") {
          // Only a Secondary that names its version understands a 4xxx close.
          // An older one answers any close by trying to promote — the loop this
          // limit used to trigger — so it is never refused and never counted.
          ws.supportsNewCloseCodes =
            typeof msg.version === "string" && msg.version !== "";
          if (ws.supportsNewCloseCodes) {
            let v2 = 0;
            for (const [id, c] of secondaryClients) {
              if (id !== msg.nodeId && c.supportsNewCloseCodes) v2++;
            }
            if (v2 >= MAX_SECONDARIES) {
              console.error(
                `[PolterTab MCP] Rejecting secondary node ${msg.nodeId} - limit reached.`,
              );
              ws.close(
                4000,
                JSON.stringify({
                  reason: "capacity_rejected",
                  limit: MAX_SECONDARIES,
                  retry_in_ms: PROMOTION_BACKOFF_INITIAL_MS,
                  pid: process.pid,
                }),
              );
              return;
            }
          }
          // Same node, new socket: the old one is dead weight the client may
          // never end, and the close guard below keeps its close harmless.
          const displaced = secondaryClients.get(msg.nodeId);
          if (displaced && displaced !== ws && displaced.readyState === WebSocket.OPEN) {
            displaced.close(1000);
          }
          secondaryClients.set(msg.nodeId, ws);
          ws.nodeId = msg.nodeId;
          ws.version = msg.version || null;
          ws.pid = msg.pid || null;
          ws.parentPid = msg.parentPid || null;
          ws.lastCommandAt = Date.now();
          console.error(
            `[PolterTab MCP] Secondary node connected: ${msg.nodeId}. Total secondaries: ${secondaryClients.size}`,
          );
          if (ws.supportsNewCloseCodes) {
            ws.send(
              JSON.stringify({
                type: "secondary_accepted",
                nodeId: msg.nodeId,
                primaryVersion: OWN_VERSION,
              }),
            );
          }
          broadcastSessionState();
          return;
        }

        if (msg.type === "request_full_state") {
          broadcastSessionState();
          return;
        }

        if (msg.type === "proxy_command") {
          const { id, action } = msg;
          // No nodeId means no secondary_mcp yet — or a socket refused with
          // 4000 an instant ago. The extension would bucket its command as the
          // Primary agent's and move that agent's current tab; a refused
          // socket would not even get the reply. A well-behaved client's
          // handshake always precedes its first command on the same socket.
          if (!ws.nodeId) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  id,
                  success: false,
                  error: "[not_registered] Send secondary_mcp before proxy_command.",
                }),
              );
            }
            return;
          }
          // Each command restarts this Secondary's idle clock.
          ws.lastCommandAt = Date.now();
          // Stamp which agent is asking, from the socket rather than the
          // message, so the extension keeps this Secondary's current tab apart
          // from the Primary's and every other Secondary's.
          const params = { ...(msg.params || {}), _client: ws.nodeId };
          if (params && params.tabId) {
            ws.lastTabId = params.tabId;
            broadcastSessionState();
          }

          if (action === "get_network_state") {
            (async () => {
              try {
                const data = await readNetworkState(params);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ id, success: true, data }));
                }
              } catch (err) {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({ id, success: false, error: err.message }),
                  );
                }
              }
            })();
            return;
          }

          if (
            !extensionSocket ||
            extensionSocket.readyState !== WebSocket.OPEN
          ) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  id,
                  success: false,
                  error: "Browser extension not connected to Primary.",
                }),
              );
            }
            return;
          }

          // Legacy secondaries bypass the queue: they cannot receive `queued`
          // or `dispatched` frames, so they go straight to the extension and
          // keep today's timing contract. They still count toward extensionInFlight
          // so v2 commands behind them wait their turn.
          if (!ws.supportsNewCloseCodes) {
            extensionInFlight++;
            const timer = setTimeout(() => {
              pendingCommands.delete(id);
              extensionInFlight--;
              _tryDequeue();
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ id, success: false, error: `Command '${action}' timed out.` }));
              }
            }, COMMAND_TIMEOUT_MS);
            pendingCommands.set(id, { isProxy: true, sourceWs: ws, timer });
            extensionSocket.send(JSON.stringify({ ..._buildEnvelope(action, msg.params, ws.nodeId), id }));
            return;
          }

          // v2 Secondary: use the concurrency cap and queue.
          if (extensionInFlight < MAX_EXTENSION_CONCURRENCY) {
            // Free slot: dispatch immediately. No queued frame.
            extensionInFlight++;
            _dispatchProxyNow(ws, id, action, msg.params);
          } else {
            // Slot full: enqueue if there is room in this secondary's queue.
            const srcQueue = queuedBySource.get(ws);
            const depth = srcQueue ? srcQueue.length : 0;
            if (depth >= PER_SECONDARY_QUEUE_DEPTH) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  id,
                  success: false,
                  error: `[queue_full action=${action}] Per-secondary queue depth (${PER_SECONDARY_QUEUE_DEPTH}) reached. Try again shortly.`,
                }));
              }
              return;
            }
            const ackSentAt = Date.now();
            const position = depth + 1;
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "queued", id, position }));
            }
            _rrEnqueue(ws, {
              id,
              action,
              params: msg.params,
              nodeId: ws.nodeId,
              ackSentAt,
              callerWs: ws,
              onDispatch() {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "dispatched", id }));
                }
                _dispatchProxyNow(ws, id, action, msg.params);
              },
              onTimeout() {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    id,
                    success: false,
                    error: `[queue_timeout action=${action}] Command queued too long; dropped to prevent ghost execution.`,
                  }));
                }
              },
            });
          }
          return;
        }

        // Handle keepalive pings
        if (msg.type === "ping" || msg.type === "extension_ready") {
          if (!ws.nodeId) {
            // if it's the extension
            if (
              extensionSocket &&
              extensionSocket !== ws &&
              extensionSocket.readyState === WebSocket.OPEN
            ) {
              console.error(
                "[PolterTab MCP] Another extension trying to connect. Dropping old connection.",
              );
              extensionSocket.close();
            }
            if (extensionSocket !== ws) {
              extensionSocket = ws;
              console.error("[PolterTab MCP] Chrome extension connected.");
            }
            // The extension has always sent its version here and we always
            // dropped it, so the one mismatch that actually breaks commands was
            // invisible to both halves.
            if (msg.version && msg.version !== extensionVersion) {
              extensionVersion = msg.version;
              updates.recordExtension(POLTERTAB_HOME, msg.version);
              const sk = updates.skew(OWN_VERSION, msg.version);
              console.error(
                `[PolterTab MCP] Extension v${msg.version} (server v${OWN_VERSION})` +
                  (sk ? ` — VERSION SKEW: ${sk.kind}` : ""),
              );
              // Let the extension show the mismatch in its popup; it cannot
              // know the server's version otherwise.
              try {
                ws.send(
                  JSON.stringify({ type: "server_version", version: OWN_VERSION }),
                );
              } catch (_) {
                // A socket that died mid-handshake reconnects on its own.
              }
            }
          }
          return;
        }

        // Handle captured network data
        if (msg.type === "network_data") {
          const { tabId, url, body } = msg;
          if (!networkState.has(tabId)) {
            networkState.set(tabId, { lastUpdated: Date.now(), requests: [] });
          }
          const state = networkState.get(tabId);
          state.lastUpdated = Date.now();

          try {
            // Truncate bodies over 1MB
            let processedBody = body;
            if (body && body.length > NETWORK_MAX_BODY_BYTES) {
              processedBody =
                '{"error": "Payload exceeded 1MB limit and was truncated"}';
            }

            const jsonBody = JSON.parse(processedBody);
            state.requests.push({ url, timestamp: Date.now(), data: jsonBody });
          } catch (e) {
            state.requests.push({ url, timestamp: Date.now(), data: body });
          }

          if (state.requests.length > NETWORK_MAX_REQUESTS) {
            state.requests.shift();
          }
          return;
        }

        // Handle tab closed
        if (msg.type === "tab_closed") {
          const { tabId } = msg;
          if (networkState.has(tabId)) {
            console.error(
              `[PolterTab MCP] Clearing network state for closed tab ${tabId}`,
            );
            networkState.delete(tabId);
          }
          return;
        }

        // Response from Extension
        if (msg.id && pendingCommands.has(msg.id)) {
          const cmd = pendingCommands.get(msg.id);
          clearTimeout(cmd.timer);
          pendingCommands.delete(msg.id);

          // Every reply frees a slot; try to drain the queue before doing
          // anything else so the next command lands on the extension with
          // minimum latency.
          extensionInFlight--;
          _tryDequeue();

          if (cmd.isProxy) {
            // Idle time counts from the reply, so a long command cannot leave
            // its Secondary already due for eviction the moment it finishes.
            cmd.sourceWs.lastCommandAt = Date.now();
            if (cmd.sourceWs.readyState === WebSocket.OPEN) {
              cmd.sourceWs.send(JSON.stringify(msg));
            }
          } else if (msg.success) {
            cmd.resolve(msg.data);
          } else {
            cmd.reject(new Error(msg.error || "Unknown extension error"));
          }
        }
      } catch (err) {
        console.error("[PolterTab MCP] Failed to parse message", err);
      }
    });

    ws.on("close", () => {
      if (ws.nodeId) {
        console.error(
          `[PolterTab MCP] Secondary node disconnected: ${ws.nodeId}`,
        );
        // A node now keeps its id across reconnects, so its new socket may
        // already be registered by the time the old one's close arrives.
        if (secondaryClients.get(ws.nodeId) === ws) {
          secondaryClients.delete(ws.nodeId);
          broadcastSessionState();
        }
      } else if (extensionSocket === ws) {
        console.error("[PolterTab MCP] Chrome extension disconnected.");
        extensionSocket = null;
      }
    });

    ws.on("error", (err) => {
      console.error(`[PolterTab MCP] WebSocket error: ${err.message}`);
    });
  });
}

function shutdown() {
  console.error("[PolterTab MCP] Shutting down...");
  if (wss) wss.close();
  if (httpServer) httpServer.close();
  if (httpServer6) httpServer6.close();
  process.exit(0);
}
// Helper to wait for WebSocket connection
async function waitForConnection(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// Register a pending command, arm its timeout, send it, and unwind all three if
// the socket throws. This was spelled out twice below — once for the Secondary
// proxy path and once for the direct one — differing only in the envelope and
// the wording of two errors, which left the timeout as two independent facts.
// The third copy (Primary answering a Secondary, in setupPrimaryWss) replies
// over a socket instead of settling a promise, so it stays where it is and
// shares only the constant.
function awaitReply(envelope, { timedOut, sendFailed }) {
  const { id, action } = envelope;
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(timedOut));
    }, COMMAND_TIMEOUT_MS);

    // Re-arm the timer when the Primary sends a `queued` or `dispatched`
    // frame (U11). The frame means the Primary is actively working on this
    // command and extends the budget by a full COMMAND_TIMEOUT_MS from now.
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        pendingCommands.delete(id);
        reject(new Error(timedOut));
      }, COMMAND_TIMEOUT_MS);
      const entry = pendingCommands.get(id);
      if (entry) entry.timer = timer;
    };

    pendingCommands.set(id, { resolve, reject, timer, action, resetTimer });

    try {
      extensionSocket.send(JSON.stringify(envelope));
    } catch (err) {
      clearTimeout(timer);
      pendingCommands.delete(id);
      reject(new Error(sendFailed(err)));
    }
  });
}

// Build the envelope that goes to the extension. Strips reserved keys (_client,
// id, action) from caller-supplied params so a tool argument named "_client"
// cannot spoof the routing identity, and stamps activeNodeId as _client when
// the caller is a promoted Secondary that still holds a node UUID.
function _buildEnvelope(action, params, activeNodeId) {
  const { _client: _c, id: _i, action: _a, ...safeParams } = params || {};
  return {
    id: crypto.randomUUID(),
    action,
    ...safeParams,
    ...(activeNodeId ? { _client: activeNodeId } : {}),
  };
}

// Helper to send command to the extension
async function sendCommand(action, params) {
  // Evicted, or a caller ahead of this one is already reconnecting: wait for
  // that one dial rather than racing it.
  if (isEvicted || reconnect) await lazyReconnect();

  let isConnected = await waitForConnection(5000);

  // During the wait the Primary may have evicted us (4001) or a concurrent
  // dial may have started; take the lazy path rather than erroring immediately.
  if (!isConnected && (isEvicted || reconnect)) {
    await lazyReconnect();
    isConnected = await waitForConnection(5000);
  }

  if (isSecondary) {
    if (!isConnected) {
      if (refusal && refusal.reason === "capacity_rejected") {
        const s = Math.max(0, Math.ceil((refusal.retryAt - Date.now()) / 1000));
        throw new Error(
          `[capacity_rejected limit=${refusal.limit}] Primary (pid ${refusal.pid}) has ${refusal.limit} secondaries. Retry in ${s}s.`,
        );
      }
      if (unreachable) {
        throw new Error(
          `[primary_unreachable port=${WS_PORT}] Primary is not responding. Backing off.`,
        );
      }
      throw new Error("Secondary node not connected to Primary MCP server.");
    }

    // No session is injected any more. It used to be ("agent_<nodeId>"), which
    // overrode every browser_tab_switch this agent made, and an unknown session
    // fell through to the Primary's active tab anyway. The Primary now stamps
    // this node's id as _client and the extension keeps a current tab per
    // client, so a Secondary's first navigate opens its own tab.

    return awaitReply(
      { type: "proxy_command", id: crypto.randomUUID(), action, params },
      {
        timedOut: `Proxy Command '${action}' timed out after ${COMMAND_TIMEOUT_MS / 1000} seconds.`,
        sendFailed: (e) =>
          `Failed to proxy command to Primary over WebSocket: ${e.message}`,
      },
    );
  }

  if (!isConnected) {
    throw new Error(
      `Browser extension not connected. Please ensure the extension is installed, enabled, and pointing to the correct port (default: ${DEFAULT_WS_PORT}).`,
    );
  }

  const envelope = _buildEnvelope(action, params, nodeId);
  const timedOut = `Command '${action}' timed out after ${COMMAND_TIMEOUT_MS / 1000} seconds.`;
  const sendFailed = (e) => `Failed to send command over WebSocket: ${e.message}`;

  // Primary's own commands share the concurrency cap and the round-robin
  // queue with proxy commands. The timer is armed at dispatch, not enqueue,
  // so the budget does not shrink while the command waits for a free slot.
  if (extensionInFlight < MAX_EXTENSION_CONCURRENCY) {
    extensionInFlight++;
    return _awaitPrimaryReply(envelope, { timedOut, sendFailed });
  }
  return new Promise((resolve, reject) => {
    const ackSentAt = Date.now();
    _rrEnqueue(PRIMARY_SOURCE, {
      id: envelope.id,
      action: envelope.action,
      ackSentAt,
      callerWs: null, // no secondary WS — primary commands have no caller socket
      onDispatch() {
        // extensionInFlight already incremented by _tryDequeue
        _awaitPrimaryReply(envelope, { timedOut, sendFailed }).then(resolve, reject);
      },
      onTimeout() {
        reject(new Error(timedOut));
      },
    });
  });
}

// Register, arm, send, and settle one primary-mode command. Called after
// extensionInFlight has already been incremented.
function _awaitPrimaryReply(envelope, { timedOut, sendFailed }) {
  const { id, action } = envelope;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      extensionInFlight--;
      _tryDequeue();
      reject(new Error(timedOut));
    }, COMMAND_TIMEOUT_MS);
    pendingCommands.set(id, { resolve, reject, timer, action });
    try {
      extensionSocket.send(JSON.stringify(envelope));
    } catch (err) {
      clearTimeout(timer);
      pendingCommands.delete(id);
      extensionInFlight--;
      _tryDequeue();
      reject(new Error(sendFailed(err)));
    }
  });
}

// The Primary's view of which tab the agent is working in, shown in the
// extension popup. Collapses what used to be four copies of
// `primaryLastTabId = x; broadcastSessionState();` scattered through the tool
// dispatch, each with its own guard.
function noteActiveTab(tabId) {
  if (isSecondary || !tabId) return;
  primaryLastTabId = tabId;
  broadcastSessionState();
}

function start() {
  setupPrimaryServer();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = {
  start,
  sendCommand,
  readNetworkState,
  noteActiveTab,
  isSecondary: () => isSecondary,
  isEvicted: () => isEvicted,
  extensionVersion: () => extensionVersion,
  _buildEnvelope,
  _backoffDelay,
  _probePrimary: probePrimary,
};
