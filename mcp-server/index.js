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

// Setup WebSocket server
const wss = new WebSocket.WebSocketServer({ port: WS_PORT });

wss.on("listening", () => {
  console.error(
    `[ZeroClaw MCP] WebSocket server listening on ws://localhost:${WS_PORT}`,
  );
});

wss.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[ZeroClaw MCP] ERROR: Port ${WS_PORT} is already in use.`);
    console.error(
      `Please use a different port by setting MCP_BROWSER_WS_PORT or passing --port <port>.`,
    );
    console.error(
      `You also need to update the port in the Chrome Extension's Options page.`,
    );
    process.exit(1);
  } else {
    console.error(`[ZeroClaw MCP] WebSocket error: ${err.message}`);
  }
});

wss.on("connection", (ws) => {
  if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
    console.error(
      "[ZeroClaw MCP] Another extension trying to connect. Dropping old connection.",
    );
    extensionSocket.close();
  }

  extensionSocket = ws;
  console.error("[ZeroClaw MCP] Chrome extension connected.");

  ws.on("message", (message) => {
    try {
      const msg = JSON.parse(message);

      // Handle keepalive pings
      if (msg.type === "ping" || msg.type === "extension_ready") {
        return;
      }

      // Handle captured network data
      if (msg.type === "network_data") {
        const { tabId, url, body } = msg;
        if (!networkState.has(tabId)) {
          networkState.set(tabId, []);
        }

        try {
          // Attempt to parse JSON. If it fails, ignore or store as raw.
          const jsonBody = JSON.parse(body);
          networkState
            .get(tabId)
            .push({ url, timestamp: Date.now(), data: jsonBody });
        } catch (e) {
          // Keep raw if not JSON
          networkState
            .get(tabId)
            .push({ url, timestamp: Date.now(), data: body });
        }

        // If a smart_scroll command is waiting for data, we can optionally notify it.
        // For simplicity, we just keep pushing to the buffer.
        return;
      }

      if (msg.id && pendingCommands.has(msg.id)) {
        const { resolve, reject, timer } = pendingCommands.get(msg.id);
        clearTimeout(timer);
        pendingCommands.delete(msg.id);

        if (msg.success) {
          resolve(msg.data);
        } else {
          // If the extension passes back a restricted URL error, we can throw it here or format it.
          // The background script typically sends string errors.
          reject(new Error(msg.error || "Unknown extension error"));
        }
      }
    } catch (err) {
      console.error(
        "[ZeroClaw MCP] Failed to parse message from extension",
        err,
      );
    }
  });

  ws.on("close", () => {
    console.error("[ZeroClaw MCP] Chrome extension disconnected.");
    if (extensionSocket === ws) {
      extensionSocket = null;
    }
  });

  ws.on("error", (err) => {
    console.error(`[ZeroClaw MCP] Extension WebSocket error: ${err.message}`);
  });
});

// Helper to send command to the extension
async function sendCommand(action, params) {
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
async function start() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ZeroClaw MCP] Server connected to stdio transport");
}

start().catch((err) => {
  console.error("[ZeroClaw MCP] Failed to start server:", err);
  process.exit(1);
});
