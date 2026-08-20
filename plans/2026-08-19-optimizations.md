# Extension UI and Architecture Optimizations Plan

## Context

The user requested a UI to show the connected sessions with agents before proceeding with the architecture optimizations. We brainstormed and decided on a **Toolbar Popup** for the Chrome Extension. This will give users immediate visibility into which AI agents (Secondary nodes/sessions) are connected and actively using the browser. Once this UI is complete, we will proceed with the stability and optimization enhancements for the Node.js MCP server.

This plan is broken down into two phases:

### Phase 1: Extension UI (Toolbar Popup)

- Provide a clear, real-time UI in the extension popup when the icon is clicked.
- Display the status of the connection to the MCP Primary Node.
- List all active Agent Sessions (from Secondary nodes) that are currently sending commands or listening.

### Phase 2: Architecture Optimizations (Node.js)

1. **Unbounded Memory Leak Prevention:** Preventing Node.js OOM crashes when large payloads accumulate.
2. **Primary Election Race Conditions:** Preventing multiple Secondary nodes from simultaneously attempting to become Primary.
3. **Payload Compression over WebSocket:** Reducing IPC overhead by compressing large JSON payloads.
4. **File-based Offloading for Massive Payloads:** Protecting the LLM context window by writing massive payloads to disk.
5. **Heartbeats (Ping/Pong):** Ensuring dead secondary connections are correctly detected and dropped.

---

## Approach & Steps

### Phase 1: Extension UI (Toolbar Popup)

- **Concept:** Create a `popup.html` and `popup.js` that query the background script for active sessions. Handle Manifest V3 service worker lifecycle correctly.
- **Implementation:**
  1. Add `"action": { "default_popup": "popup.html" }` to `manifest.json`.
  2. Create `chrome-extension/popup.html` with a clean UI displaying connection status, a list container, and a manual "Refresh" button.
  3. Create `chrome-extension/popup.js` to send a message (e.g., `{ type: "get_status" }`) to `background.js`.
  4. **Tracking Active Sessions & Synchronization:**
     - The Primary server tracks `secondaryClients` and broadcasts an `active_sessions` update to the Chrome Extension on changes.
     - Upon connection/reconnection, the extension must explicitly send a request (e.g., `{ type: "request_full_state" }`) to the Primary server to get the current list of active sessions (this prevents empty UIs if the extension missed a broadcast).
     - The `background.js` stores this state and serves it to the popup.
     - Add a "Refresh" button in the popup to manually clear stale "ghost" sessions if a Secondary crashes abruptly before the Primary's heartbeat detects it.
  5. **Manifest V3 Keep-Alive & Reconnection:**
     - Since Manifest V3 service workers sleep after 30 seconds of inactivity, implement a keep-alive mechanism in `background.js`. Send a `{ type: "ping" }` message over the WebSocket every 20 seconds to keep the connection alive.
     - If the Primary dies and the WebSocket drops, `background.js` must implement a retry loop with exponential backoff to automatically reconnect to the newly elected Primary.
     - Ensure `background.js` attempts reconnection immediately on `chrome.runtime.onStartup` or when the popup is opened if the connection is dead, overcoming device sleep/hibernation kills.

### Phase 2: Architecture Optimizations (Node.js)

#### 1. Unbounded Memory Leak Prevention

- **Concept:** Introduce a rolling buffer for intercepted network requests, handle tab closures, cap payload size, and implement a time-to-live (TTL) eviction policy.
- **Implementation:**
  - In `mcp-server/index.js`, restrict the `networkState` array for a given `tabId` to a higher maximum size (e.g., 500 requests) to accommodate modern SPAs.
  - To prevent huge payload OOMs, truncate individual response bodies larger than 1MB, and optionally drop payloads for non-text content-types (like images/video).
  - Track a `lastUpdated` timestamp per `tabId`.
  - Implement a `setInterval` garbage collector (running every ~1-2 minutes) that deletes entries from `networkState` if they haven't been accessed or updated in the last 5 minutes.
  - Listen for a new message type from the extension indicating tab closure (`{ type: "tab_closed", tabId }`), triggered by `chrome.tabs.onRemoved` in `background.js`, to immediately clear the network buffer for that tab.

#### 2. Primary Election Race Conditions

- **Concept:** Use Exponential Backoff with Jitter for Secondary nodes attempting to claim Primary status, and retain `EADDRINUSE` fallback.
- **Implementation:**
  - In `mcp-server/index.js` -> `connectToPrimary()` -> `extensionSocket.on("close")`, introduce a randomized delay for reconnection/promotion attempts.
  - Delay calculation: `const jitter = Math.floor(Math.random() * 2000); const delay = 500 + jitter;`.
  - Ensure that when calling `httpServer.listen(WS_PORT)` again, the existing `EADDRINUSE` error handler is still in place. If another node wins the race and binds first, this node will catch the error and gracefully fall back to Secondary mode.

#### 3. Payload Compression over WebSocket

- **Concept:** Enable `perMessageDeflate` to compress WebSocket traffic, being mindful of CPU load.
- **Implementation:**
  - In `mcp-server/index.js`, update the WebSocket server to include `perMessageDeflate: { zlibDeflateOptions: { level: 1 } }` (using a lower compression level to prevent blocking the single-threaded Node event loop for massive payloads).
  - Ensure the Secondary node WebSocket clients also request compression. Note: Avoid blocking the event loop for too long, as it could delay the Heartbeat (Ping/Pong) mechanism and cause false-positive disconnects.

#### 4. File-based Offloading for Massive Payloads

- **Concept:** Add an optional `output_file` parameter to `browser_get_network_state`, secured against Path Traversal and Collisions.
- **Implementation:**
  - Update `inputSchema` for `browser_get_network_state` to include an optional `output_file` (string) parameter.
  - In the tool handler for `get_network_state`, if `args.output_file` is provided:
    - **Security & Collisions:** Sanitize the input using `path.basename(args.output_file)` to strictly prevent Path Traversal vulnerabilities (e.g., `../../etc/passwd`). Append a timestamp or session ID to the filename (e.g., `test_1787136766012.json`) to prevent collisions if two agents write simultaneously.
    - Save the file within a safe, confined directory (e.g., a specific workspace `downloads` folder or the local temp directory). Create this directory recursively on startup using `fs.mkdirSync(safeDir, { recursive: true })`.
    - Write the stringified JSON data directly to the safe file path using `fs.writeFileSync`.
    - Return a lightweight text response: `"Data successfully written to [safe_path]. Captured X requests."`

#### 5. Heartbeats (Ping/Pong)

- **Concept:** Use WebSocket ping/pong frames to detect dead connections.
- **Implementation:**
  - In `setupPrimaryWss(wss)`, add a property `ws.isAlive = true` upon connection.
  - Listen for the `pong` event on each socket to reset `ws.isAlive = true`.
  - Start a `setInterval` (e.g., every 60 seconds, increased from 30 to account for event loop blocks from large JSON parsing/deflate) on the Primary server that iterates over all clients in `wss.clients`.
  - If a client's `isAlive` is `false`, call `ws.terminate()`. Otherwise, set `ws.isAlive = false` and call `ws.ping()`.
  - Ensure `secondaryClients` map is cleaned up when `ws.terminate()` triggers the `close` event.

## Files to Modify

- `chrome-extension/manifest.json`: Add popup action.
- `chrome-extension/popup.html` (New): UI layout.
- `chrome-extension/popup.js` (New): UI logic.
- `chrome-extension/background.js`: Manage session state from MCP server.
- `mcp-server/index.js`: Broadcast session updates to extension, plus all optimization changes.

## Verification

- **Popup UI:** Click the extension icon. It should show a clean UI. Start an MCP agent and run a command. The popup should update to show the connected agent session.
- **Memory Leak:** Run the server, capture network data without consuming it, wait for the TTL, and verify the memory is freed. Send >50 requests and verify array length remains capped.
- **Race Condition:** Start 3 servers (1 Primary, 2 Secondaries). Kill the Primary. Verify only one Secondary successfully binds the port and becomes the new Primary.
- **Compression:** Observe CPU usage and transmission speed for large GraphQL payloads; optionally inspect WebSocket frames to verify deflate extension is active.
- **File Offload:** Call `browser_get_network_state` with `output_file: "test.json"`. Verify the file is created with the full JSON payload and the MCP response is a short string.
- **Heartbeats:** Start a Secondary, suspend or SIGKILL its process abruptly. Verify the Primary drops the connection and decrements the active secondary count after ~30 seconds.
