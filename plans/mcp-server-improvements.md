# Plan: MCP Server Improvements (Payloads, Sandbox, and Process Lifecycle)

## Context

During an agent execution on X.com (Twitter), the agent encountered several issues that hindered its ability to seamlessly extract data using our newly built architecture. The issues identified include massive payload truncation causing sandbox confinement errors, `mcpScript` sandbox limitations, and zombie processes holding the WebSocket port.

## Identified Issues & Solutions

### 1. Massive Network Payloads & Sandbox Confinement

- **Problem:** When scraping SPAs like X.com, `browser_get_network_state` returns huge JSON arrays (over 2MB). Pi automatically truncates this text and saves it to a system temp folder (e.g., `/var/folders/...`). Because this folder is outside the project root, subsequent `ctx_execute_file` calls are blocked by Pi's security sandbox, breaking the Think-in-Code workflow.
- **Solution:** Add an `outputPath` parameter to `browser_get_network_state`. When provided, the MCP server will write the massive JSON payload directly to this file inside the project directory (e.g., `.zc-network-state.json`) and return only the file path. The agent can then safely process this local file using `ctx_execute_file`.

### 2. `mcpScript` Environment Limitations

- **Problem:** The agent attempted to use `setTimeout` inside an `mcpScript` block to wait for network requests. `mcpScript` runs in a restricted synchronous environment without web timers, causing a `ReferenceError`.
- **Solution:** Update the global AI skill `browser-navigation-strategy` to explicitly warn agents: "Do not use `setTimeout` or sleep loops in `mcpScript`. The `browser_smart_scroll` tool already handles waiting automatically."

### 3. Zombie Process (`EADDRINUSE` on Port 7822)

- **Problem:** If a previous agent session crashes or drops the connection, the MCP Node process can stay alive in the background. When a new agent tries to start, it fails with `EADDRINUSE`.
- **Solution:** Add a `close` listener to the stdio transport or `process.stdin`. When the parent agent process disconnects or dies, the MCP server should gracefully close the WebSocket and `process.exit(0)`.

## Files to modify

1. `mcp-server/index.js`
   - Add `outputPath` to the `inputSchema` of `browser_get_network_state`.
   - Implement file writing logic (using `fs.writeFileSync`) for `get_network_state`.
   - Add disconnect listeners (`process.on('SIGINT')`, `process.stdin.on('close')`) to ensure the Node process terminates when the agent detaches.
2. `~/.pi/agent/pi-hermes-memory/skills/browser-navigation-strategy/SKILL.md` (via `skill_manage`)
   - Patch the "Pitfalls" section to include warnings against `mcpScript` timeouts and massive payload handling.

## Steps

- [ ] Step 1: Update `mcp-server/index.js` to handle `outputPath` in `browser_get_network_state`.
- [ ] Step 2: Add process lifecycle hooks to `mcp-server/index.js` so it automatically dies when stdio closes.
- [ ] Step 3: Update the `browser-navigation-strategy` skill to inform agents about `outputPath` and `mcpScript` limitations.

## Verification

- Test `browser_get_network_state` with `outputPath` to verify it writes to disk and returns a path instead of a massive payload.
- Launch the MCP server via stdio and then kill the parent process; verify the server shuts down and does not hold port 7822.
