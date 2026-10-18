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

// Reads the port poltertab is listening on from the configured value in
// config.json (ws_port), or falls back to the default via resolvePort().
function resolveWsPort() {
  try {
    const { resolvePort } = require("../mcp-server/config.js");
    return resolvePort();
  } catch (_) {
    return 7822;
  }
}

// Try to open a WebSocket connection to the server. Resolves with the open
// socket on success; rejects with the error (err.code === "ECONNREFUSED"
// means nothing is listening there).
function tryConnectToServer(port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let WebSocket;
    try { WebSocket = require("ws"); } catch (_) {
      reject(new Error("ws module not available")); return;
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    ws.on("open", () => { clearTimeout(timer); resolve(ws); });
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

// Prompt the user for a 4-letter code on an already-open readline interface.
// Returns the trimmed input, or null if the user pressed Enter with no input.
function promptCode(rl) {
  return new Promise((resolve) => {
    rl.question(
      "\nEnter the 4-letter code shown in the extension popup (Enter to cancel): ",
      (ans) => resolve(ans.trim() || null),
    );
  });
}

// ── pair via a running Primary server ─────────────────────────────────────

async function pairViaRunningServer(serverWs) {
  return new Promise((resolve, reject) => {
    let done = false;

    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const finish = (err) => {
      if (done) return;
      done = true;
      rl.close();
      try { serverWs.close(); } catch (_) {}
      if (err) reject(err); else resolve();
    };

    serverWs.on("error", (err) => finish(err));
    serverWs.on("close", () => {
      if (!done) finish(new Error("Server disconnected before pairing completed."));
    });

    serverWs.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }
      if (msg.type !== "uploads_pair_result") return;

      if (msg.ok) {
        console.log("\n  Paired! Upload config access is now enabled for this extension.\n");
        finish(null);
      } else if (msg.reason === "locked_out") {
        console.error(`\n  Too many wrong attempts. Locked out for ${msg.secsLeft}s.\n`);
        finish(null);
      } else {
        const triesLeft = msg.triesLeft !== undefined ? ` (${msg.triesLeft} tries left)` : "";
        console.error(`\n  Wrong code${triesLeft}. Check the code in the extension popup.`);
        // Re-prompt
        askCode();
      }
    });

    function askCode() {
      rl.question(
        "\nEnter the 4-letter code shown in the extension popup (Enter to cancel): ",
        (ans) => {
          const code = ans.trim();
          if (!code) {
            console.log("\n  Cancelled.\n");
            finish(null);
            return;
          }
          serverWs.send(JSON.stringify({ type: "uploads_pair_submit", code }));
        },
      );
    }

    process.on("SIGINT", () => { console.log(); finish(null); process.exit(0); });
    askCode();
  });
}

// ── pair via a temporary listener (no Primary running) ────────────────────

const TEMP_IDLE_MS = 5 * 60 * 1000; // 5 minutes

async function pairViaTempListener(port) {
  const WebSocket = require("ws");
  const { PairHost } = require("../mcp-server/pair-host.js");
  const readline = require("readline");

  const pairHost = new PairHost();
  let idleTimer = null;
  let server = null;
  let done = false;

  const cleanup = () => {
    if (done) return;
    done = true;
    clearTimeout(idleTimer);
    try { server && server.close(); } catch (_) {}
  };

  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.error("\n\n  Timed out waiting for extension. Closing listener.\n");
      cleanup();
      process.exit(0);
    }, TEMP_IDLE_MS);
  };

  server = new WebSocket.WebSocketServer({ host: "127.0.0.1", port });

  await new Promise((resolve, reject) => {
    server.on("listening", resolve);
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is in use. Is another poltertab already running?`));
      } else {
        reject(err);
      }
    });
  });

  console.log(`\n  No poltertab server found. Started a temporary pairing listener on port ${port}.`);
  console.log("  Open the extension popup — it will connect automatically and show a 4-letter code.\n");
  console.log("  (Ctrl-C or Enter with no code to cancel. Closes automatically in 5 minutes.)\n");

  resetIdle();
  process.on("SIGINT", () => { console.log(); cleanup(); process.exit(0); });

  return new Promise((resolve, reject) => {
    server.on("connection", (ws, req) => {
      const origin = (req.headers && req.headers.origin) || null;
      resetIdle();

      // Only accept chrome-extension:// sockets; silently close anything else
      // (browser-control Secondaries, MCP clients, etc.).
      if (!origin || !origin.startsWith("chrome-extension://")) {
        ws.close(4000, "pairing-only listener");
        return;
      }

      ws.on("message", (raw) => {
        resetIdle();
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { return; }

        if (msg.type === "extension_ready" || msg.type === "ping") {
          pairHost.generateForSocket(ws, origin);

          // Code has been pushed to the extension popup. Now prompt the user.
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl.question(
            "Enter the 4-letter code shown in the extension popup (Enter to cancel): ",
            (ans) => {
              rl.close();
              const code = (ans || "").trim();
              if (!code) {
                console.log("\n  Cancelled.\n");
                cleanup();
                resolve();
                return;
              }

              const result = pairHost.submitCode(code);
              if (result.ok) {
                const bareId = result.extensionId.slice("chrome-extension://".length).replace(/\/$/, "");
                try { addTrustedExtensionId(bareId); } catch (e) {
                  cleanup();
                  reject(new Error(`Could not write config: ${e.message}`));
                  return;
                }
                try {
                  if (result.extWs && result.extWs.readyState === WebSocket.OPEN) {
                    result.extWs.send(JSON.stringify({ type: "uploads_paired" }));
                  }
                } catch (_) {}
                console.log("\n  Paired! Upload config access is now enabled for this extension.\n");
                cleanup();
                resolve();
              } else if (result.reason === "locked_out") {
                console.error(`\n  Too many wrong attempts. Locked out for ${result.secsLeft}s.\n`);
                cleanup();
                resolve();
              } else {
                const triesLeft = result.triesLeft !== undefined ? ` (${result.triesLeft} tries left)` : "";
                console.error(`\n  Wrong code${triesLeft}. Check the code in the extension popup.\n`);
                cleanup();
                resolve();
              }
            },
          );
          return;
        }

        if (msg.type === "pair_code_request") {
          pairHost.handleCodeRequest(ws, origin);
          return;
        }

        // All other message types are refused by this listener.
      });

      ws.on("close", () => pairHost.onSocketClose(ws));
      ws.on("error", () => pairHost.onSocketClose(ws));
    });
  });
}

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
      console.log("  Upload config access is now enabled for this extension.\n");
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

  const port = resolveWsPort();

  let serverWs = null;
  try {
    serverWs = await tryConnectToServer(port);
  } catch (err) {
    if (err.code !== "ECONNREFUSED" && err.code !== "ENOENT") {
      console.error(`\nCould not connect to port ${port}: ${err.message}`);
      if (err.code && err.code !== "ETIMEDOUT") {
        console.error("Something else may be using this port.\n");
      }
      process.exit(1);
    }
    // Nothing listening — start temp listener.
  }

  if (serverWs) {
    await pairViaRunningServer(serverWs);
  } else {
    await pairViaTempListener(port);
  }
}

// ── poltertab uploads unpair ───────────────────────────────────────────────

async function runUnpair(argv) {
  const idFlagIdx = argv.indexOf("--id");
  const flagId = idFlagIdx !== -1 ? argv[idFlagIdx + 1] : null;

  if (flagId) {
    const removed = removeTrustedExtensionId(flagId);
    if (removed) {
      console.log(`\n  Unpaired: ${flagId}\n`);
    } else {
      console.log(`\n  Not found in paired extensions: ${flagId}\n`);
    }
    return;
  }

  const ids = getTrustedExtensionIds();
  if (ids.length === 0) {
    console.log("\n  No extensions are currently paired.\n");
    return;
  }
  for (const id of ids) {
    removeTrustedExtensionId(id);
  }
  console.log(`\n  Unpaired ${ids.length} extension${ids.length === 1 ? "" : "s"}.\n`);
}

module.exports = { run };
