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

// Secondary-side retry state. One counter for the whole reconnect/probe/promote
// cycle, reset only by a Primary's secondary_accepted; `refusal` and
// `unreachable` say why this node is between connections, so a command sent
// meanwhile can name the cause instead of a generic "not connected".
let backoffAttempt = 0;
let retryTimer = null;
let refusal = null;
let unreachable = false;

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
  httpServer = http.createServer();

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
    } else {
      console.error(`[PolterTab MCP] HTTP server error: ${e.message}`);
    }
  });

  httpServer.listen(WS_PORT, () => {
    console.error(
      `[PolterTab MCP] Primary WebSocket server listening on ws://localhost:${WS_PORT}`,
    );
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

    wss.on("close", () => {
      clearInterval(interval);
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

// Is anything listening on the port? Binding to find out is what leaked a
// server per attempt; a refused TCP connect is the only answer that means the
// Primary is gone.
function probePrimary() {
  return new Promise((resolve) => {
    const sock = net.connect(WS_PORT, "localhost");
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
  const ws = new WebSocket(`ws://localhost:${WS_PORT}`, {
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

          const timer = setTimeout(() => {
            pendingCommands.delete(id);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  id,
                  success: false,
                  error: `Command '${action}' timed out.`,
                }),
              );
            }
          }, COMMAND_TIMEOUT_MS);

          pendingCommands.set(id, { isProxy: true, sourceWs: ws, timer });
          // Same envelope construction as the direct path, so a tool argument
          // named id or action cannot override the routing here either. The
          // Primary's own id is kept last: pendingCommands is keyed on it.
          extensionSocket.send(
            JSON.stringify({
              ..._buildEnvelope(action, msg.params, ws.nodeId),
              id,
            }),
          );
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

          if (cmd.isProxy) {
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
  const { id } = envelope;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(timedOut));
    }, COMMAND_TIMEOUT_MS);

    pendingCommands.set(id, { resolve, reject, timer });

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
  const isConnected = await waitForConnection(5000);

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

  return awaitReply(
    _buildEnvelope(action, params, nodeId),
    {
      timedOut: `Command '${action}' timed out after ${COMMAND_TIMEOUT_MS / 1000} seconds.`,
      sendFailed: (e) => `Failed to send command over WebSocket: ${e.message}`,
    },
  );
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
  extensionVersion: () => extensionVersion,
  _buildEnvelope,
  _backoffDelay,
  _probePrimary: probePrimary,
};
