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
const path = require("path");

const MEMORY_DIR = path.join(__dirname, "navigation_memory");
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR);
}

// Port configuration: use MCP_BROWSER_WS_PORT env, or --port CLI arg, or 7822 fallback
let WS_PORT = process.env.MCP_BROWSER_WS_PORT
  ? parseInt(process.env.MCP_BROWSER_WS_PORT, 10)
  : 7822;
const portArgIndex = process.argv.indexOf("--port");
if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
  WS_PORT = parseInt(process.argv[portArgIndex + 1], 10);
}

// Global state
let extensionSocket = null;
const pendingCommands = new Map();
const networkState = new Map(); // tabId -> array of JSON payloads
const secondaryClients = new Map();

let isSecondary = false;
let nodeId = null;
let wss = null;
let httpServer = null;

function setupPrimaryServer() {
  const http = require("http");
  httpServer = http.createServer();

  httpServer.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(
        `[ZeroClaw MCP] Port ${WS_PORT} in use, switching to Secondary Mode...`,
      );
      startSecondaryMode();
    } else {
      console.error(`[ZeroClaw MCP] HTTP server error: ${e.message}`);
    }
  });

  httpServer.listen(WS_PORT, () => {
    console.error(
      `[ZeroClaw MCP] Primary WebSocket server listening on ws://localhost:${WS_PORT}`,
    );
    wss = new WebSocket.WebSocketServer({ server: httpServer });
    setupPrimaryWss(wss);
  });
}

function startSecondaryMode() {
  isSecondary = true;
  nodeId = crypto.randomUUID();
  console.error(
    `[ZeroClaw MCP] Node ${nodeId} running as Secondary. Connecting to Primary...`,
  );

  connectToPrimary();
}

function connectToPrimary() {
  extensionSocket = new WebSocket(`ws://localhost:${WS_PORT}`);

  extensionSocket.on("open", () => {
    console.error("[ZeroClaw MCP] Connected to Primary MCP Server.");
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
      console.error("[ZeroClaw MCP] Failed to parse message from Primary", err);
    }
  });

  extensionSocket.on("close", () => {
    console.error(
      "[ZeroClaw MCP] Connection to Primary lost. Attempting to become Primary...",
    );
    extensionSocket = null;

    // Reject all pending commands
    for (const [id, { reject, timer }] of pendingCommands) {
      clearTimeout(timer);
      reject(new Error("Primary node disconnected. Command aborted."));
      pendingCommands.delete(id);
    }

    // Try to become primary
    setTimeout(() => {
      isSecondary = false;
      setupPrimaryServer();
    }, 1000);
  });

  extensionSocket.on("error", (err) => {
    console.error(`[ZeroClaw MCP] Secondary WebSocket error: ${err.message}`);
  });
}

function setupPrimaryWss(wss) {
  wss.on("connection", (ws) => {
    ws.on("message", (message) => {
      try {
        const msg = JSON.parse(message);

        if (msg.type === "secondary_mcp") {
          if (secondaryClients.size >= 5) {
            console.error(
              `[ZeroClaw MCP] Rejecting secondary node ${msg.nodeId} - limit reached.`,
            );
            ws.close();
            return;
          }
          secondaryClients.set(msg.nodeId, ws);
          ws.nodeId = msg.nodeId;
          console.error(
            `[ZeroClaw MCP] Secondary node connected: ${msg.nodeId}. Total secondaries: ${secondaryClients.size}`,
          );
          return;
        }

        if (msg.type === "proxy_command") {
          const { id, action, params } = msg;

          if (action === "get_network_state") {
            (async () => {
              try {
                let tabId = params.tabId;
                if (!tabId) {
                  const tabInfo = await sendCommand("get_url", params);
                  tabId = tabInfo.tabId;
                }
                let data = [];
                if (tabId && networkState.has(tabId)) {
                  data = networkState.get(tabId);
                  if (params.clear !== false) {
                    networkState.set(tabId, []);
                  }
                }
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      id,
                      success: true,
                      data: { tabId, capturedRequests: data.length, data },
                    }),
                  );
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
          }, 35000);

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
                "[ZeroClaw MCP] Another extension trying to connect. Dropping old connection.",
              );
              extensionSocket.close();
            }
            if (extensionSocket !== ws) {
              extensionSocket = ws;
              console.error("[ZeroClaw MCP] Chrome extension connected.");
            }
          }
          return;
        }

        // Handle captured network data
        if (msg.type === "network_data") {
          const { tabId, url, body } = msg;
          if (!networkState.has(tabId)) {
            networkState.set(tabId, []);
          }
          try {
            const jsonBody = JSON.parse(body);
            networkState
              .get(tabId)
              .push({ url, timestamp: Date.now(), data: jsonBody });
          } catch (e) {
            networkState
              .get(tabId)
              .push({ url, timestamp: Date.now(), data: body });
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
        console.error("[ZeroClaw MCP] Failed to parse message", err);
      }
    });

    ws.on("close", () => {
      if (ws.nodeId) {
        console.error(
          `[ZeroClaw MCP] Secondary node disconnected: ${ws.nodeId}`,
        );
        secondaryClients.delete(ws.nodeId);
      } else if (extensionSocket === ws) {
        console.error("[ZeroClaw MCP] Chrome extension disconnected.");
        extensionSocket = null;
      }
    });

    ws.on("error", (err) => {
      console.error(`[ZeroClaw MCP] WebSocket error: ${err.message}`);
    });
  });
}

// Start the server
setupPrimaryServer();

function shutdown() {
  console.error("[ZeroClaw MCP] Shutting down...");
  if (wss) wss.close();
  if (httpServer) httpServer.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Helper to send command to the extension
async function sendCommand(action, params) {
  if (isSecondary) {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      throw new Error("Secondary node not connected to Primary MCP server.");
    }

    // Auto-inject a unique session to prevent collisions over shared tabs
    if (!params.session) {
      params.session = "agent_" + nodeId;
    }

    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pendingCommands.delete(id);
        reject(
          new Error(`Proxy Command '${action}' timed out after 35 seconds.`),
        );
      }, 35000);

      pendingCommands.set(id, { resolve, reject, timer });

      try {
        extensionSocket.send(
          JSON.stringify({ type: "proxy_command", id, action, params }),
        );
      } catch (err) {
        clearTimeout(timer);
        pendingCommands.delete(id);
        reject(
          new Error(
            `Failed to proxy command to Primary over WebSocket: ${err.message}`,
          ),
        );
      }
    });
  }

  if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
    throw new Error(
      "Browser extension not connected. Please ensure the extension is installed, enabled, and pointing to the correct port (default: 7822).",
    );
  }

  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();

    // Strict timeout (35 seconds) to prevent hanging
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`Command '${action}' timed out after 35 seconds.`));
    }, 35000);

    pendingCommands.set(id, { resolve, reject, timer });

    try {
      extensionSocket.send(JSON.stringify({ id, action, ...params }));
    } catch (err) {
      clearTimeout(timer);
      pendingCommands.delete(id);
      reject(
        new Error(`Failed to send command over WebSocket: ${err.message}`),
      );
    }
  });
}

// Create MCP Server
const server = new Server(
  {
    name: "zeroclaw-browser-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Define tools
const BROWSER_TOOLS = [
  {
    name: "browser_navigate",
    description: "Navigate to any URL in the browser",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        tabId: { type: "number" },
        session: {
          type: "string",
          description: "Optional session name to track this tab",
        },
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
        tabId: { type: "number" },
        session: { type: "string" },
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
        tabId: { type: "number" },
        session: { type: "string" },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "browser_scrape",
    description: "Scrape the page or specific elements",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        attribute: { type: "string" },
        multiple: { type: "boolean" },
        tabId: { type: "number" },
        session: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture visible tab as base64 PNG. This action will focus the target tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        session: { type: "string" },
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
        tabId: { type: "number" },
        session: { type: "string" },
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
        tabId: { type: "number" },
        session: { type: "string" },
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
        tabId: { type: "number" },
        session: { type: "string" },
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
        tabId: { type: "number" },
        session: { type: "string" },
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
        tabId: { type: "number" },
        session: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "browser_snapshot",
    description: "Get a snapshot of the DOM",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        session: { type: "string" },
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
        tabId: { type: "number" },
        session: { type: "string" },
        clear: {
          type: "boolean",
          description: "Clear the buffer after reading (default: true)",
        },
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
        tabId: { type: "number" },
        session: { type: "string" },
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
        tabId: { type: "number" },
        session: { type: "string" },
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
        hostname: { type: "string", description: "e.g., 'www.linkedin.com'" },
      },
      required: ["hostname"],
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
        obstacle: {
          type: "string",
          description: "What broke or was difficult?",
        },
        solution: { type: "string", description: "How did you solve it?" },
      },
      required: ["hostname", "obstacle", "solution"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: BROWSER_TOOLS,
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!name.startsWith("browser_")) {
    throw new Error(`Tool not found: ${name}`);
  }

  const action = name.replace("browser_", "");

  try {
    // Custom handling for network state tool
    if (action === "get_network_state") {
      if (isSecondary) {
        // Proxy it to primary! Primary handles resolving the networkState map
        const stateResult = await sendCommand("get_network_state", args || {});
        return {
          content: [
            { type: "text", text: JSON.stringify(stateResult, null, 2) },
          ],
        };
      }

      // First, we need to resolve the active tab ID. We can do a dummy 'get_url' command to ask the extension what the current tabId is.
      const tabInfo = await sendCommand("get_url", args || {});
      const tabId = tabInfo.tabId;

      let data = [];
      if (tabId && networkState.has(tabId)) {
        data = networkState.get(tabId);
        if (args.clear !== false) {
          networkState.set(tabId, []);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { tabId, capturedRequests: data.length, data },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Custom handling for smart scroll
    if (action === "smart_scroll") {
      const scrollResult = await sendCommand("scroll", args || {});

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
      const file = path.join(MEMORY_DIR, `${args.hostname}.json`);
      let data = [];
      if (fs.existsSync(file)) {
        data = JSON.parse(fs.readFileSync(file, "utf8"));
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }

    if (action === "save_site_memory") {
      const file = path.join(MEMORY_DIR, `${args.hostname}.json`);
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

    const result = await sendCommand(action, args || {});

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
});

// Start the server
async function startMcp() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ZeroClaw MCP] Server connected to stdio transport");
}

startMcp().catch((err) => {
  console.error("[ZeroClaw MCP] Failed to start server:", err);
  process.exit(1);
});
