# Wait for Extension/Primary Connection Plan

## Context

When a new agent session starts, it spins up the `mcp-server`. The Chrome Extension (or the Secondary Node client connecting to the Primary Node) takes a brief moment (e.g., 1-3 seconds) to establish the WebSocket connection.
If the agent sends an MCP command immediately upon server startup, `extensionSocket` is not yet open, causing an immediate "Browser extension not connected" (or "Secondary node not connected") error. A subsequent retry succeeds because the socket connects in the background.

## Approach

Instead of immediately throwing an error if the WebSocket isn't open, we will introduce a short polling delay (up to 5 seconds) inside `sendCommand` to wait for the connection to establish. This will smoothly handle the race condition without requiring the user to explicitly tell the agent to "try again".

## Files to modify

- `mcp-server/index.js`

## Steps

- [ ] Implement an asynchronous `waitForConnection(timeoutMs)` helper function in `mcp-server/index.js` that checks if `extensionSocket.readyState === WebSocket.OPEN` every 100ms.
- [ ] In `sendCommand(action, params)`, await `waitForConnection(5000)` before checking `extensionSocket`.
- [ ] If `waitForConnection` returns false, throw the appropriate error (either for Primary or Secondary).
- [ ] For Secondary nodes, this ensures we wait for the connection to the Primary node. For the Primary node, this ensures we wait for the Chrome Extension to reconnect.

## Verification

- Start a fresh server/agent session and immediately fire an MCP command.
- It should pause for a moment, wait for the extension to connect, and then successfully execute without returning an error.
