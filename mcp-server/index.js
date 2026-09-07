#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const { SMART_SCROLL_SETTLE_MS, POLTERTAB_HOME } = require("./config.js");

const updates = require("./update-check.js");
const { BROWSER_TOOLS } = require("./tools.js");
const { writeOutput, summarizeOutput, rowsOf } = require("./output.js");
const {
  readMemory,
  saveMemory,
  getSelector,
  recordSelector,
  noteSelectorFail,
} = require("./memory.js");
const { extractAll } = require("./extract-all.js");
const bridge = require("./bridge.js");
const OWN_VERSION = require("./../package.json").version;

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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: BROWSER_TOOLS,
  };
});

// Which host a tab is on, learned from the URL any navigate/get_url/action
// result reveals. Self-heal keys its selector store by host, and clicks happen
// on the page we last saw a URL for — no extra round-trip to ask.
const hostByTab = new Map();
let lastHost = null;

function hostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function rememberHost(tabId, url) {
  const host = hostname(url);
  if (!host) return;
  if (tabId != null) hostByTab.set(tabId, host);
  lastHost = host;
}

function hostForTab(tabId) {
  return (tabId != null && hostByTab.get(tabId)) || lastHost || null;
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

      if (bridge.isSecondary()) {
        // Proxy it to the Primary — it is the one holding the capture buffer.
        responsePayload = await bridge.sendCommand("get_network_state", opts);
      } else {
        responsePayload = await bridge.readNetworkState(opts);
        bridge.noteActiveTab(responsePayload.tabId);
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
      const scrollResult = await bridge.sendCommand("scroll", args || {});
      bridge.noteActiveTab(scrollResult && scrollResult.tabId);

      // Wait for network requests to arrive (lazy loading)
      await new Promise((r) => setTimeout(r, SMART_SCROLL_SETTLE_MS));

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
      const result = await bridge.sendCommand("set_intercept_patterns", args);
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
      // The agent only wants its own notes; the selectors map is internal
      // plumbing for self-healing and would just be noise here.
      return {
        content: [
          { type: "text", text: JSON.stringify(readMemory(host).notes, null, 2) },
        ],
      };
    }

    if (action === "save_site_memory") {
      const host = args.hostname || args.domain || args.url;
      if (!host) throw new Error("Missing 'hostname' parameter");
      saveMemory(host, args.obstacle, args.solution);
      return {
        content: [{ type: "text", text: "Memory successfully saved." }],
      };
    }

    // Loops in the server, not in the model. One tool call covers every page.
    if (action === "extract_all") {
      const payload = await extractAll(bridge.sendCommand, args || {});
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

    // Self-healing: for click/fill, supply a remembered fingerprint when the
    // selector has no explicit one, and remember the fingerprint that worked so
    // a later drift can be relocated. Host is the page this tab last revealed.
    const healable = action === "click" || action === "fill";
    const selector = args && args.selector;
    const host = healable && selector ? hostForTab(args && args.tabId) : null;
    if (host && !args.fingerprint) {
      const stored = getSelector(host, selector);
      if (stored) args.fingerprint = stored.fingerprint;
    }

    let result;
    try {
      result = await bridge.sendCommand(action, args || {});
    } catch (err) {
      // A selector that missed even with its stored fingerprint is drifting;
      // enough misses and memory.js stops trusting it.
      if (host && /not found/i.test(err.message)) noteSelectorFail(host, selector);
      throw err;
    }
    bridge.noteActiveTab((result && result.tabId) || (args && args.tabId));

    // Learn the host for later, and store the fingerprint of what resolved.
    if (result && result.url) {
      rememberHost(result.tabId ?? (args && args.tabId), result.url);
    }
    if (host && result && result.fingerprint) {
      recordSelector(host, selector, result.fingerprint);
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
    skew: updates.skew(OWN_VERSION, bridge.extensionVersion()),
  });
  if (!text) return result;

  noticeDelivered = true;
  if (!result || !Array.isArray(result.content)) return result;
  return { ...result, content: [...result.content, { type: "text", text }] };
});

// Start the server
async function startMcp() {
  bridge.start();

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
