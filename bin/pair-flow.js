"use strict";

// Shared pairing-flow primitives used by both `poltertab setup` and
// `poltertab uploads pair`. These handle the code-exchange protocol but
// never print command-specific headers — callers print those.

const { addTrustedExtensionId } = require("../mcp-server/uploads-config.js");

// ── port resolution ────────────────────────────────────────────────────────

function resolveWsPort() {
  try {
    return require("../mcp-server/config.js").resolvePort();
  } catch (_) {
    return 7822;
  }
}

// ── server connection ──────────────────────────────────────────────────────

// Resolves with the open socket; rejects with err.code === "ECONNREFUSED"
// if nothing is listening, or err.code === "ETIMEDOUT" on timeout.
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

// ── Ctrl-C ─────────────────────────────────────────────────────────────────

// On a TTY readline runs the terminal in raw mode, so Ctrl-C reaches it as a
// keypress and no SIGINT is ever raised: with no "SIGINT" listener on rl the
// interface just closes and the pairing wait hangs. Listen on both rl and the
// process (a real SIGINT still arrives from `kill -INT` or a non-raw terminal)
// and return a function that removes both listeners.
function onCancel(rl, handler) {
  const hasRlEvents = rl && typeof rl.on === "function";
  if (hasRlEvents) rl.on("SIGINT", handler);
  process.on("SIGINT", handler);
  return () => {
    if (hasRlEvents) rl.removeListener("SIGINT", handler);
    process.removeListener("SIGINT", handler);
  };
}

// ── pair via running Primary server ────────────────────────────────────────

// Uses the running server as the pair host. The server manages codes and
// sends uploads_pair_result when the user submits a code.
//
// rl — an already-open readline.Interface (shared with the wizard).
//
// Returns:
//   { ok: true, extensionId }              — success
//   { ok: false, reason: 'skipped' }       — user pressed Enter with no code
//   { ok: false, reason: 'locked' }        — 5-attempt lockout triggered
//   { ok: false, reason: 'cancelled' }     — user pressed Ctrl-C
//   { ok: false, reason: 'error'|... }     — connection or server error
function pairViaRunningServer(serverWs, rl) {
  return new Promise((resolve) => {
    let done = false;
    let stopCancel = () => {};

    const finish = (result) => {
      if (done) return;
      done = true;
      stopCancel();
      try { serverWs.close(); } catch (_) {}
      resolve(result);
    };

    stopCancel = onCancel(rl, () => finish({ ok: false, reason: "cancelled" }));

    serverWs.on("error", (err) => finish({ ok: false, reason: "error", error: err }));
    serverWs.on("close", () => {
      if (!done) finish({ ok: false, reason: "server_disconnected" });
    });

    serverWs.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }
      if (msg.type !== "uploads_pair_result") return;

      if (msg.ok) {
        finish({ ok: true, extensionId: msg.extensionId });
      } else if (msg.reason === "locked_out") {
        const mins = msg.secsLeft ? Math.ceil(msg.secsLeft / 60) : 15;
        process.stderr.write(
          `\n  Too many wrong codes. Pairing is locked for ${mins} minutes.\n` +
          "  (You can still pair during the lockout with: poltertab uploads pair --id <extension-id>)\n",
        );
        finish({ ok: false, reason: "locked" });
      } else if (msg.reason === "expired") {
        process.stderr.write(
          "  That code expired — the popup is showing a fresh one. Try again.\n",
        );
        askCode();
      } else if (msg.reason === "config_write_failed") {
        process.stderr.write(
          "  Pairing failed — could not save the extension ID to config.json.\n" +
          "  Check that the file is writable, then try again.\n",
        );
        finish({ ok: false, reason: "config_write_failed" });
      } else {
        const triesLeft =
          msg.triesLeft !== undefined ? ` ${msg.triesLeft} tries left.` : "";
        process.stderr.write(`  That code didn’t match.${triesLeft}\n`);
        askCode();
      }
    });

    function askCode() {
      rl.question("  Code (Enter to skip): ", (ans) => {
        const code = (ans || "").trim().toUpperCase().replace(/\s+/g, "");
        if (!code) { finish({ ok: false, reason: "skipped" }); return; }
        serverWs.send(JSON.stringify({ type: "uploads_pair_submit", code }));
      });
    }

    askCode();
  });
}

// ── pair via temporary listener (no Primary running) ──────────────────────

const TEMP_IDLE_MS = 5 * 60 * 1000; // 5-minute idle timeout

// Binds a pairing-only WebSocket server on port. Waits for a
// chrome-extension:// socket, generates a code for it, then prompts the
// user to type the code.
//
// opts.onStatus(msg) — called when the extension connects; callers use it
//   to print the "extension connected" status line.
//
// Returns { ok: true, extensionId } | { ok: false, reason }; reason is
// 'cancelled' on Ctrl-C, after the listener has been closed.
async function pairViaTempListener(port, rl, { onStatus } = {}) {
  const WebSocket = require("ws");
  const { PairHost } = require("../mcp-server/pair-host.js");

  const pairHost = new PairHost();
  let idleTimer = null;
  let server = null;
  let resolved = false;

  const cleanup = () => {
    clearTimeout(idleTimer);
    if (server) {
      try { server.clients.forEach((c) => c.terminate()); } catch (_) {}
      try { server.close(); } catch (_) {}
    }
  };

  server = new WebSocket.WebSocketServer({ host: "127.0.0.1", port });

  // Wait for the server to start listening before returning.
  await new Promise((resolve, reject) => {
    server.on("listening", resolve);
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(Object.assign(new Error(`Port ${port} is in use`), { code: "EADDRINUSE" }));
      } else {
        reject(err);
      }
    });
  });

  return new Promise((outerResolve) => {
    let stopCancel = () => {};
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      stopCancel();
      cleanup();
      outerResolve(result);
    };

    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish({ ok: false, reason: "skipped" }), TEMP_IDLE_MS);
    };

    stopCancel = onCancel(rl, () => finish({ ok: false, reason: "cancelled" }));

    resetIdle();

    server.on("connection", (ws, req) => {
      const origin = (req.headers && req.headers.origin) || null;
      resetIdle();

      // Only accept chrome-extension:// sockets; silently close everything else.
      if (!origin || !origin.startsWith("chrome-extension://")) {
        ws.close(4000, "pairing-only listener");
        return;
      }

      ws.on("message", (raw) => {
        resetIdle();
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { return; }

        if (msg.type === "extension_ready") {
          // Generate a code only on first contact; subsequent pings must not regenerate.
          if (!pairHost._socketCodes.has(ws)) {
            pairHost.generateForSocket(ws, origin);
            if (onStatus) onStatus("extension connected — the code is in its popup");
            askCode();
          }
          return;
        }

        if (msg.type === "ping") {
          // Keep-alive — just reset the idle timer (already done above); do NOT regenerate.
          return;
        }

        if (msg.type === "pair_code_request") {
          pairHost.handleCodeRequest(ws, origin);
          return;
        }

        // Popup/options asking whether this extension is paired yet.
        // Reply with uploads_not_paired so the UI can show the pair code.
        if (msg.type === "uploads_get_config") {
          try {
            if (ws.readyState === 1 /* OPEN */) {
              const reply = { type: "uploads_not_paired", pairCode: pairHost._socketCodes.get(ws) || null };
              if (msg._replyId !== undefined) reply._replyId = msg._replyId;
              ws.send(JSON.stringify(reply));
            }
          } catch (_) {}
          return;
        }

        // Non-pairing message from a Secondary or AI tool dialing in during setup.
        try {
          if (ws.readyState === 1 /* OPEN */) {
            ws.send(JSON.stringify({
              type: "error",
              error: "pairing mode — restart your AI tool for browser control",
            }));
          }
        } catch (_) {}
      });

      ws.on("close", () => pairHost.onSocketClose(ws));
      ws.on("error", () => pairHost.onSocketClose(ws));

      function askCode() {
        rl.question("  Code (Enter to skip): ", (ans) => {
          const code = (ans || "").trim().toUpperCase().replace(/\s+/g, "");
          if (!code) { finish({ ok: false, reason: "skipped" }); return; }

          const result = pairHost.submitCode(code);
          if (result.ok) {
            const bareId = result.extensionId
              .replace(/^chrome-extension:\/\//, "")
              .replace(/\/$/, "");
            let writeErr = null;
            try { addTrustedExtensionId(bareId); } catch (e) { writeErr = e; }
            if (writeErr) {
              // Re-push to the specific extension that matched, not the enclosing socket.
              if (result.extWs && result.extWs.readyState === WebSocket.OPEN) {
                pairHost.generateForSocket(result.extWs, result.extensionId);
              }
              process.stderr.write(
                "  Pairing failed — could not save the extension ID to config.json.\n" +
                "  Check that the file is writable, then try again.\n",
              );
              finish({ ok: false, reason: "config_write_failed" });
              return;
            }
            try {
              if (result.extWs && result.extWs.readyState === WebSocket.OPEN) {
                result.extWs.send(JSON.stringify({ type: "uploads_paired" }));
              }
            } catch (_) {}
            finish({ ok: true, extensionId: bareId });
          } else if (result.reason === "locked_out") {
            const mins = result.secsLeft ? Math.ceil(result.secsLeft / 60) : 15;
            process.stderr.write(
              `\n  Too many wrong codes. Pairing is locked for ${mins} minutes.\n` +
              "  (You can still pair during the lockout with: poltertab uploads pair --id <extension-id>)\n",
            );
            finish({ ok: false, reason: "locked" });
          } else if (result.reason === "expired") {
            process.stderr.write(
              "  That code expired — the popup is showing a fresh one. Try again.\n",
            );
            askCode();
          } else {
            const triesLeft =
              result.triesLeft !== undefined ? ` ${result.triesLeft} tries left.` : "";
            process.stderr.write(`  That code didn’t match.${triesLeft}\n`);
            askCode();
          }
        });
      }
    });
  });
}

// ── poltertab server probe ─────────────────────────────────────────────────

// Returns true when the server at port is a poltertab Primary.
// Prevents treating an unrelated WebSocket server as the pair host.
async function probeIsPoltertab(port) {
  const http = require("http");
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/status", timeout: 2000 }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const body = JSON.parse(data);
          resolve(body.role === "primary");
        } catch (_) { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

module.exports = {
  resolveWsPort,
  tryConnectToServer,
  probeIsPoltertab,
  pairViaRunningServer,
  pairViaTempListener,
};
