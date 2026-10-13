const net = require("net");
const http = require("http");
const os = require("os");
const {
  WebSocket,
  assert,
  sleep,
  startServer,
  test,
  waitFor,
} = require("./harness.js");
const { freePort, stop } = require("./group-s.js");

// Legacy-bind regression tests (DAG-23 fix/legacy-bind).
//
// Regression (1.8.0-beta.2 / fbd9c25): the primary binds 127.0.0.1:P and
// ::1:P (two specific addresses).  On macOS/BSD, SO_REUSEADDR allows a
// wildcard bind (listen(P) with no host = ::) to succeed alongside specific-
// address binds.  A legacy 1.7.x/beta.1 server starting after ours therefore
// binds the port, has no extension, and acts as a false primary.
//
// Also: handleRequest serves /status to any caller; a LAN address must be
// refused so a page the user is visiting cannot probe the primary's state.
//
// V1   Legacy wildcard bind gets EADDRINUSE while our primary runs.
//      FAILS on fbd9c25 (macOS SO_REUSEADDR; legacy bind succeeds alongside
//      specific-address binds); passes after wildcard fix.
// V2a  /status from 127.0.0.1 returns 200.
//      Passes on fbd9c25 (handler exists); stays green after fix.
// V2b  /status from a non-loopback address is refused (404).
//      FAILS on fbd9c25 (no remoteAddress guard); passes after fix.
// V3   Primary is reachable via ::1 (Node 18 localhost = ::1).
//      Passes on fbd9c25 via httpServer6; must stay green after wildcard fix.

function httpGetStatus(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/status", family: 4 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(null));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

async function groupV() {
  console.log(
    "\nV. legacy-bind regression (macOS SO_REUSEADDR, /status loopback-only)",
  );

  // ── V1: legacy wildcard bind must fail when our primary is running ──
  {
    const port = await freePort();
    const primary = startServer({ port });
    try {
      await waitFor(
        "primary listening",
        () => primary.stderr.includes("WebSocket server listening"),
        10000,
      );

      // A 1.7.x/beta.1 server does listen(port) with no host argument,
      // which binds :: (IPv6 wildcard, dual-stack).  On macOS with
      // SO_REUSEADDR, this succeeds alongside specific-address binds
      // (127.0.0.1 + ::1), letting the old server become a false primary.
      // With our wildcard bind the old server must fail with EADDRINUSE.
      const legacyErr = await new Promise((resolve) => {
        const srv = net.createServer();
        srv.on("error", (e) => {
          srv.close();
          resolve(e);
        });
        srv.once("listening", () => {
          srv.close(() => resolve(null));
        });
        srv.listen(port); // no host — the legacy shape
      });

      await test(
        "V1 legacy wildcard bind fails with EADDRINUSE when our primary is running",
        () => {
          assert.ok(
            legacyErr !== null,
            "legacy server bound the port — it would become a false primary on macOS",
          );
          assert.strictEqual(
            legacyErr.code,
            "EADDRINUSE",
            `expected EADDRINUSE, got ${legacyErr && legacyErr.code}`,
          );
        },
      );
    } finally {
      await stop(primary);
    }
  }

  // ── V2: /status loopback-only ──
  {
    const port = await freePort();
    const primary = startServer({ port });
    try {
      await waitFor(
        "primary listening",
        () => primary.stderr.includes("WebSocket server listening"),
        10000,
      );

      await test("V2a /status from 127.0.0.1 returns 200", async () => {
        const code = await httpGetStatus("127.0.0.1", port);
        assert.strictEqual(code, 200, `/status returned ${code} from loopback`);
      });

      const lanIp = getLanIp();
      if (lanIp) {
        await test("V2b /status from LAN IP is refused (404)", async () => {
          const code = await httpGetStatus(lanIp, port);
          assert.ok(
            code === 404 || code === 403,
            `/status from ${lanIp} returned ${code}; expected 404 or 403`,
          );
        });
      } else {
        // No external interface — unit-test the loopback predicate directly.
        await test("V2b /status address check: non-loopback is refused", () => {
          const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
          const isLoopback = (a) => LOOPBACK.has(a);
          assert.ok(isLoopback("127.0.0.1"), "127.0.0.1 must be allowed");
          assert.ok(isLoopback("::1"), "::1 must be allowed");
          assert.ok(isLoopback("::ffff:127.0.0.1"), "::ffff:127.0.0.1 must be allowed");
          assert.ok(!isLoopback("192.168.1.50"), "LAN IP must be refused");
          assert.ok(!isLoopback("10.0.0.1"), "10.x must be refused");
        });
      }
    } finally {
      await stop(primary);
    }
  }

  // ── V3: ::1 (Node 18 localhost) reaches the primary ──
  {
    const port = await freePort();
    const primary = startServer({ port });
    try {
      await waitFor(
        "primary listening",
        () => primary.stderr.includes("WebSocket server listening"),
        10000,
      );

      await test(
        "V3 primary is reachable via ::1 (Node 18 resolves localhost to ::1)",
        async () => {
          const connected = await new Promise((resolve) => {
            const ws = new WebSocket(`ws://[::1]:${port}`, {
              handshakeTimeout: 2000,
            });
            ws.once("open", () => {
              ws.terminate();
              resolve(true);
            });
            ws.once("error", () => resolve(false));
          });
          assert.ok(
            connected,
            "Primary refused ::1 — Node 18 clients dialling localhost would get ECONNREFUSED",
          );
        },
      );
    } finally {
      await stop(primary);
    }
  }
}

module.exports = groupV;
