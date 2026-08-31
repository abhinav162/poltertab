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
  nodeId = crypto.randomUUID();
  console.error(
    `[PolterTab MCP] Node ${nodeId} running as Secondary. Connecting to Primary...`,
  );

  connectToPrimary();
}

function connectToPrimary() {
  extensionSocket = new WebSocket(`ws://localhost:${WS_PORT}`, {
    perMessageDeflate: true,
  });

  extensionSocket.on("open", () => {
    console.error("[PolterTab MCP] Connected to Primary MCP Server.");
    extensionSocket.send(JSON.stringify({ type: "secondary_mcp", nodeId }));
  });

  extensionSocket.on("message", (message) => {
    try {
      const msg = JSON.parse(message);
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

  extensionSocket.on("close", () => {
    console.error(
      "[PolterTab MCP] Connection to Primary lost. Attempting to become Primary...",
    );
    extensionSocket = null;

    // Reject all pending commands
    for (const [id, { reject, timer }] of pendingCommands) {
      clearTimeout(timer);
      reject(new Error("Primary node disconnected. Command aborted."));
      pendingCommands.delete(id);
    }

    // Try to become primary with exponential backoff & jitter
    const delay =
      PROMOTION_DELAY_MS + Math.floor(Math.random() * PROMOTION_JITTER_MS);

    setTimeout(() => {
      isSecondary = false;
      setupPrimaryServer();
    }, delay);
  });

  extensionSocket.on("error", (err) => {
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
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (message) => {
      try {
        const msg = JSON.parse(message);

        if (msg.type === "secondary_mcp") {
          if (secondaryClients.size >= MAX_SECONDARIES) {
            console.error(
              `[PolterTab MCP] Rejecting secondary node ${msg.nodeId} - limit reached.`,
            );
            ws.close();
            return;
          }
          secondaryClients.set(msg.nodeId, ws);
          ws.nodeId = msg.nodeId;
          console.error(
            `[PolterTab MCP] Secondary node connected: ${msg.nodeId}. Total secondaries: ${secondaryClients.size}`,
          );
          broadcastSessionState();
          return;
        }

        if (msg.type === "request_full_state") {
          broadcastSessionState();
          return;
        }

        if (msg.type === "proxy_command") {
          const { id, action, params } = msg;
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
          extensionSocket.send(JSON.stringify({ id, action, ...params }));
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
        secondaryClients.delete(ws.nodeId);
        broadcastSessionState();
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

// Helper to send command to the extension
async function sendCommand(action, params) {
  const isConnected = await waitForConnection(5000);

  if (isSecondary) {
    if (!isConnected) {
      throw new Error("Secondary node not connected to Primary MCP server.");
    }

    // Auto-inject a unique session to prevent collisions over shared tabs
    if (!params.session) {
      params.session = "agent_" + nodeId;
    }

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
    { id: crypto.randomUUID(), action, ...params },
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
};
