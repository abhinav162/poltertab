#!/usr/bin/env node
// Single entry point for both halves of the package.
//
//   poltertab          start the MCP server on stdio — this is what goes in the
//                      MCP client config, which is why it is the bare default
//   poltertab setup    interactive installer
//
// The server must own stdout: it is the JSON-RPC channel. Nothing in this file
// prints on the default path.

const arg = process.argv[2];

if (arg === "setup") {
  require("./setup.js").run(process.argv.slice(3)).catch((err) => {
    console.error(`\n  setup failed: ${err.message}\n`);
    process.exit(1);
  });
} else if (arg === "--version" || arg === "-v") {
  console.log(require("../package.json").version);
} else if (arg === "--help" || arg === "-h") {
  console.log(`
  poltertab — browser control for AI agents

    poltertab           start the MCP server (stdio)
    poltertab setup     install skill, CLAUDE.md section, and MCP registration
    poltertab --version

  setup flags: --global | --project  (skips the prompt)
`);
} else {
  require("../mcp-server/index.js");
}
