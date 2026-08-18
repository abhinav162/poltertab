# Plan: Making ZeroClaw Browser Extension a Pluggable MCP Server

## Context

We are converting the ZeroClaw browser control system into a generic Model Context Protocol (MCP) server so that any MCP-compatible client (Claude Desktop, Cursor, custom agents) can control a Chrome browser. The core architecture uses a Node.js MCP server over Stdio, which then communicates with a Chrome extension via WebSocket.

While the technical mapping (REST to MCP Tools) is straightforward, exposing this to general users introduces UX friction and edge cases that need to be addressed to make it truly seamless.

## Approach

We will implement "First-Level Optimizations" focusing on robust error handling, port configuration, and clear user onboarding. The extension will remain decoupled but we will add UX improvements to both the MCP server and the extension itself.

## Identified Edge Cases & UX Problems

1. **Port Collisions (The `7822` Problem)**
   - **Problem:** The extension hardcodes `ws://localhost:7822`. If another service uses port `7822`, the MCP server will fail to start, or the extension won't connect.
   - **Solution:** Add an Options page to the Chrome extension allowing users to change the default port. The MCP server should accept a `--port` CLI argument or environment variable (`MCP_BROWSER_WS_PORT`) to match.

2. **Server Running but Extension Missing/Disconnected**
   - **Problem:** If an agent calls `browser_navigate` but the user hasn't installed/enabled the Chrome extension, the command will hang or throw an opaque WebSocket error.
   - **Solution:** The MCP server must track the active WebSocket connection state. If a tool is called while no extension is connected, it should immediately return a user-friendly error: `"Browser extension not connected. Please ensure the extension is installed, enabled, and pointing to port 7822."`

3. **Timeouts and Hanging Commands**
   - **Problem:** The extension has a 15s timeout for DOM actions and 30s for navigation. If the browser is suspended or a page hangs, the MCP server might wait indefinitely or crash.
   - **Solution:** The MCP server should wrap every tool execution in a strict timeout Promise (e.g., 35 seconds) that resolves to an error message rather than crashing the MCP process.

4. **Multi-Client / Security Issues**
   - **Problem:** If multiple MCP agents run simultaneously, they might both try to bind to port `7822`.
   - **Solution:** The Node server should gracefully handle `EADDRINUSE`. If the port is busy, it should exit with a clear error instructing the user to change the port configuration.

5. **Installation Friction**
   - **Problem:** "Developer Mode -> Load Unpacked" is tedious for standard users.
   - **Solution:** Provide a zipped release of the extension in the repo. Eventually, publish to the Chrome Web Store to make installation a 1-click process.

6. **Asynchronous `chrome.storage` & Connection Races**
   - **Problem:** `chrome.storage.local.get` is async. If the background script establishes WebSocket connection immediately on boot, a race condition occurs.
   - **Solution:** Refactor `background.js` to wait for storage before calling `connect()`, and add a `chrome.storage.onChanged` listener to instantly hot-swap the connection when the port changes.

7. **Content Script Re-injection on Navigation**
   - **Problem:** After navigating, the DOM is destroyed. `chrome.scripting.executeScript` might fail on restricted pages (e.g. `chrome://`) leaving commands timing out.
   - **Solution:** The MCP Server/Extension must cleanly report restricted URLs back to the agent: `"Cannot interact with this page (restricted Chrome page)"` instead of timing out.

8. **Request/Response Correlation**
   - **Problem:** With a single WebSocket, rapid concurrent requests (e.g. scroll then screenshot) can return responses out of order.
   - **Solution:** `mcp-server/index.js` must implement a strict message ID system (e.g. UUIDs) linking outgoing requests to pending Promise resolvers.

9. **The "Focus Stealing" Problem**
   - **Problem:** The AI interacting with a background tab might force-focus it, interrupting the user's manual browsing.
   - **Solution:** Actions must execute in the background tab without making it active. Only `screenshot` strictly requires the tab to be focused.

## Files to modify

1. `mcp-server/index.js` (New file)
   - Implement the MCP server, add connection state tracking, add `EADDRINUSE` handling, use UUIDs/message IDs for request correlation via a Promise Map, and add strict timeouts for tool executions.
2. `chrome-extension/background.js`
   - Update `WS_URL` to safely read from `chrome.storage` before connecting, add a `chrome.storage.onChanged` listener for hot-swapping, properly handle restricted URL injection errors, and avoid focus-stealing on non-screenshot actions.
3. `chrome-extension/options.html` & `chrome-extension/options.js` (New files)
   - Create a simple UI to configure the WebSocket port. It must save to storage, triggering the background script listener.
4. `chrome-extension/manifest.json`
   - Add `"options_page": "options.html"` permission/entry.
5. `README.md`
   - Update instructions for generic MCP usage, options page, and troubleshooting.

## Steps

- [ ] Step 1: Create the `mcp-server/index.js` incorporating the Stdio MCP SDK.
- [ ] Step 2: Implement WebSocket server in `mcp-server/index.js` with port conflict handling, client tracking, and a strict message ID (UUID) Promise Map to handle out-of-order responses concurrently.
- [ ] Step 3: Implement MCP tool handlers (`navigate`, `click`, etc.) with graceful error returns when the extension is missing or when interacting with restricted Chrome URLs.
- [ ] Step 4: Add `options.html` and `options.js` to the Chrome extension to make the WebSocket port configurable (updating storage broadcasts the change).
- [ ] Step 5: Update `background.js` to await `chrome.storage` before `connect()`, add `chrome.storage.onChanged` listener for hot-swapping connections, and ensure actions don't steal tab focus.
- [ ] Step 6: Update `README.md` with instructions on how to use this with Claude Desktop and Cursor.

## Verification

- Run the MCP server manually: `node mcp-server/index.js`. It should not crash.
- Change the port in the extension options, restart the MCP server with the new port, and verify connection.
- Disconnect the extension, call an MCP tool, and verify it returns a clean error instead of hanging.
