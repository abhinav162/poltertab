const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");
const {
  WebSocket,
  assert,
  path,
  sleep,
  startServer,
  test,
  waitFor,
} = require("./harness.js");
const bridge = require("../bridge.js");

// Connection arbitration between MCP servers sharing one port (DAG-23 PR-1).
//
// The bug: a Primary at capacity closed a Secondary with no code, the
// Secondary read that as "Primary died", tried to promote, hit EADDRINUSE,
// minted a new nodeId and reconnected — to be refused again ~8 ms later,
// forever. Every case here runs on its own free port with real processes, so
// none of them can touch a port a person or another agent is using.

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A hand-rolled Secondary speaking the wire protocol, so a test can fill a
// Primary with fifty of them or pose as an old (versionless) client.
function fakeSecondary(port, { version, nodeId } = {}) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const st = {
    ws,
    nodeId: nodeId || crypto.randomUUID(),
    open: false,
    closed: false,
    code: null,
    reason: "",
    seen: [],
  };
  ws.on("open", () => {
    st.open = true;
    ws.send(
      JSON.stringify({
        type: "secondary_mcp",
        nodeId: st.nodeId,
        ...(version ? { version, pid: process.pid, parentPid: process.ppid } : {}),
      }),
    );
  });
  ws.on("message", (raw) => st.seen.push(JSON.parse(raw)));
  ws.on("close", (code, reason) => {
    st.closed = true;
    st.code = code;
    st.reason = reason.toString();
  });
  ws.on("error", () => {});
  return st;
}

// stderr with arrival times, for asserting on how often something happened.
function stamped(srv) {
  const lines = [];
  let buf = "";
  srv.proc.stderr.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      lines.push({ t: Date.now(), line: buf.slice(0, i) });
      buf = buf.slice(i + 1);
    }
  });
  return lines;
}

const count = (s, needle) => s.split(needle).length - 1;
const nodeIdsIn = (s) => [...s.matchAll(/Node (\S+) running as Secondary/g)].map((m) => m[1]);
const connectedLines = (s) => count(s, "Secondary node connected:");

async function fill(srv, port, n, opts) {
  const fakes = [];
  for (let i = 0; i < n; i++) fakes.push(fakeSecondary(port, opts));
  // Old code refuses most of these; let them settle either way so the case
  // that follows asserts on behaviour, not on a setup timeout.
  await waitFor(
    `${n} fakes settled`,
    () => fakes.every((f) => f.closed || f.open) &&
      connectedLines(srv.stderr) + fakes.filter((f) => f.closed).length >= n,
    5000,
  ).catch(() => {});
  return fakes;
}

function closeAll(fakes) {
  for (const f of fakes) {
    try {
      f.ws.terminate();
    } catch (_) {}
  }
}

async function stop(...srvs) {
  for (const s of srvs) if (s && s.proc.exitCode === null) s.proc.kill("SIGKILL");
  await sleep(200);
}

async function groupS() {
  console.log("\nS. connection arbitration (rejection loop, promotion, ceiling)");

  // ── T1 rejection, and the live half of T5 (backoff between retries) ──
  {
    const port = await freePort();
    const primary = startServer({ port });
    let fakes = [];
    let secondary = null;
    let extraId = null;
    try {
      await waitFor("primary listening", () => primary.stderr.includes("WebSocket server listening"));
      fakes = await fill(primary, port, 50, { version: "test" });

      await test("S1 (T1) a v2 Secondary over the ceiling is closed with 4000 and a JSON reason", async () => {
        assert.strictEqual(
          fakes.filter((f) => f.closed).length,
          0,
          `the default ceiling refused ${fakes.filter((f) => f.closed).length} of 50 secondaries`,
        );
        const extra = fakeSecondary(port, { version: "test" });
        extraId = extra.nodeId;
        await waitFor("extra closed", () => extra.closed, 3000).catch(() => {});
        assert.strictEqual(extra.code, 4000, `closed with ${extra.code}, reason ${JSON.stringify(extra.reason)}`);
        const reason = JSON.parse(extra.reason);
        assert.strictEqual(reason.reason, "capacity_rejected");
        assert.strictEqual(reason.limit, 50);
        assert.ok(Buffer.byteLength(extra.reason) <= 123, "close reason exceeds RFC 6455's 123 bytes");
      });

      secondary = startServer({ port });
      const lines = stamped(secondary);
      await sleep(8500);
      const rejections = lines.filter((l) => /refused this node \(4000/.test(l.line));

      await test("S2 (T1) a refused Secondary backs off instead of promoting", () => {
        const err = secondary.stderr;
        assert.ok(
          !err.includes("Primary WebSocket server listening"),
          "the refused Secondary bound a server",
        );
        assert.strictEqual(
          count(err, "in use, switching to Secondary Mode"),
          1,
          `tried to bind the port ${count(err, "in use, switching to Secondary Mode")} times in 8.5 s`,
        );
        const ids = new Set(nodeIdsIn(err));
        assert.strictEqual(ids.size, 1, `minted ${ids.size} nodeIds in 8.5 s`);
        const refusedIds = new Set(
          [...primary.stderr.matchAll(/Rejecting secondary node (\S+?)[ .]/g)]
            .map((m) => m[1])
            .filter((id) => id !== extraId),
        );
        assert.strictEqual(refusedIds.size, 1, `the Primary refused ${refusedIds.size} distinct nodeIds`);
      });

      await test("S3 (T5) retries are spaced 2 s then 4 s, ±25%", () => {
        assert.ok(
          rejections.length === 3,
          `expected 3 refusals in 8.5 s (t=0, ~2 s, ~6 s), saw ${rejections.length}`,
        );
        const gap1 = rejections[1].t - rejections[0].t;
        const gap2 = rejections[2].t - rejections[1].t;
        assert.ok(gap1 >= 1500 && gap1 <= 2600, `first retry after ${gap1} ms`);
        assert.ok(gap2 >= 3000 && gap2 <= 5100, `second retry after ${gap2} ms`);
      });
    } finally {
      closeAll(fakes);
      await stop(secondary, primary);
    }
  }

  // ── T5, pure: the schedule itself ──
  await test("S4 (T5) backoff schedule: 2 s × 2 per attempt, ±25% jitter, capped at 60 s", () => {
    const next = bridge._backoffDelay;
    assert.strictEqual(typeof next, "function", "no backoff schedule exported");
    assert.strictEqual(next(0, () => 0.5), 2000);
    assert.strictEqual(next(1, () => 0.5), 4000);
    assert.strictEqual(next(2, () => 0.5), 8000);
    assert.strictEqual(next(0, () => 0), 1500);
    assert.strictEqual(next(0, () => 1), 2500);
    assert.strictEqual(next(5, () => 0.5), 60000, "not capped");
    assert.strictEqual(next(30, () => 1), 60000, "jitter pushed past the cap");
    const samples = Array.from({ length: 500 }, () => next(0));
    assert.ok(samples.every((d) => d >= 1500 && d <= 2500), "a sample left ±25%");
    assert.ok(Math.min(...samples) < 1700 && Math.max(...samples) > 2300, "no jitter");
  });

  // ── T8 (PR-1 half): legacy secondaries are never refused, never counted ──
  {
    const port = await freePort();
    const primary = startServer({ port, env: { POLTERTAB_MAX_SECONDARIES: "2" } });
    const all = [];
    try {
      await waitFor("primary listening", () => primary.stderr.includes("WebSocket server listening"));
      const legacy = await fill(primary, port, 3);
      const v2 = await fill(primary, port, 2, { version: "test" });
      all.push(...legacy, ...v2);

      await test("S5 (T8) legacy Secondaries do not count toward the v2 ceiling", () => {
        const refused = [...legacy, ...v2].filter((f) => f.closed);
        assert.strictEqual(refused.length, 0, `${refused.length} refused with codes ${refused.map((f) => f.code)}`);
        for (const f of v2) {
          assert.ok(
            f.seen.some((m) => m.type === "secondary_accepted" && m.nodeId === f.nodeId),
            "a v2 Secondary got no secondary_accepted",
          );
        }
      });

      await test("S6 POLTERTAB_MAX_SECONDARIES sets the v2 ceiling", async () => {
        const third = fakeSecondary(port, { version: "test" });
        all.push(third);
        await waitFor("third closed", () => third.closed, 3000).catch(() => {});
        assert.strictEqual(third.code, 4000, `closed with ${third.code}`);
        assert.strictEqual(JSON.parse(third.reason).limit, 2);
      });

      await test("S7 (T8) a legacy Secondary at the ceiling is accepted, and gets no v2 frames", async () => {
        const late = fakeSecondary(port);
        all.push(late);
        await sleep(1000);
        assert.ok(late.open && !late.closed, `legacy client closed with ${late.code}: the promote loop's trigger`);
        assert.ok(primary.stderr.includes(`Secondary node connected: ${late.nodeId}`), "not registered");
        for (const f of [...legacy, late]) {
          assert.deepStrictEqual(f.seen.filter((m) => m.type === "secondary_accepted"), [], "a legacy client got a v2 frame");
        }
      });
    } finally {
      closeAll(all);
      await stop(primary);
    }
  }

  // ── T4: a failed bind closes its server ──
  {
    const port = await freePort();
    const primary = startServer({ port });
    try {
      await waitFor("primary listening", () => primary.stderr.includes("WebSocket server listening"));

      await test("S8 (T4) EADDRINUSE closes the server it failed to bind", async () => {
        // In-process, so the test can see the http.Server objects themselves.
        const probe = `
          process.argv.push("--port", "${port}");
          const http = require("http");
          const made = [];
          const create = http.createServer;
          http.createServer = (...a) => {
            const s = create(...a);
            const rec = { closed: false };
            made.push(rec);
            const close = s.close.bind(s);
            s.close = (...c) => { rec.closed = true; return close(...c); };
            return s;
          };
          const bridge = require(${JSON.stringify(path.join(__dirname, "..", "bridge.js"))});
          bridge.start();
          setTimeout(() => {
            const servers = process._getActiveHandles().filter((h) => h instanceof http.Server).length;
            console.log(JSON.stringify({ made: made.length, closed: made.filter((m) => m.closed).length, servers }));
            process.exit(0);
          }, 1500);
        `;
        const out = await new Promise((resolve) => {
          const p = spawn(process.execPath, ["-e", probe], {
            env: { ...process.env, POLTERTAB_NO_UPDATE_CHECK: "1" },
          });
          let s = "";
          p.stdout.on("data", (d) => (s += d));
          p.on("exit", () => resolve(s.trim()));
        });
        const r = JSON.parse(out.split("\n").pop());
        // One per loopback address (127.0.0.1, ::1); every one is closed.
        assert.strictEqual(r.made, 2, `created ${r.made} servers`);
        assert.strictEqual(r.closed, 2, "a server made for the failed bind was never closed");
        assert.strictEqual(r.servers, 0, `${r.servers} http.Server handles still open`);
      });
    } finally {
      await stop(primary);
    }
  }

  // ── Review S1: backoff wraps the whole cycle, not only 4xxx closes ──
  {
    const port = await freePort();
    // Accepts TCP, never answers the upgrade: an event-loop-blocked Primary.
    const sockets = [];
    const hung = net.createServer((s) => sockets.push(s));
    await new Promise((r) => hung.listen(port, r));
    const secondary = startServer({ port });
    try {
      await sleep(8000);
      await test("S11 a hung Primary is backed off from, never promoted over", () => {
        const err = secondary.stderr;
        assert.ok(/Primary on port \d+ is not responding/.test(err), "the hung handshake never timed out");
        assert.ok(!err.includes("Primary WebSocket server listening"), "bound a server");
        assert.strictEqual(count(err, "in use, switching to Secondary Mode"), 1, "tried to bind again");
        assert.ok(sockets.length <= 3, `${sockets.length} connection attempts in 8 s`);
      });
    } finally {
      await stop(secondary);
      for (const s of sockets) s.destroy();
      await new Promise((r) => hung.close(r));
    }
  }
  {
    const port = await freePort();
    // A pre-PR-1 Primary at its limit: closes the Secondary with no code.
    const old = new WebSocket.WebSocketServer({ port });
    let attempts = 0;
    old.on("connection", (ws) => {
      ws.on("message", () => {
        attempts++;
        ws.close();
      });
    });
    await new Promise((r) => old.once("listening", r));
    const secondary = startServer({ port });
    try {
      await sleep(6000);
      await test("S12 a codeless close from an old Primary is backed off, not looped", () => {
        const err = secondary.stderr;
        assert.ok(!err.includes("Primary WebSocket server listening"), "bound a server");
        assert.strictEqual(new Set(nodeIdsIn(err)).size, 1, "minted a new nodeId");
        assert.ok(attempts >= 2 && attempts <= 3, `${attempts} handshakes in 6 s (expected t=0, ~2 s, ~6 s)`);
      });
    } finally {
      await stop(secondary);
      for (const c of old.clients) c.terminate();
      await new Promise((r) => old.close(r));
    }
  }

  // ── Jim's PR-1 review: S-1, S-2, NICE-2, NICE-3 ──
  {
    const port = await freePort();
    const primary = startServer({ port });
    const all = [];
    let ext = null;
    try {
      await waitFor("primary listening", () => primary.stderr.includes("WebSocket server listening"));
      ext = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://test" });
      const commands = [];
      ext.on("open", () => ext.send(JSON.stringify({ type: "extension_ready", version: "test" })));
      ext.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.id && m.action) commands.push(m);
      });
      await waitFor("extension connected", () => primary.stderr.includes("Chrome extension connected"));

      await test("S13 (review S-1) a socket that never registered cannot send commands", async () => {
        // A socket refused with 4000 an instant ago is exactly this: open,
        // unregistered, and stamped as the Primary agent by the extension.
        const raw = new WebSocket(`ws://localhost:${port}`);
        all.push({ ws: raw });
        const replies = [];
        raw.on("message", (m) => replies.push(JSON.parse(m)));
        await new Promise((r) => raw.on("open", r));
        raw.send(JSON.stringify({ type: "proxy_command", id: "stray-1", action: "navigate", params: { url: "http://x/" } }));
        await waitFor("reply", () => replies.length > 0, 3000).catch(() => {});
        assert.deepStrictEqual(commands.filter((c) => c.id === "stray-1"), [], "the extension received the stray command");
        assert.ok(replies[0] && replies[0].id === "stray-1" && replies[0].success === false, `reply: ${JSON.stringify(replies[0])}`);
        assert.ok(/\[not_registered\]/.test(replies[0].error), replies[0].error);
      });

      await test("S14 (review NICE-2) a nodeId that re-registers closes its displaced socket", async () => {
        const first = fakeSecondary(port, { version: "test" });
        all.push(first);
        await waitFor("first accepted", () => first.seen.some((m) => m.type === "secondary_accepted"), 3000);
        const second = fakeSecondary(port, { version: "test", nodeId: first.nodeId });
        all.push(second);
        await waitFor("second accepted", () => second.seen.some((m) => m.type === "secondary_accepted"), 3000);
        await waitFor("first closed", () => first.closed, 2000).catch(() => {});
        assert.ok(first.closed, "the displaced socket is still open");
        assert.strictEqual(first.code, 1000, `closed with ${first.code}`);
        await sleep(200);
        assert.ok(!second.closed, "the new socket was closed");
      });
    } finally {
      closeAll(all);
      if (ext) ext.terminate();
      await stop(primary);
    }
  }

  await test("S15 (review S-2) the port probe gives up on a socket that never answers", async () => {
    // A listener with a full accept backlog: no connect, no error, ever.
    assert.strictEqual(typeof bridge._probePrimary, "function", "probe not exported");
    const EventEmitter = require("events");
    const realConnect = net.connect;
    let fake = null;
    net.connect = () => {
      fake = new EventEmitter();
      fake.setTimeout = (ms, cb) => (fake.timer = setTimeout(cb, ms));
      fake.destroy = () => {
        clearTimeout(fake.timer);
        fake.destroyed = true;
      };
      return fake;
    };
    try {
      const t0 = Date.now();
      const r = await Promise.race([bridge._probePrimary(), sleep(4000).then(() => "hung")]);
      assert.strictEqual(r, true, `probe settled with ${r}`);
      assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
      assert.ok(fake.destroyed, "the probe socket was left open");
    } finally {
      net.connect = realConnect;
    }
  });

  await test("S16 (review NICE-3) POLTERTAB_MAX_SECONDARIES=0 means zero, junk means the default", () => {
    const { resolveMaxSecondaries } = require("../config.js");
    assert.strictEqual(typeof resolveMaxSecondaries, "function", "no resolver exported");
    assert.strictEqual(resolveMaxSecondaries({ POLTERTAB_MAX_SECONDARIES: "0" }), 0);
    assert.strictEqual(resolveMaxSecondaries({ POLTERTAB_MAX_SECONDARIES: "7" }), 7);
    assert.strictEqual(resolveMaxSecondaries({}), 50);
    assert.strictEqual(resolveMaxSecondaries({ POLTERTAB_MAX_SECONDARIES: "" }), 50);
    assert.strictEqual(resolveMaxSecondaries({ POLTERTAB_MAX_SECONDARIES: "lots" }), 50);
    assert.strictEqual(resolveMaxSecondaries({ POLTERTAB_MAX_SECONDARIES: "-3" }), 50);
    assert.strictEqual(resolveMaxSecondaries({ POLTERTAB_MAX_SECONDARIES: "2.5" }), 50);
  });

  // ── T3: promotion race, loser side ──
  {
    const port = await freePort();
    const primary = startServer({ port });
    let a = null;
    let b = null;
    try {
      await waitFor("primary listening", () => primary.stderr.includes("WebSocket server listening"));
      a = startServer({ port });
      b = startServer({ port });
      await waitFor("both connected", () => connectedLines(primary.stderr) === 2);
      const idA = nodeIdsIn(a.stderr)[0];
      const idB = nodeIdsIn(b.stderr)[0];
      const before = { a: a.stderr.length, b: b.stderr.length };
      primary.proc.kill("SIGKILL");

      const bound = (s, from) => s.stderr.slice(from).includes("WebSocket server listening");
      await waitFor("a promotion", () => bound(a, before.a) || bound(b, before.b), 10000).catch(() => {});
      const [winner, loser, loserId, loserFrom] = bound(a, before.a)
        ? [a, b, idB, before.b]
        : [b, a, idA, before.a];
      await waitFor(
        "loser rejoined",
        () => connectedLines(winner.stderr) >= 1,
        10000,
      ).catch(() => {});

      await test("S9 (T3) exactly one Secondary promotes when the Primary dies", () => {
        assert.ok(bound(winner, winner === a ? before.a : before.b), "nobody promoted");
        assert.ok(!bound(loser, loserFrom), "both Secondaries bound the port");
      });

      await test("S10 (T3) the loser rejoins under its original nodeId", () => {
        const rejoined = [...winner.stderr.matchAll(/Secondary node connected: (\S+?)\./g)].map((m) => m[1]);
        assert.ok(rejoined.length >= 1, "the loser never reconnected");
        assert.deepStrictEqual(
          [...new Set(rejoined)],
          [loserId],
          `rejoined as ${rejoined.join(", ")}, was ${loserId}`,
        );
        assert.deepStrictEqual([...new Set(nodeIdsIn(loser.stderr))], [loserId], "the loser minted a new nodeId");
      });
    } finally {
      await stop(a, b, primary);
    }
  }
}

module.exports = groupS;
// Group T (idle eviction) drives the same wire protocol.
Object.assign(groupS, { freePort, fakeSecondary, stamped, stop });
