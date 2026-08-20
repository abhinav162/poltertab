# PolterTab — Browser Control for Any AI

**PolterTab lets any AI assistant drive and scrape your *existing* Chrome profile — no headless browser, no separate automation setup, no re-logging into anything.**

A Chrome extension + Model Context Protocol (MCP) server. The AI acts inside the browser you already use: your real profile, your cookies, your logged-in sessions. Install the extension, point your MCP client at the server, done — it works with Claude Desktop, Cursor, or any MCP-compatible agent.

## Why PolterTab

- **Your real profile** — runs in the Chrome you're already signed into. No fresh headless browser that's logged out of everything.
- **No complex setup** — load the unpacked extension, add one MCP entry. That's it.
- **Any AI tool** — any MCP-compatible client can connect.

## How It Works

```
Any MCP Agent (Claude Desktop, Cursor, custom agents)
       │  Stdio (MCP Protocol)
       ▼
Node.js MCP Server (mcp-server/index.js)
       │  WebSocket (port 7822 by default)
       ▼
PolterTab Chrome Extension
       │  Chrome APIs + DOM
       ▼
  Your existing Chrome profile
```

## Setup

### 1. Install the Chrome Extension

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `chrome-extension/` directory from this repo

### 2. Configure Your Agent (Claude Desktop / Cursor)

You need to have `node` installed on your machine.

**For Claude Desktop:**
Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chrome-browser-control": {
      "command": "node",
      "args": ["/absolute/path/to/poltertab/mcp-server/index.js"]
    }
  }
}
```

Any other MCP-compatible client works the same way — point it at `mcp-server/index.js` over stdio.

> **Legacy:** This extension began as a ZeroClaw plugin and still speaks ZeroClaw's built-in REST bridge (`backend = "bridge"` in `~/.zeroclaw/config.toml`). That path is optional and not required for the MCP setup above.

## Supported MCP Tools

The server exposes the following tools to the LLM (all prefixed with `browser_`):

| Action | Parameters | Description |
| -------- | ----------- | ------------- |
| `browser_navigate` | `url` (required), `tabId`, `session` | Navigate to a URL |
| `browser_click` | `selector` (required), `tabId`, `session` | Click an element (CSS/XPath/text) |
| `browser_fill` | `selector`, `value` (required), `submit`, `tabId`, `session` | Fill an input field |
| `browser_scrape` | `selector`, `attribute`, `multiple`, `tabId`, `session` | Scrape page or specific elements |
| `browser_screenshot` | `tabId`, `session` | Capture visible tab as base64 PNG (focuses tab) |
| `browser_scroll` | `direction` (required), `amount`, `selector`, `tabId`, `session` | Scroll the page |
| `browser_hover` | `selector` (required), `tabId`, `session` | Hover over an element |
| `browser_get_text` | `selector` (required), `tabId`, `session` | Get text content of an element |
| `browser_get_title` | `tabId`, `session` | Get page title and URL |

### Selector Resolution

Selectors are resolved in order:

1. **CSS selector** — `#id`, `.class`, `div > span`
2. **XPath** — `//div[@class="foo"]`
3. **Text match** — exact text content of an element

## CLI Wrapper (Legacy)

`zc-browser.sh` lets you send commands directly to the legacy ZeroClaw REST bridge for testing (only relevant if you use the optional ZeroClaw bridge path above):

```bash
./zc-browser.sh navigate url=https://example.com
./zc-browser.sh scrape selector="h1"
./zc-browser.sh get_title
./zc-browser.sh health
```

## Troubleshooting & Options

**Changing the WebSocket Port:**
If port `7822` is in use, the MCP Server will exit with an `EADDRINUSE` error.

1. Click the Extension icon in Chrome -> **Options**.
2. Change the WebSocket Port to a free port (e.g. `7824`) and click **Save**.
3. Update your MCP Server configuration to pass the new port.
   - Using env var: `MCP_BROWSER_WS_PORT=7824 node index.js`
   - Using CLI arg: `node index.js --port 7824`
   - In Claude Desktop config:

   ```json
   "args": ["/absolute/path/to/poltertab/mcp-server/index.js", "--port", "7824"]
   ```

**Extension not connecting:**

- Ensure the MCP Server is running and pointing to the correct port.
- Reload the extension from `chrome://extensions/`

**Commands timing out / Restricted Pages:**

- Ensure you have an active tab open in Chrome.
- Chrome extensions **cannot** interact with `chrome://` URLs, the Chrome Web Store, or certain restricted pages. The MCP server will cleanly report "Cannot interact with this page" back to the agent in these cases.

## Project Structure

```
poltertab/
├── mcp-server/
│   ├── index.js               # Node.js MCP Server (Stdio)
│   └── package.json
├── chrome-extension/
│   ├── manifest.json          # MV3 manifest
│   ├── background.js          # WebSocket client + command router
│   ├── content_script.js      # DOM extractor + action executor
│   ├── options.html/js        # Port configuration UI
│   └── icons/
├── zc-browser.sh              # CLI wrapper (legacy)
└── README.md
```
