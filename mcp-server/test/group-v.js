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

// Bind regression tests (DAG-23 fix/legacy-bind, then fix/ws-loopback-bind).
//
// History: 1.8.0-beta.2 bound 127.0.0.1 + ::1, and on macOS/BSD a legacy
// 1.7.x server's wildcard listen(P) succeeded beside it (SO_REUSEADDR), so the
// primary moved to a wildcard bind. That made the bridge reachable from every
// network the machine is on, and a client that sends no Origin (as Secondaries
// and the CLI do) passes allowOrigin. The primary now binds loopback only
// again; election against an older wildcard-bound primary rests on the
// probe-before-listen, which dials 127.0.0.1 and demotes on any answer.
//
// V1   A server started beside an older wildcard-bound primary (1.8-1.11)
//      becomes a Secondary instead of a second primary.
// V2a  /status from 127.0.0.1 returns 200.
// V2b  /status from a non-loopback address is refused (404 or no connection).
// V3   Primary is reachable via ::1 (Node 18 localhost = ::1).
// V4   Nothing on a non-loopback address of this machine can open a WebSocket
//      to the primary; 127.0.0.1 and ::1 still can.
//      FAILS on 47fbf96 (wildcard bind accepts the LAN address).

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

  // ── V1: an older wildcard-bound primary already holds the port ──
  {
    const port = await freePort();
    // 1.8.0-1.11.x listen(port) with no host: the IPv6 wildcard, dual-stack.
    // Any answer on 127.0.0.1 is enough for the probe to demote the newcomer.
    const held = new Set();
    const legacy = net.createServer((s) => {
      held.add(s);
      s.on("error", () => {});
    });
    await new Promise((r) => legacy.listen(port, r));
    const node = startServer({ port });
    try {
      await waitFor(
        "newcomer demoted",
        () => node.stderr.includes("switching to Secondary Mode"),
        10000,
      );
      await test(
        "V1 a server started beside an older wildcard-bound primary becomes a Secondary",
        () => {
          assert.ok(
            !node.stderr.includes("WebSocket server listening"),
            "the newcomer also became a primary beside the older one",
          );
        },
      );
    } finally {
      await stop(node);
      // close() waits for every connection, and the newcomer's last
      // handshake attempt is still held open here.
      for (const s of held) s.destroy();
      await new Promise((r) => legacy.close(r));
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
        await test("V2b /status from LAN IP is refused (no connection, 404 or 403)", async () => {
          const code = await httpGetStatus(lanIp, port);
          assert.ok(
            code === null || code === 404 || code === 403,
            `/status from ${lanIp} returned ${code}; expected no answer, 404 or 403`,
          );
        });
      } else {
        // No external interface. Ask the real server from another source
        // address: 127.0.0.2 is not on the allowlist, and Linux routes all of
        // 127/8 to lo. macOS has only 127.0.0.1 on lo0, so there the bind
        // fails and the case is skipped out loud rather than passed on a copy
        // of the predicate (NICE-2).
        const r = await new Promise((resolve) => {
          const req = http.get(
            { host: "127.0.0.1", port, path: "/status", localAddress: "127.0.0.2", timeout: 2000 },
            (res) => {
              res.resume();
              resolve({ status: res.statusCode });
            },
          );
          req.on("timeout", () => req.destroy(new Error("timeout")));
          req.on("error", (e) => resolve({ error: e.code || e.message }));
        });
        if (r.error === "EADDRNOTAVAIL") {
          console.log("  SKIP  V2b no LAN interface and no second loopback address to ask from");
        } else {
          await test("V2b /status from 127.0.0.2 (not on the allowlist) is refused (404)", () => {
            assert.strictEqual(r.status, 404, JSON.stringify(r));
          });
        }
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
  // ── V4: loopback only. A non-loopback address of this machine stands in
  // for another host on the same network: the socket's source and target are
  // both that address, so it never touches lo0/lo. ──
  {
    const port = await freePort();
    const primary = startServer({ port });
    const dial = (host, localAddress) =>
      new Promise((resolve) => {
        const url = `ws://${host.includes(":") ? `[${host}]` : host}:${port}`;
        // No Origin header: the shape of a Secondary or the CLI, which
        // allowOrigin lets through.
        const ws = new WebSocket(url, { handshakeTimeout: 2000, localAddress });
        ws.once("open", () => {
          ws.terminate();
          resolve("open");
        });
        ws.once("error", (e) => resolve(e.code || e.message));
      });
    try {
      await waitFor(
        "primary listening",
        () => primary.stderr.includes("WebSocket server listening"),
        10000,
      );
      const lanIp = getLanIp();
      if (lanIp) {
        await test(`V4a a WebSocket from a non-loopback address (${lanIp}) is refused`, async () => {
          const r = await dial(lanIp, lanIp);
          assert.notStrictEqual(r, "open", `the primary accepted a WebSocket on ${lanIp}`);
        });
      } else {
        console.log("  SKIP  V4a no non-loopback IPv4 address on this machine");
      }
      await test("V4b 127.0.0.1 and ::1 still open a WebSocket", async () => {
        assert.strictEqual(await dial("127.0.0.1"), "open", "127.0.0.1");
        assert.strictEqual(await dial("::1"), "open", "::1");
      });
    } finally {
      await stop(primary);
    }
  }
}

module.exports = groupV;
