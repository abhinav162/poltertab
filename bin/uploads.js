"use strict";

// poltertab uploads — manage the upload allowlist and view the activity log.
// Works with no server or extension running; edits config.json directly.

const os = require("os");
const { getAllowlist, addAllowlistEntry, removeAllowlistEntry } = require("../mcp-server/uploads-config.js");
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

  console.error(`\n  Unknown subcommand: ${sub}`);
  console.error("  Usage: poltertab uploads list|allow <dir>|revoke <dir>|log [-n N]\n");
  process.exit(1);
}

module.exports = { run };
