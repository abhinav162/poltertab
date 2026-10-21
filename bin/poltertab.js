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
    if (err.code === "CANCELLED") {
      // Ctrl-C or Ctrl-D: 130 is the shell's code for "interrupted by SIGINT";
      // EOF uses it too so a script sees one "user cancelled" code.
      console.log("\n  Cancelled.\n");
      process.exit(130);
    }
    console.error(`\n  setup failed: ${err.message}\n`);
    process.exit(1);
  });
} else if (arg === "doctor") {
  require("./doctor.js")
    .run(process.argv.slice(3))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`\n  doctor failed: ${err.message}\n`);
      process.exit(1);
    });
} else if (arg === "--version" || arg === "-v") {
  console.log(require("../package.json").version);
} else if (arg === "uploads") {
  require("./uploads.js").run(process.argv.slice(3)).catch((err) => {
    console.error(`\n  uploads failed: ${err.message}\n`);
    process.exit(1);
  });
} else if (arg === "--help" || arg === "-h") {
  console.log(`
  poltertab — browser control for AI agents

    poltertab           start the MCP server (stdio)
    poltertab setup     install skill, CLAUDE.md section, and MCP registration
    poltertab doctor    versions, update check, and extension/server skew
    poltertab uploads   manage upload-allowed folders and view the activity log
    poltertab --version

  setup flags:   --global | --project  (skips the prompt)
  doctor flags:  --force (ignore the cached update check), --port <n>
  uploads:
    poltertab uploads list             show allowed folders, always-blocked, and status
    poltertab uploads allow <dir>      add a directory to the allowlist
    poltertab uploads revoke <dir>     remove a directory from the allowlist
    poltertab uploads log [-n N]       tail the upload activity log (default: 20 lines)

  POLTERTAB_HOME             where memory and downloads live
  POLTERTAB_NO_UPDATE_CHECK  set to disable the npm version check
`);
} else {
  require("../mcp-server/index.js");
}
