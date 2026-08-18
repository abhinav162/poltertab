# Plan: Multi-Session Multiplexing for ZeroClaw MCP Server

## Context

When multiple AI agents (or multiple Pi sessions) attempt to use the `chrome-browser-control` MCP server simultaneously, the first session binds to WebSocket port `7822`. Any subsequent session fails with an `EADDRINUSE` error because the port is already taken. This completely breaks the seamless experience of running multiple concurrent agent sessions.

Using external multiplexers like `rmcp-mux` is an option, but it introduces friction and requires the user to set up and manage background daemons manually. We want this to work out-of-the-box with zero configuration.

## Approach: The "Hub and Spoke" Mesh

We will build multiplexing directly into our Node.js MCP server using a primary/secondary fallback mechanism over the existing WebSocket port.

1. **The Primary Node (Hub)**
   The first Pi session to launch the MCP server attempts to bind to port `7822`. It succeeds and becomes the **Primary**. It listens for the Chrome Extension to connect. It also listens for other "Secondary" MCP servers to connect.

2. **The Secondary Nodes (Spokes)**
   When the second, third, or Nth Pi session launches, it attempts to bind to `7822`. It receives an `EADDRINUSE` error.
   Instead of crashing and exiting, it suppresses the error and instantly switches into **Secondary Mode**.
   It spins up a WebSocket *client* and connects to `ws://localhost:7822`. It sends a handshake payload: `{ type: "secondary_mcp" }`.

3. **Message Routing**
   When an agent commands a Secondary node, the Secondary assigns a UUID to the command and forwards it to the Primary via WebSocket as `{ type: "proxy_command", action, params, id }`.
   The Primary receives this, logs which Secondary socket it came from, and forwards it to the Chrome Extension.
   When the Chrome Extension replies, the Primary checks the pending UUID. Because it belongs to a Secondary, it forwards the response back down the WebSocket to that specific Secondary.
   The Secondary receives the response and returns it to its agent over Stdio.

This approach requires zero changes to the Chrome Extension and zero external dependencies, making concurrent agent sessions completely seamless.

## Identified Edge Cases & Solutions

1. **Primary Death (Self-Healing) & Dangling Promises**
   - **Problem:** If the Primary MCP server (the first Pi session) terminates, all Secondary nodes lose connection to the Chrome Extension, and any in-flight commands sent by Secondaries will hang forever.
   - **Solution:** When a Secondary's connection to the Primary drops, it must iterate through its own `pendingCommands` Map and reject them all (e.g., "Error: Primary node disconnected"). The agent can then retry safely. It then enters a reconnect loop, first attempting to start an HTTP server on port `7822`. If it succeeds, it promotes itself to the new Primary. If it fails, it reconnects as a Secondary. *Note: Transient state (like `networkState`) is lost on promotion, but this is acceptable as the agent can simply re-fetch.*

2. **Browser State Collisions**
   - **Problem:** Multiple agents sending commands without a `session` parameter will fight over the single active Chrome tab (e.g., Agent A tries to click while Agent B navigates).
   - **Solution:** Every Secondary node will generate a unique Node ID on startup. When a Secondary proxies a command to the Primary, if the `session` parameter is missing, the Secondary will automatically inject `session: "agent_node_<id>"` into the parameters. This forces the Chrome Extension to open and use a dedicated tab for each agent session by default, preventing state fights.

3. **Event & State Leaks**
   - **Problem:** The Chrome Extension sends asynchronous `network_data` events. Who owns this data?
   - **Solution:** The Primary node acts as the single source of truth. All `network_data` payloads are stored in the Primary's `networkState` Map. When a Secondary calls `browser_get_network_state`, the command is proxied to the Primary, which fetches the data for the specific `tabId` from its central Map and returns it directly to the Secondary.

4. **Graceful Teardown & Session Limits**
   - **Problem:** If a Primary crashes or exits, the port might get stuck in `TIME_WAIT`, or too many Secondaries could overwhelm it.
   - **Solution:** Add a hard limit of 5 Secondary connections for now. Also, implement `SIGINT` and `SIGTERM` handlers on the Primary to explicitly call `server.close()` and `wss.close()`. This instantly drops the connections to Secondaries, allowing them to detect the death and promote themselves without waiting for OS timeouts.

## Files to modify

- `mcp-server/index.js`

## Steps

- [ ] Step 1: Replace the direct `WebSocketServer` instantiation with an `http.createServer()` approach to properly catch `EADDRINUSE` asynchronously via `server.on('error')`.
- [ ] Step 2: Implement the **Secondary Mode** logic. When `EADDRINUSE` triggers, generate a unique `nodeId`, initialize a `new WebSocket("ws://localhost:" + WS_PORT)` client, and send a `{ type: "secondary_mcp", nodeId }` handshake.
- [ ] Step 3: Implement **Primary Death Promotion & Cleanup**. If the Secondary's WebSocket `on('close')` fires, immediately reject all its `pendingCommands`. Then attempt to bind the HTTP server again to become the new Primary.
- [ ] Step 4: In the Primary's `wss.on('connection')` handler, detect incoming `{ type: "secondary_mcp" }` messages and store those sockets in a `secondaryClients` Map, enforcing a maximum limit of 5 concurrent Secondary sessions.
- [ ] Step 5: Implement message forwarding in the Primary. When a message `{ type: "proxy_command", id, action, params }` arrives from a Secondary, save `pendingCommands.set(id, { isProxy: true, sourceWs: ws })`.
  - If the action is `get_network_state`, the Primary handles it directly using its central `networkState` Map, and returns the response immediately to the Secondary without hitting the Chrome Extension.
  - For all other actions, it forwards to the Chrome Extension.
- [ ] Step 6: Update the Primary's extension response handler. If `msg.id` matches a proxy command, send the result back to `sourceWs` instead of resolving a local Promise.
- [ ] Step 7: Update the `sendCommand` function. If the server is in Secondary mode, auto-inject `params.session = "agent_" + nodeId` if missing, and send the command over the WebSocket client connection to the Primary.
- [ ] Step 8: Add graceful shutdown (`SIGINT`/`SIGTERM` hooks) to cleanly drop sockets and exit.

## Verification

1. Run `node index.js` in Terminal A (acts as Primary).
2. Run `node index.js` in Terminal B (acts as Secondary). It should log that it connected as a secondary rather than crashing.
3. Test a command on Terminal B using our `test-client.js` script to ensure full end-to-end proxying works correctly.
