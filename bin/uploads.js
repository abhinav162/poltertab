"use strict";

// poltertab uploads — manage the upload allowlist and view the activity log.
// Works with no server or extension running; edits config.json directly.

const os = require("os");
const {
  getAllowlist,
  addAllowlistEntry,
  removeAllowlistEntry,
  addTrustedExtensionId,
} = require("../mcp-server/uploads-config.js");
const { getRecentLog } = require("../mcp-server/uploads-log.js");
const { validateAllowlistEntry, buildAlwaysBlocked } = require("../mcp-server/upload-paths.js");

async function run(argv) {
  const sub = argv[0];

  if (!sub || sub === "list") {
    const homeDir = os.homedir();
    const allowlist = getAllowlist();
    const alwaysBlocked = buildAlwaysBlocked(homeDir);

    console.log("\nUpload configuration (~/.poltertab/config.json)");
    console.log("─".repeat(50));

    if (allowlist.length === 0) {
      console.log("\n  Allowed folders: (none — uploads disabled)");
    } else {
      console.log("\n  Allowed folders:");
      for (const dir of allowlist) {
        console.log(`    + ${dir}`);
      }
    }

    console.log("\n  Always blocked (cannot be changed):");
    for (const dir of alwaysBlocked) {
      console.log(`    ✗ ${dir}`);
    }
    console.log(`    ✗ ~/.*  (home dotfiles)`);
    console.log();
    return;
  }

  if (sub === "allow") {
    const dir = argv[1];
    if (!dir) {
      console.error("Usage: poltertab uploads allow <dir>");
      process.exit(1);
    }
    const v = validateAllowlistEntry(dir);
    if (!v.ok) {
      console.error(`\n  Error: ${v.errorText}\n`);
      process.exit(1);
    }
    const added = addAllowlistEntry(dir);
    if (added) {
      console.log(`\n  Added: ${dir}\n`);
    } else {
      console.log(`\n  Already present: ${dir}\n`);
    }
    return;
  }

  if (sub === "revoke") {
    const dir = argv[1];
    if (!dir) {
      console.error("Usage: poltertab uploads revoke <dir>");
      process.exit(1);
    }
    const removed = removeAllowlistEntry(dir);
    if (removed) {
      console.log(`\n  Removed: ${dir}\n`);
    } else {
      console.log(`\n  Not found in allowlist: ${dir}\n`);
    }
    return;
  }

  if (sub === "log") {
    let n = 20;
    const nIdx = argv.indexOf("-n");
    if (nIdx !== -1 && argv[nIdx + 1]) {
      n = parseInt(argv[nIdx + 1], 10) || 20;
    }
    const entries = getRecentLog(n);
    if (entries.length === 0) {
      console.log("\n  No upload activity recorded.\n");
      return;
    }
    console.log(`\nUpload activity log (last ${entries.length} entries)`);
    console.log("─".repeat(50));
    for (const e of entries) {
      const paths = Array.isArray(e.paths) ? e.paths.join(", ") : String(e.paths);
      console.log(`  ${e.ts}  [${e.outcome}]  method=${e.method}  ${paths}`);
    }
    console.log();
    return;
  }

  if (sub === "pair") {
    await runPair(argv.slice(1));
    return;
  }

  console.error(`\n  Unknown subcommand: ${sub}`);
  console.error("  Usage: poltertab uploads list|allow <dir>|revoke <dir>|log [-n N]|pair [--id <id>]\n");
  process.exit(1);
}

// Reads the port poltertab is listening on from the default config or falls back.
function resolveWsPort() {
  try {
    const { resolvePort } = require("../mcp-server/config.js");
    return resolvePort();
  } catch (_) {
    return 7822;
  }
}

// poltertab uploads pair — link a Chrome extension by its ID so it may send
// upload config/log WS messages. Interactive by default (requires TTY);
// --id <id> skips the prompt for scripted human use.
async function runPair(argv) {
  const idFlagIdx = argv.indexOf("--id");
  const flagId = idFlagIdx !== -1 ? argv[idFlagIdx + 1] : null;

  if (!flagId && !process.stdin.isTTY) {
    console.error("\nError: poltertab uploads pair requires an interactive terminal.\n" +
      "Use --id <extension-id> to pair non-interactively.\n");
    process.exit(1);
  }

  let extensionId = flagId;

  if (!extensionId) {
    // Ask the running server which extension origins are connected.
    const port = resolveWsPort();
    let origins = [];
    try {
      origins = await fetchConnectedOrigins(port);
    } catch (err) {
      console.error(`\nCould not connect to poltertab server on port ${port}: ${err.message}`);
      console.error("Make sure poltertab is running, then try again.\n");
      process.exit(1);
    }

    const extIds = origins
      .filter((o) => o.startsWith("chrome-extension://"))
      .map((o) => o.slice("chrome-extension://".length).replace(/\/$/, ""));

    if (extIds.length === 0) {
      console.error("\nNo extensions are currently connected to poltertab.");
      console.error("Make sure the poltertab Chrome extension is installed and active, then try again.\n");
      process.exit(1);
    }

    console.log("\nConnected extension IDs:");
    extIds.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
    console.log("\nOpen chrome://extensions to find which ID matches your poltertab extension.");

    if (extIds.length === 1) {
      extensionId = extIds[0];
      console.log(`\nAutomatically selecting the only connected extension: ${extensionId}`);
    } else {
      const readline = require("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const choice = await new Promise((resolve) => {
        rl.question(`\nEnter number (1-${extIds.length}) to pair, or paste the ID directly: `, (ans) => {
          rl.close();
          resolve(ans.trim());
        });
      });
      const num = parseInt(choice, 10);
      if (!isNaN(num) && num >= 1 && num <= extIds.length) {
        extensionId = extIds[num - 1];
      } else if (/^[a-z]{32}$/.test(choice)) {
        extensionId = choice;
      } else {
        console.error("\nInvalid selection.\n");
        process.exit(1);
      }
    }
  }

  if (!/^[a-z]{32}$/.test(extensionId)) {
    console.error(`\nInvalid extension ID: ${extensionId}`);
    console.error("Chrome extension IDs are 32 lowercase letters.\n");
    process.exit(1);
  }

  const added = addTrustedExtensionId(extensionId);
  if (added) {
    console.log(`\n  Paired: ${extensionId}`);
    console.log("  Upload config access is now enabled for this extension.\n");
  } else {
    console.log(`\n  Already paired: ${extensionId}\n`);
  }
}

// Ask the WS server for connected extension origins via uploads_get_origins.
function fetchConnectedOrigins(port) {
  return new Promise((resolve, reject) => {
    let WebSocket;
    try {
      WebSocket = require("ws");
    } catch (_) {
      reject(new Error("ws module not available"));
      return;
    }
    const ws = new WebSocket(`ws://localhost:${port}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timeout waiting for server response"));
    }, 5000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "uploads_get_origins" }));
    });
    ws.on("message", (raw) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "uploads_origins") {
          ws.close();
          resolve(Array.isArray(msg.origins) ? msg.origins : []);
        }
      } catch (_) {
        ws.close();
        reject(new Error("Invalid response from server"));
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = { run };
