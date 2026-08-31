#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");
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
const MEMORY_DIR = path.join(POLTERTAB_HOME, "navigation_memory");
const DOWNLOADS_DIR = path.join(POLTERTAB_HOME, "downloads");

fs.mkdirSync(MEMORY_DIR, { recursive: true });

const updates = require("./update-check.js");
const OWN_VERSION = require("./../package.json").version;

// Populated when the extension connects; stays null until then, which is itself
// worth reporting — a skew warning must not fire on "no extension yet".
let extensionVersion = null;
let updateState = { latest: null, updateAvailable: false };
let noticeDelivered = false;

// Fire and forget at startup so the answer is ready by the first tool call.
// A rejected promise here must never reach the top level.
if (!updates.disabled()) {
  updates
    .checkForUpdate({ current: OWN_VERSION, home: POLTERTAB_HOME })
    .then((r) => {
      updateState = r;
    })
    .catch(() => {});
}

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

// Port configuration: use MCP_BROWSER_WS_PORT env, or --port CLI arg, or 7822 fallback
let WS_PORT = process.env.MCP_BROWSER_WS_PORT
  ? parseInt(process.env.MCP_BROWSER_WS_PORT, 10)
  : 7822;
const portArgIndex = process.argv.indexOf("--port");
if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
  WS_PORT = parseInt(process.argv[portArgIndex + 1], 10);
}

// A command that goes unanswered this long is reported as timed out. Must stay
// comfortably above the extension's own navigation budget (30s wait + 500ms
// settle in background.js) or a slow-but-successful page load surfaces here as
// a timeout the caller can only answer by guessing whether to retry.
const COMMAND_TIMEOUT_MS = 35000;

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
    }, 60000); // 60 seconds

    wss.on("close", () => {
      clearInterval(interval);
    });

    // Network State Garbage Collector (TTL: 5 minutes)
    setInterval(() => {
      const now = Date.now();
      for (const [tabId, state] of networkState.entries()) {
        if (now - state.lastUpdated > 5 * 60 * 1000) {
          console.error(
            `[PolterTab MCP] Garbage collecting network state for tab ${tabId}`,
          );
          networkState.delete(tabId);
        }
      }
    }, 60000);

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
    const jitter = Math.floor(Math.random() * 2000);
    const delay = 500 + jitter;

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
          if (secondaryClients.size >= 5) {
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
            if (body && body.length > 1024 * 1024) {
              processedBody =
                '{"error": "Payload exceeded 1MB limit and was truncated"}';
            }

            const jsonBody = JSON.parse(processedBody);
            state.requests.push({ url, timestamp: Date.now(), data: jsonBody });
          } catch (e) {
            state.requests.push({ url, timestamp: Date.now(), data: body });
          }

          // Cap at 500 requests
          if (state.requests.length > 500) {
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

// Start the server
setupPrimaryServer();

function shutdown() {
  console.error("[PolterTab MCP] Shutting down...");
  if (wss) wss.close();
  if (httpServer) httpServer.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

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
      "Browser extension not connected. Please ensure the extension is installed, enabled, and pointing to the correct port (default: 7822).",
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

// Create MCP Server
const server = new Server(
  {
    name: "poltertab-browser-mcp",
    // Read, not hardcoded: this said "1.0.0" through every release, so the
    // version the client reported had nothing to do with what was installed.
    version: OWN_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Every page-facing tool accepts the same two targeting parameters and, if it
// reads anything back, the same sink. They were copy-pasted into all 23 schemas,
// which is how `session` ended up described on browser_navigate and nowhere else
// — fifteen tools offered the model a bare string with no hint what it does.
const TARGET = {
  tabId: {
    type: "number",
    description: "Target a specific tab. Omit to use the last tab navigated.",
  },
  session: {
    type: "string",
    description:
      "Named session (tab) to run against. Created on first use by browser_navigate, so a loop can keep one tab instead of opening hundreds.",
  },
};

// One description, because writeOutput's behaviour is uniform: records become
// .jsonl/.csv when the extension asks for them, everything else is JSON.
const SINK = {
  output_file: {
    type: "string",
    description:
      "Filename to write the payload under ~/.poltertab/downloads/, returning only a summary (row count, field names, fill rates, two sample records). .jsonl and .csv are written in those formats when the payload carries records, anything else as JSON. A path is reduced to its basename — output cannot be written elsewhere.",
  },
};

// Define tools
const BROWSER_TOOLS = [
  {
    name: "browser_navigate",
    description: "Navigate to any URL in the browser",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        ...TARGET,
      },
      required: ["url"],
    },
  },
  {
    name: "browser_click",
    description: "Click an element on the page",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        ...TARGET,
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_fill",
    description: "Fill an input field with text",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        value: { type: "string" },
        submit: { type: "boolean" },
        ...TARGET,
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "browser_scrape",
    description:
      "Scrape the page or specific elements. For repeating records (cards, rows, listings) use browser_extract instead — it keeps fields grouped per record.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        attribute: {
          type: "string",
          description:
            "Attribute to read, or 'text' for the element's text. 'href'/'src' come back absolute.",
        },
        multiple: { type: "boolean" },
        fields: {
          type: "array",
          items: {
            type: "string",
            enum: ["meta", "jsonld", "links", "headings", "bodyText"],
          },
          description:
            "Full-page scrape only (no selector): which parts to return. title and url are always included. ['meta','jsonld'] is the cheap structured-data path — og: tags and schema.org blobs without 50KB of body text. Omit for everything.",
        },
        max_text: {
          type: "number",
          description: "Max characters of text per element (default 500)",
        },
        ...SINK,
        ...TARGET,
      },
      required: [],
    },
  },
  {
    name: "browser_extract",
    description:
      "Extract repeating records (cards, rows, listings) with fields grouped per record. Fields resolve INSIDE each record root and a missing field yields null instead of shifting later records' values. Returns fill rates and warns when a field is empty inside the record scope but matches page-wide (record boundary too narrow).",
    inputSchema: {
      type: "object",
      properties: {
        record: {
          type: "string",
          description:
            "Selector for the repeating container, e.g. '.agent-card'. Verify with browser_snapshot that it encloses ALL the fields you want — the element that looks like the card often excludes siblings holding some of them.",
        },
        fields: {
          type: "object",
          description:
            "Map of field name -> {sel, get, many, strip}. sel is relative to the record root; omit it (or use '.') for the root itself. get: 'text' (default) | 'href' | 'src' | any attribute name. many: true collects all matches into an array. strip removes a leading prefix, e.g. 'tel:'.",
          additionalProperties: {
            type: "object",
            properties: {
              sel: { type: "string" },
              get: { type: "string" },
              many: { type: "boolean" },
              strip: { type: "string" },
            },
          },
        },
        anchor: {
          type: "string",
          description:
            "Name of the field that is always present on a real record (usually the detail-page link). Records missing it are dropped as placeholders and counted in 'dropped'.",
        },
        max_text: {
          type: "number",
          description: "Max characters per text field (default 500)",
        },
        probe: {
          type: "boolean",
          description:
            "Page-wide re-check of any field that came back entirely empty (default true)",
        },
        ...SINK,
        ...TARGET,
      },
      required: ["record", "fields"],
    },
  },
  {
    name: "browser_extract_all",
    description:
      "Paginate and extract in one call, with no model round-trip per page. Takes browser_extract's spec plus a URL template, walks pages, dedups on a key, and halts on: limit reached, empty page, a page whose records repeat an earlier page's (the trap where ignored page-size params silently return page 1 again), fill rates collapsing against page 1's baseline, or max_pages. Always reports which condition fired and returns everything collected so far.",
    inputSchema: {
      type: "object",
      properties: {
        url_template: {
          type: "string",
          description:
            "URL with a {page} placeholder, e.g. 'https://www.kw.com/agents?page={page}'",
        },
        record: { type: "string" },
        fields: { type: "object" },
        anchor: { type: "string" },
        key: {
          type: "string",
          description:
            "Field name to dedup on — use a stable per-record identifier such as the detail URL. Falls back to whole-row equality.",
        },
        limit: {
          type: "number",
          description: "Stop after this many records (default 200)",
        },
        offset: {
          type: "number",
          description:
            "Skip this many records from the start of the stream. Pages are re-fetched to reach the offset; pass start_page to skip cheaply.",
        },
        start_page: { type: "number", description: "First page (default 1)" },
        max_pages: {
          type: "number",
          description: "Hard guard on pages fetched (default 50)",
        },
        fill_tolerance: {
          type: "number",
          description:
            "Halt when a field well-populated on the baseline page falls below this fraction of it (default 0.5). 0 disables the check.",
        },
        max_text: { type: "number" },
        ...SINK,
        // Session only, deliberately: this tool drives its own navigation from
        // url_template, so a tabId would be accepted and then ignored.
        session: TARGET.session,
      },
      required: ["url_template", "record", "fields"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture visible tab as base64 PNG. This action will focus the target tab.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET,
      },
      required: [],
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right", "top", "bottom"],
        },
        amount: { type: "number" },
        selector: { type: "string" },
        ...TARGET,
      },
      required: ["direction"],
    },
  },
  {
    name: "browser_hover",
    description: "Hover over an element",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        ...TARGET,
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_get_text",
    description: "Get text content of an element",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        max_text: {
          type: "number",
          description:
            "Max characters (default 10000). The result flags it when text was cut.",
        },
        ...SINK,
        ...TARGET,
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_get_title",
    description: "Get page title and URL",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET,
      },
      required: [],
    },
  },
  {
    name: "browser_get_url",
    description: "Get page URL",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET,
      },
      required: [],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Get a snapshot of the DOM. Large pages run to tens of KB — narrow it with interactive_only/max_nodes, or send it to output_file, before spending the context on it.",
    inputSchema: {
      type: "object",
      properties: {
        interactive_only: {
          type: "boolean",
          description: "Only clickable/typable elements",
        },
        max_nodes: {
          type: "number",
          description: "Cap on nodes returned (default 400)",
        },
        max_depth: { type: "number" },
        ...SINK,
        ...TARGET,
      },
      required: [],
    },
  },
  {
    name: "browser_get_network_state",
    description:
      "Get captured raw JSON data (GraphQL/XHR) for the current tab, bypassing DOM virtualization",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET,
        clear: {
          type: "boolean",
          description: "Clear the buffer after reading (default: true)",
        },
        ...SINK,
      },
      required: [],
    },
  },
  {
    name: "browser_set_intercept_patterns",
    description:
      "Set URL substrings to determine which network requests are captured in the MAIN world.",
    inputSchema: {
      type: "object",
      properties: {
        patterns: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of substrings (e.g. ['graphql', '/api/v1/comments'])",
        },
        ...TARGET,
      },
      required: ["patterns"],
    },
  },
  {
    name: "browser_smart_scroll",
    description:
      "Scroll the page and wait for new network data to load (handles lazy-loading)",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "number" },
        ...TARGET,
      },
      required: ["direction"],
    },
  },
  {
    name: "browser_session_create",
    description: "Create or track a named browser session (tab)",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        url: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "browser_session_switch",
    description: "Switch to a different tracked session",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "browser_session_list",
    description: "List all tracked sessions",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "browser_session_close",
    description: "Close a tracked session",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "browser_session_context",
    description: "Get context info for the current active session",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "browser_get_site_memory",
    description:
      "Get navigation memory, obstacles, and fixes for a specific website domain",
    inputSchema: {
      type: "object",
      properties: {
        hostname: {
          type: "string",
          description: "e.g., 'www.linkedin.com' or 'x.com'",
        },
        domain: { type: "string", description: "Alias for hostname" },
      },
      required: [],
    },
  },
  {
    name: "browser_save_site_memory",
    description:
      "Save a new navigation memory, obstacle, or fix for a specific website domain",
    inputSchema: {
      type: "object",
      properties: {
        hostname: { type: "string", description: "e.g., 'www.linkedin.com'" },
        domain: { type: "string", description: "Alias for hostname" },
        obstacle: {
          type: "string",
          description: "What broke or was difficult?",
        },
        solution: { type: "string", description: "How did you solve it?" },
      },
      required: ["obstacle", "solution"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: BROWSER_TOOLS,
  };
});

// --- Output handling ---
//
// The raw payload must never be the default path into the context window. Two
// costs dominated a 100-record scrape and neither was the data: envelopes
// several lines of JSON deep to carry one short string, and the agent then
// re-typing every record by hand into a file. Writing straight to disk removes
// both.

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = Array.isArray(v)
      ? v.join(" | ")
      : typeof v === "object"
        ? JSON.stringify(v) // beats a column of "[object Object]"
        : String(v);
    // Quote only when it would otherwise break the row, and double any
    // embedded quote — the two mistakes that produce a file which imports
    // silently and wrongly.
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => cell(r[c])).join(",")),
  ].join("\n");
}

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

const isBlank = (v) =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);

// `rows` is passed separately when the payload has a records array: .jsonl and
// .csv are formats for records, not for envelopes.
function writeOutput(name, payload, rows) {
  const requested = String(name);
  const safeName = path.basename(requested);
  const parts = safeName.split(".");
  const ext = parts.length > 1 ? `.${parts.pop()}` : "";
  const base = parts.join(".");
  const finalName = `${base}_${Date.now()}${ext}`;

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const safePath = path.join(DOWNLOADS_DIR, finalName);

  let body;
  if (rows && ext === ".jsonl") {
    body = rows.map((r) => JSON.stringify(r)).join("\n");
  } else if (rows && ext === ".csv") {
    body = toCsv(rows);
  } else {
    body = JSON.stringify(payload, null, 2);
  }

  fs.writeFileSync(safePath, body);
  const out = { file: safePath, bytes: Buffer.byteLength(body) };

  // Output stays inside DOWNLOADS_DIR: this path comes from a model, and a tool
  // that writes to an arbitrary absolute path is a different capability than
  // one that saves a scrape. But relocating without a word is how a caller ends
  // up looking for a file that was never going to be there.
  if (safeName !== requested) {
    out.note = `output_file is confined to ${DOWNLOADS_DIR} — "${requested}" was written as ${path.basename(safePath)}, not to the path requested.`;
  }
  return out;
}

// What comes back inline when the payload went to disk: enough to know the call
// worked and the shape is right, and nothing more.
function summarizeOutput(payload, rows, written) {
  const summary = { ...written };
  if (rows) {
    summary.rows = rows.length;
    summary.fields = rows.length ? Object.keys(rows[0]) : [];
    summary.sample = rows.slice(0, 2);
    for (const k of ["fill_rates", "dropped", "warnings", "stopped_because", "pages_fetched"]) {
      if (payload && payload[k] !== undefined) summary[k] = payload[k];
    }
  } else if (Array.isArray(payload)) {
    summary.items = payload.length;
    summary.sample = payload.slice(0, 2);
  } else if (payload && typeof payload === "object") {
    summary.keys = Object.keys(payload);
  }
  return summary;
}

// Payload shapes that carry a records array worth writing as jsonl/csv.
function rowsOf(payload) {
  if (payload && Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload)) return payload;
  return null;
}

// --- The pagination loop ---
//
// This exists so the model stops being the for-loop. It supplies the spec once
// and receives records; every page in between costs a browser round-trip
// instead of a model round-trip.
//
// Every halt condition below is a case where continuing would produce data
// that looks complete and is not, so each one names itself in the result. A
// paused run costs far less than a confidently wrong dataset.
async function extractAll(args) {
  const {
    url_template,
    record,
    fields,
    anchor,
    key,
    limit = 200,
    offset = 0,
    start_page = 1,
    max_pages = 50,
    fill_tolerance = 0.5,
    max_text,
    session,
  } = args;

  if (!url_template.includes("{page}")) {
    throw new Error("url_template must contain a {page} placeholder");
  }

  const spec = { record, fields, anchor, max_text, session, probe: true };
  const target = offset + limit;
  const rows = [];
  const seen = new Set();
  const warnings = [];
  const pages = [];

  let baseline = null;
  let stopped_because = "max_pages";
  let page = start_page;
  let fetched = 0;

  const keyOf = (row) =>
    key ? String(row[key] ?? "") : JSON.stringify(row);

  while (fetched < max_pages) {
    const url = url_template.replace("{page}", String(page));
    const nav = await sendCommand("navigate", { url, session });
    fetched++;

    const res = await sendCommand("extract", spec);
    const pageRows = (res && res.rows) || [];
    pages.push({
      page,
      url: nav && nav.url,
      found: res ? res.records_found : 0,
      kept: pageRows.length,
      dropped: res ? res.dropped : 0,
    });
    if (res && res.warnings && res.warnings.length) {
      warnings.push(`page ${page}: ${res.warnings.join("; ")}`);
    }

    if (!pageRows.length) {
      stopped_because = "empty_page";
      break;
    }

    // A site that ignores an unrecognised page param answers every request with
    // page 1. Identical content reads as real data, which is how a "next 100"
    // silently becomes the same 12 records eight times over.
    const fresh = pageRows.filter((r) => !seen.has(keyOf(r)));
    if (!fresh.length) {
      stopped_because = "duplicate_page";
      warnings.push(
        `page ${page} returned only records already seen — pagination is not advancing`,
      );
      break;
    }

    // Fill rates against the first page. A spec learned on page 1 degrades
    // quietly later: variant card layouts, a column that stops being populated.
    // Halting beats emitting rows that are 40% empty.
    const ratios = {};
    for (const [name, n] of Object.entries(res.fill_rates || {})) {
      ratios[name] = n / pageRows.length;
    }
    if (!baseline) {
      baseline = ratios;
    } else if (fill_tolerance > 0) {
      const collapsed = Object.keys(baseline).filter(
        (name) =>
          baseline[name] >= 0.5 &&
          ratios[name] < baseline[name] * fill_tolerance,
      );
      if (collapsed.length) {
        stopped_because = "fill_rate_deviation";
        warnings.push(
          `page ${page}: ${collapsed
            .map(
              (n) =>
                `${n} ${(ratios[n] * 100).toFixed(0)}% vs baseline ${(baseline[n] * 100).toFixed(0)}%`,
            )
            .join(", ")} — page layout likely differs from the learned spec`,
        );
        break;
      }
    }

    for (const r of fresh) {
      seen.add(keyOf(r));
      rows.push(r);
    }

    if (rows.length >= target) {
      stopped_because = "limit_reached";
      break;
    }
    page++;
  }

  const sliced = rows.slice(offset, offset + limit);
  if (offset && fetched) {
    warnings.push(
      `offset ${offset} was reached by fetching from page ${start_page}; pass start_page to skip pages instead of re-reading them`,
    );
  }

  // extract reports fill as counts, so extract_all does too — the per-page
  // baseline is a fraction because it is compared across pages of differing
  // size, and carries the unit in its name rather than looking like a count.
  const fill_rates = {};
  for (const name of Object.keys(fields)) {
    fill_rates[name] = sliced.filter((r) => !isBlank(r[name])).length;
  }

  return {
    rows: sliced,
    count: sliced.length,
    collected: rows.length,
    pages_fetched: fetched,
    last_page: page,
    stopped_because,
    fill_rates,
    baseline_fill_ratios: baseline,
    pages,
    warnings,
  };
}

const handleToolCall = async (request) => {
  const { name, arguments: args } = request.params;

  if (!name.startsWith("browser_")) {
    throw new Error(`Tool not found: ${name}`);
  }

  const action = name.replace("browser_", "");

  try {
    // Custom handling for network state tool
    if (action === "get_network_state") {
      const opts = args || {};
      let responsePayload;

      if (isSecondary) {
        // Proxy it to primary! Primary handles resolving the networkState map
        responsePayload = await sendCommand("get_network_state", opts);
      } else {
        responsePayload = await readNetworkState(opts);
        primaryLastTabId = responsePayload.tabId;
        broadcastSessionState();
      }

      // Must be honoured in BOTH roles. A Secondary that returned the raw
      // payload would flood the very context window this parameter exists to
      // protect.
      if (opts.output_file) {
        const written = writeOutput(opts.output_file, responsePayload);
        return {
          content: [
            {
              type: "text",
              text: `Data successfully written to ${written.file}. Captured ${responsePayload.capturedRequests} requests.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(responsePayload, null, 2),
          },
        ],
      };
    }

    // Custom handling for smart scroll
    if (action === "smart_scroll") {
      const scrollResult = await sendCommand("scroll", args || {});

      if (!isSecondary && scrollResult && scrollResult.tabId) {
        primaryLastTabId = scrollResult.tabId;
        broadcastSessionState();
      }

      // Wait for network requests to arrive (lazy loading)
      await new Promise((r) => setTimeout(r, 2000));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...scrollResult,
                note: "Waited 2s for network data. Use browser_get_network_state to read.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Custom handling for setting intercept patterns globally via storage, then updating current tab
    if (action === "set_intercept_patterns") {
      const result = await sendCommand("set_intercept_patterns", args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (action === "get_site_memory") {
      const host = args.hostname || args.domain || args.url;
      if (!host) throw new Error("Missing 'hostname' parameter");
      const file = memoryFile(host);
      let data = [];
      if (fs.existsSync(file)) {
        data = JSON.parse(fs.readFileSync(file, "utf8"));
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    if (action === "save_site_memory") {
      const host = args.hostname || args.domain || args.url;
      if (!host) throw new Error("Missing 'hostname' parameter");
      const file = memoryFile(host);
      let data = [];
      if (fs.existsSync(file)) {
        data = JSON.parse(fs.readFileSync(file, "utf8"));
      }
      data.push({
        obstacle: args.obstacle,
        solution: args.solution,
        timestamp: Date.now(),
      });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      return {
        content: [{ type: "text", text: "Memory successfully saved." }],
      };
    }

    // Loops in the server, not in the model. One tool call covers every page.
    if (action === "extract_all") {
      const payload = await extractAll(args || {});
      const opts = args || {};

      if (opts.output_file) {
        const written = writeOutput(opts.output_file, payload, payload.rows);
        const { rows, pages, ...rest } = payload;
        const summary = {
          ...rest,
          ...written,
          fields: rows.length ? Object.keys(rows[0]) : [],
          sample: rows.slice(0, 2),
        };
        return {
          content: [
            { type: "text", text: JSON.stringify(summary, null, 2) },
          ],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }

    const result = await sendCommand(action, args || {});

    if (!isSecondary) {
      // Track primary's active tab
      if (result && result.tabId) {
        primaryLastTabId = result.tabId;
        broadcastSessionState();
      } else if (args && args.tabId) {
        primaryLastTabId = args.tabId;
        broadcastSessionState();
      }
    }

    // Any read tool can send its payload to disk. Placed after tab tracking so
    // taking the file path does not cost the session its tab bookkeeping.
    if (args && args.output_file && result && typeof result === "object") {
      const rows = rowsOf(result);
      const written = writeOutput(args.output_file, result, rows);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              summarizeOutput(result, rows, written),
              null,
              2,
            ),
          },
        ],
      };
    }

    // Check if error result string (graceful error handling)
    if (
      typeof result === "string" &&
      result.includes("Cannot interact with this page")
    ) {
      return {
        isError: true,
        content: [{ type: "text", text: result }],
      };
    }

    // Format output
    const textResult =
      typeof result === "object"
        ? JSON.stringify(result, null, 2)
        : String(result);

    return {
      content: [
        {
          type: "text",
          text: textResult,
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: err.message || "Unknown error executing browser command",
        },
      ],
    };
  }
};

// Update and skew notices ride out on the first tool response and never again.
// Doctor and the extension popup both require the user to already suspect
// something is wrong; the agent's reply is the one place they are certainly
// looking. Appended as its own content block so it cannot corrupt a payload
// something downstream is parsing.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await handleToolCall(request);
  if (noticeDelivered) return result;

  const text = updates.notice({
    current: OWN_VERSION,
    latest: updateState.latest,
    updateAvailable: updateState.updateAvailable,
    skew: updates.skew(OWN_VERSION, extensionVersion),
  });
  if (!text) return result;

  noticeDelivered = true;
  if (!result || !Array.isArray(result.content)) return result;
  return { ...result, content: [...result.content, { type: "text", text }] };
});

// Start the server
async function startMcp() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const reset = "\x1b[0m";
  const dim = "\x1b[2m";
  const cyan = "\x1b[36m";
  const purple = "\x1b[35m";
  const bold = "\x1b[1m";

  console.error(`
${purple}╭─────────────────────────────────────────────────────────────────╮${reset}
${purple}│${reset}  ${bold}POLTERTAB${reset}                                                      ${purple}│${reset}
${purple}│${reset}  ${dim}Phantom Browser Automation • Your Profile, Zero Headless${reset}       ${purple}│${reset}
${purple}╰─────────────────────────────────────────────────────────────────╯${reset}

  ${cyan}●${reset} MCP Server             ${bold}[ ACTIVE ]${reset}    ${dim}Connected to stdio transport${reset}
  ${cyan}○${reset} Extension Connection   ${bold}[ WAITING ]${reset}   ${dim}Listening on WebSocket...${reset}

${dim}The AI is now haunting your browser...${reset}
  `);
}

startMcp().catch((err) => {
  console.error("[PolterTab MCP] Failed to start server:", err);
  process.exit(1);
});
