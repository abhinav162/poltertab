# Research: Building a Browser Automation MCP Server in Node.js

## 1. Official `@modelcontextprotocol/sdk` & Stdio Implementation

The official SDK for building Model Context Protocol (MCP) servers in Node.js/TypeScript is `@modelcontextprotocol/sdk`. It supports multiple transport mechanisms, primarily Stdio (for local execution by an agent) and SSE (Server-Sent Events, for network execution).

**Required Packages:**

```bash
npm install @modelcontextprotocol/sdk
```

**Implementing a Server over Stdio:**

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Initialize the server
const server = new Server(
  {
    name: "poltertab-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {}, // Enable tools capability
    },
  }
);

// Start the server over Stdio
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("MCP Server running on stdio");
}
run();
```

## 2. Defining and Exposing Tools

Tools in an MCP server are defined by handling the `ListToolsRequestSchema` (to broadcast available capabilities) and the `CallToolRequestSchema` (to execute the actions).

```typescript
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Expose tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "navigate",
        description: "Navigate to any URL in the browser",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            tabId: { type: "number" }
          },
          required: ["url"],
        },
      },
      {
        name: "click",
        description: "Click an element on the page",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string" },
            tabId: { type: "number" }
          },
          required: ["selector"],
        },
      },
      // Other tools like scrape, screenshot, fill...
    ],
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  if (name === "navigate") {
    const url = String(args.url);
    // Execute navigation via Chrome Extension WebSocket
    return {
      content: [
        {
          type: "text",
          text: `Navigated to ${url}`,
        },
      ],
    };
  }
  
  throw new Error(`Tool not found: ${name}`);
});
```

## 3. Existing Browser Automation MCP Servers

The official `@modelcontextprotocol/server-puppeteer` is a canonical example of a browser automation MCP server.

**Typical Tools Exposed:**

- `puppeteer_navigate`: URL to navigate to, optionally with browser launch options.
- `puppeteer_screenshot`: Capture entire page or specific elements (returns base64 text).
- `puppeteer_click`: Click elements via CSS selectors.
- `puppeteer_hover`: Hover elements.
- `puppeteer_fill`: Input text into fields.
- `puppeteer_evaluate`: Execute raw JavaScript in the browser context.

The structure of the Puppeteer server confirms that exposing atomic browser actions (click, fill, screenshot, navigate) is the standard pattern for browser MCPs.

## 4. Architecture Pattern for Converting the Node REST API

Currently, the ZeroClaw bridge server works as follows:
`Agent -> [HTTP POST] -> Bridge Server -> [WebSocket] -> Chrome Extension`

**Target Architecture (MCP):**
`Agent (MCP Client) -> [Stdio or SSE Transport] -> Bridge Server (MCP Server) -> [WebSocket] -> Chrome Extension`

**Migration Steps:**

1. **Replace Built-in HTTP with MCP Server**: Replace the HTTP REST server in `server.js` with the MCP `Server` instance.
2. **Convert REST Endpoints to Tools**: Transform the current `/command` REST router logic into the `CallToolRequestSchema` handler. Actions like `navigate`, `click`, and `scrape` become MCP tools.
3. **Keep WebSocket Intact**: The WebSocket server (`ws` module) on port 7822 that the Chrome extension connects to remains completely unchanged. The MCP tool handlers will simply forward messages down the existing WebSocket connections.
4. **Agent Integration**: Any standard MCP client (e.g., Claude Desktop, Cursor, or an upgraded ZeroClaw agent) can now spawn the bridge server using `node server.js` (over stdio) and instantly gain the ability to control the Chrome extension.
