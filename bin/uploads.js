"use strict";

// poltertab uploads — manage the upload allowlist and view the activity log.
// Works with no server or extension running; edits config.json directly.

const os = require("os");
const {
  getAllowlist,
  addAllowlistEntry,
  removeAllowlistEntry,
  addTrustedExtensionId,
  getTrustedExtensionIds,
  removeTrustedExtensionId,
} = require("../mcp-server/uploads-config.js");
const { getRecentLog } = require("../mcp-server/uploads-log.js");
const { validateAllowlistEntry, buildAlwaysBlocked } = require("../mcp-server/upload-paths.js");
const {
  resolveWsPort,
  tryConnectToServer,
  probeIsPoltertab,
  pairViaRunningServer,
  pairViaTempListener,
} = require("./pair-flow.js");

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

  if (sub === "unpair") {
    await runUnpair(argv.slice(1));
    return;
  }

  console.error(`\n  Unknown subcommand: ${sub}`);
  console.error("  Usage: poltertab uploads list|allow <dir>|revoke <dir>|log [-n N]|pair [--id <id>]|unpair [--id <id>]\n");
  process.exit(1);
}

// (pair primitives live in pair-flow.js and are imported above)

// ── poltertab uploads pair ─────────────────────────────────────────────────

async function runPair(argv) {
  // --id is kept for backward compatibility: pair by bare extension ID directly.
  const idFlagIdx = argv.indexOf("--id");
  const flagId = idFlagIdx !== -1 ? argv[idFlagIdx + 1] : null;

  if (flagId) {
    if (!/^[a-p]{32}$/.test(flagId)) {
      console.error(`\nInvalid extension ID: ${flagId}`);
      console.error("Chrome extension IDs are 32 lowercase letters (a-p).\n");
      process.exit(1);
    }
    const added = addTrustedExtensionId(flagId);
    if (added) {
      console.log(`\n  Paired: ${flagId}`);
      console.log("  Upload config access is now enabled for this extension.");
      console.log(`  (undo: poltertab uploads unpair ${flagId})\n`);
    } else {
      console.log(`\n  Already paired: ${flagId}\n`);
    }
    return;
  }

  if (!process.stdin.isTTY) {
    console.error("\nError: poltertab uploads pair requires an interactive terminal.\n" +
      "Use --id <extension-id> to pair non-interactively.\n");
    process.exit(1);
  }

  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const port = resolveWsPort();

  let serverWs = null;
  try {
    serverWs = await tryConnectToServer(port);
    // Verify the server is actually poltertab, not an unrelated WS server.
    if (!(await probeIsPoltertab(port))) {
      serverWs.terminate();
      serverWs = null;
      rl.close();
      console.error(
        `\n  Port ${port} is in use by something that isn't poltertab.` +
        " Close it or set a different port in ~/.poltertab/config.json, then retry.\n",
      );
      process.exit(1);
    }
  } catch (err) {
    if (err.code === "ETIMEDOUT") {
      rl.close();
      console.error(
        `\n  Port ${port} is in use by something that isn't poltertab.` +
        " Close it or set a different port in ~/.poltertab/config.json, then retry.\n",
      );
      process.exit(1);
    }
    if (err.code !== "ECONNREFUSED" && err.code !== "ENOENT") {
      rl.close();
      console.error(`\nCould not connect to port ${port}: ${err.message}\n`);
      process.exit(1);
    }
    // Nothing listening — start temp listener.
  }

  let result;
  if (serverWs) {
    result = await pairViaRunningServer(serverWs, rl);
  } else {
    console.log(
      `\n  No poltertab server found. Starting a temporary pairing listener on port ${port}.`,
    );
    console.log("  Open the extension popup — it will connect automatically and show a 4-letter code.\n");
    process.stdout.write("  waiting for the extension to connect…\n");

    try {
      result = await pairViaTempListener(port, rl, {
        onStatus: (msg) => process.stdout.write(`  ${msg}\n`),
      });
    } catch (err) {
      rl.close();
      if (err.code === "EADDRINUSE") {
        console.error(
          `\n  Port ${port} is in use by something that isn't poltertab.` +
          " Close it or set a different port in ~/.poltertab/config.json, then retry.\n",
        );
      } else {
        console.error(`\n  Failed to start pairing listener: ${err.message}\n`);
      }
      process.exit(1);
    }
  }

  rl.close();

  if (result.ok) {
    const shortId = result.extensionId.slice(0, 8);
    console.log(
      `\n  ✓ paired               extension ${shortId}… · uploads panel is live in the extension`,
    );
    console.log(`  (undo: poltertab uploads unpair ${result.extensionId})\n`);
  } else if (result.reason === "skipped") {
    console.log("\n  – pairing skipped      run poltertab uploads pair once the extension is loaded\n");
  } else if (result.reason === "locked") {
    console.error("\n  Too many wrong codes. Pairing is locked for 15 minutes.\n");
    process.exit(1);
  }
}

// ── poltertab uploads unpair ───────────────────────────────────────────────

async function runUnpair(argv) {
  // Accept positional id: `poltertab uploads unpair <id>` (the form success hints print).
  // Also accept --id <id> for backward compatibility.
  const idFlagIdx = argv.indexOf("--id");
  const flagId = idFlagIdx !== -1 ? argv[idFlagIdx + 1] : null;
  const positionalId = !flagId && argv.length > 0 && !argv[0].startsWith("-") ? argv[0] : null;
  const targetId = flagId || positionalId;

  if (targetId) {
    const removed = removeTrustedExtensionId(targetId);
    if (removed) {
      console.log(`\n  Unpaired: ${targetId}\n`);
    } else {
      console.log(`\n  Not found in paired extensions: ${targetId}\n`);
    }
    return;
  }

  // No-id form: list all paired ids, require TTY + y/n confirmation before removing.
  const ids = getTrustedExtensionIds();
  if (ids.length === 0) {
    console.log("\n  No extensions are currently paired.\n");
    return;
  }

  if (!process.stdin.isTTY) {
    console.error(
      "\n  'poltertab uploads unpair' with no id requires an interactive terminal.\n" +
      "  Pass the extension id to remove a specific one: poltertab uploads unpair <id>\n",
    );
    process.exit(1);
  }

  console.log("\n  Currently paired extensions:");
  for (const id of ids) console.log(`    ${id}`);
  console.log();

  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => {
    rl.question("  Remove ALL paired extensions? [y/N] ", (ans) => {
      rl.close();
      if ((ans || "").trim().toLowerCase() === "y") {
        for (const id of ids) removeTrustedExtensionId(id);
        console.log(`\n  Unpaired ${ids.length} extension${ids.length === 1 ? "" : "s"}.\n`);
      } else {
        console.log("\n  Cancelled.\n");
      }
      resolve();
    });
  });
}

module.exports = { run };
