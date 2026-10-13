const http = require("http");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { WebSocketServer } = require("ws");
const {
  WebSocket,
  assert,
  initialize,
  rpc,
  sleep,
  startServer,
  test,
  waitFor,
} = require("./harness.js");
const { freePort, fakeSecondary, stop } = require("./group-s.js");

// Command queue and /status (DAG-23 PR-3, design §3.4, §7.3, §7.5; T6, T7, T9,
// T11, T12).
//
// The Primary lets at most POLTERTAB_MAX_CONCURRENCY commands be at the
// extension at once. A v2 Secondary's command beyond that waits in a queue of
// its own (at most POLTERTAB_QUEUE_DEPTH deep), served round-robin with every
// other Secondary's and the Primary's own. Waiting is announced with a
// `queued` frame and ended with a `dispatched` frame — both re-arm the caller's
// timer, neither settles the command. A command whose caller has gone, or
// whose deadline passed while it waited, is dropped before the extension sees
// it. An old (versionless) Secondary understands neither frame, so its
// commands skip the queue and keep today's timing. GET /status reports all of
// it as JSON, to local callers only.
//
// Every case runs on its own free port. POLTERTAB_COMMAND_TIMEOUT_MS is a
// test-only override of the 35 s budget so the deadline cases run in seconds.

const CONFIG = path.join(__dirname, "..", "config.js");

const ofType = (f, type) => f.seen.filter((m) => m.type === type);
const replyTo = (f, id) => f.seen.find((m) => m.id === id && !m.type);
const accepted = (f) => f.seen.some((m) => m.type === "secondary_accepted");

// A Chrome extension on a real Primary that keeps its own books: what arrived,
// in what order, and how many were open at once. `holdFor(m)` says how long to
// sit on a command; by default a command's own `hold` param.
function extensionOn(port, holdFor = (m) => m.hold || 0) {
  const ws = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://test" });
  const st = { ws, seen: [], open: 0, maxOpen: 0 };
  ws.on("open", () => ws.send(JSON.stringify({ type: "extension_ready", version: "test" })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (!m.id || !m.action) return;
    st.seen.push({ at: Date.now(), m });
    st.open++;
    st.maxOpen = Math.max(st.maxOpen, st.open);
    const reply = () => {
      st.open--;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: m.id, success: true, data: { url: "http://t/", title: "T", tabId: 1 } }));
      }
    };
    const hold = holdFor(m);
    hold ? setTimeout(reply, hold) : reply();
  });
  ws.on("error", () => {});
  return st;
}

// The tags the extension saw, in arrival order. Each command carries its own
// in `tag`, because the Primary is free to re-key ids.
const tagsAt = (ext) => ext.seen.map((s) => s.m.tag).filter(Boolean);
const reached = (ext, tag) => ext.seen.find((s) => s.m.tag === tag);

function proxy(f, id, params = {}) {
  f.ws.send(JSON.stringify({ type: "proxy_command", id, action: "get_url", params: { tag: id, ...params } }));
}

// Keep a timestamp per frame a fake Secondary receives, for ordering checks.
function timed(f) {
  f.at = new Map();
  f.ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    f.at.set(`${m.type || "reply"}:${m.id}`, Date.now());
  });
  return f;
}

function getStatus(port, { host = "localhost", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: "/status", headers, timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("timeout", () => req.destroy(new Error("no answer within 2 s")));
    req.on("error", reject);
  });
}

async function primaryWith(env) {
  const port = await freePort();
  const srv = startServer({ port, env });
  await waitFor("primary listening", () => srv.stderr.includes("WebSocket server listening"));
  return { port, srv };
}

async function v2(port, n = 1) {
  const fs = [];
  for (let i = 0; i < n; i++) fs.push(timed(fakeSecondary(port, { version: "test" })));
  await waitFor("v2 accepted", () => fs.every(accepted), 3000);
  return n === 1 ? fs[0] : fs;
}

async function legacyOn(port, srv) {
  const f = timed(fakeSecondary(port));
  await waitFor("legacy registered", () => srv.stderr.includes(`Secondary node connected: ${f.nodeId}`), 3000);
  return f;
}

async function groupU() {
  console.log("\nU. command queue + /status");

  await test("U0 queue limits are env-tunable (concurrency 6, depth 3, GC 60 s); the 35 s budget has a test override", () => {
    const read = (env) => {
      const r = spawnSync(
        process.execPath,
        ["-e", `const c = require(${JSON.stringify(CONFIG)}); console.log(JSON.stringify([c.MAX_EXTENSION_CONCURRENCY, c.PER_SECONDARY_QUEUE_DEPTH, c.QUEUE_TIMEOUT_MS, c.COMMAND_TIMEOUT_MS]))`],
        { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" },
      );
      return JSON.parse(r.stdout.trim());
    };
    assert.deepStrictEqual(read({}), [6, 3, 60000, 35000]);
    assert.deepStrictEqual(
      read({ POLTERTAB_MAX_CONCURRENCY: "2", POLTERTAB_QUEUE_DEPTH: "5", POLTERTAB_QUEUE_TIMEOUT_MS: "9000", POLTERTAB_COMMAND_TIMEOUT_MS: "4000" }),
      [2, 5, 9000, 4000],
    );
    // A cap of 0 would refuse every command forever; junk falls back.
    assert.deepStrictEqual(
      read({ POLTERTAB_MAX_CONCURRENCY: "0", POLTERTAB_QUEUE_DEPTH: "lots", POLTERTAB_QUEUE_TIMEOUT_MS: "-1", POLTERTAB_COMMAND_TIMEOUT_MS: "x" }),
      [6, 3, 60000, 35000],
    );
  });

  // ── Cap, depth, frames, fairness, legacy bypass: one Primary, one slot ──
  {
    const { port, srv } = await primaryWith({ POLTERTAB_MAX_CONCURRENCY: "1", POLTERTAB_QUEUE_DEPTH: "3" });
    const all = [];
    let ext = null;
    try {
      ext = extensionOn(port);
      await waitFor("extension connected", () => srv.stderr.includes("Chrome extension connected"));

      await test("U1 at most MAX_CONCURRENCY commands reach the extension at once; the rest wait and all complete", async () => {
        const a = await v2(port);
        all.push(a);
        ext.maxOpen = 0;
        proxy(a, "u1-a1", { hold: 400 });
        proxy(a, "u1-a2", { hold: 100 });
        proxy(a, "u1-a3", { hold: 100 });
        await waitFor("all answered", () => ["u1-a1", "u1-a2", "u1-a3"].every((id) => replyTo(a, id)), 5000).catch(() => {});
        assert.strictEqual(ext.maxOpen, 1, `${ext.maxOpen} commands at the extension at once with a cap of 1`);
        for (const id of ["u1-a1", "u1-a2", "u1-a3"]) {
          const r = replyTo(a, id);
          assert.ok(r && r.success, `${id}: ${JSON.stringify(r)}`);
        }
      });

      await test("U2 a waiting v2 command gets `queued` then `dispatched` then its reply; neither frame settles it", async () => {
        const a = all[0];
        const q = ofType(a, "queued").filter((m) => m.id.startsWith("u1-"));
        const d = ofType(a, "dispatched").filter((m) => m.id.startsWith("u1-"));
        assert.deepStrictEqual(q.map((m) => m.id).sort(), ["u1-a2", "u1-a3"], `queued frames: ${JSON.stringify(q)}`);
        assert.deepStrictEqual(d.map((m) => m.id).sort(), ["u1-a2", "u1-a3"], `dispatched frames: ${JSON.stringify(d)}`);
        assert.ok(!ofType(a, "queued").some((m) => m.id === "u1-a1"), "the command that got the free slot was announced as queued");
        for (const m of [...q, ...d]) {
          assert.ok(!("success" in m) && !("error" in m) && !("data" in m), `frame looks like a reply: ${JSON.stringify(m)}`);
        }
        for (const m of q) assert.ok(Number.isInteger(m.position) && m.position >= 1, `position ${m.position}`);
        for (const id of ["u1-a2", "u1-a3"]) {
          const tq = a.at.get(`queued:${id}`);
          const td = a.at.get(`dispatched:${id}`);
          const tr = a.at.get(`reply:${id}`);
          assert.ok(tq <= td && td <= tr, `${id} frames out of order: queued ${tq}, dispatched ${td}, reply ${tr}`);
          // `dispatched` goes out before the command does, so it is never
          // after the extension has it.
          assert.ok(td <= reached(ext, id).at + 50, `${id}: dispatched ${td - reached(ext, id).at} ms after the extension got it`);
        }
      });

      await test("U3 a 4th command queued by one Secondary is refused at once with [queue_full action=...]", async () => {
        const holder = await v2(port);
        const b = await v2(port);
        const c = await v2(port);
        all.push(holder, b, c);
        proxy(holder, "u3-hold", { hold: 1200 });
        await waitFor("slot taken", () => reached(ext, "u3-hold"), 2000);
        for (const i of [1, 2, 3, 4]) proxy(b, `u3-b${i}`);
        // Depth is per Secondary: another one's commands still queue.
        proxy(c, "u3-c1");
        await waitFor("b4 answered", () => replyTo(b, "u3-b4"), 1000).catch(() => {});
        const r = replyTo(b, "u3-b4");
        assert.ok(r, "no immediate answer to the 4th queued command");
        assert.strictEqual(r.success, false, JSON.stringify(r));
        assert.ok(/^\[queue_full action=get_url\]/.test(r.error), `error: ${r.error}`);
        assert.ok(!reached(ext, "u3-b4"), "the refused command reached the extension anyway");
        assert.deepStrictEqual(ofType(b, "queued").map((m) => m.id).sort(), ["u3-b1", "u3-b2", "u3-b3"]);
        assert.ok(ofType(c, "queued").some((m) => m.id === "u3-c1"), "another Secondary's command was not queued");
        await waitFor("queue drained", () => ["u3-b1", "u3-b2", "u3-b3"].every((id) => replyTo(b, id)) && replyTo(c, "u3-c1"), 5000);
      });

      await test("U4 (T6) queues are served round-robin across Secondaries, FIFO within each", async () => {
        const [holder, a, b] = [all[1], await v2(port), await v2(port)];
        all.push(a, b);
        proxy(holder, "u4-hold", { hold: 500 });
        await waitFor("slot taken", () => reached(ext, "u4-hold"), 2000);
        for (const i of [1, 2, 3]) proxy(a, `u4-a${i}`, { hold: 30 });
        await sleep(150);
        for (const i of [1, 2, 3]) proxy(b, `u4-b${i}`, { hold: 30 });
        await waitFor("all six answered", () => [1, 2, 3].every((i) => replyTo(a, `u4-a${i}`) && replyTo(b, `u4-b${i}`)), 5000).catch(() => {});
        const order = tagsAt(ext).filter((t) => /^u4-[ab]/.test(t));
        assert.deepStrictEqual(order, ["u4-a1", "u4-b1", "u4-a2", "u4-b2", "u4-a3", "u4-b3"]);
      });

      await test("U5 (T12) a legacy Secondary's command skips the queue: no frames, dispatched at once, counted in flight", async () => {
        const holder = all[1];
        const legacy = await legacyOn(port, srv);
        const late = await v2(port);
        all.push(legacy, late);
        proxy(holder, "u5-hold", { hold: 800 });
        await waitFor("slot taken", () => reached(ext, "u5-hold"), 2000);
        proxy(legacy, "u5-l1", { hold: 400 });
        await waitFor("legacy reached the extension", () => reached(ext, "u5-l1"), 400).catch(() => {});
        assert.ok(reached(ext, "u5-l1"), "the legacy command waited behind a full slot");
        // The legacy command is now in flight too: a v2 command still waits.
        proxy(late, "u5-v1");
        await waitFor("legacy answered", () => replyTo(legacy, "u5-l1"), 2000);
        assert.ok(replyTo(legacy, "u5-l1").success, JSON.stringify(replyTo(legacy, "u5-l1")));
        assert.deepStrictEqual(legacy.seen.filter((m) => m.type === "queued" || m.type === "dispatched"), []);
        assert.ok(ofType(late, "queued").some((m) => m.id === "u5-v1"), "the v2 command did not wait");
        await waitFor("v2 answered", () => replyTo(late, "u5-v1"), 3000);
      });

      await test("U6 (T9a) a queued command whose Secondary disconnects is dropped, never sent to the extension", async () => {
        const holder = all[1];
        const gone = await v2(port);
        proxy(holder, "u6-hold", { hold: 600 });
        await waitFor("slot taken", () => reached(ext, "u6-hold"), 2000);
        proxy(gone, "u6-g1");
        await waitFor("queued", () => ofType(gone, "queued").length, 1000);
        gone.ws.terminate();
        await waitFor("holder answered", () => replyTo(holder, "u6-hold"), 3000);
        await sleep(400);
        assert.ok(!reached(ext, "u6-g1"), "a command whose caller had gone was executed");
      });
    } finally {
      for (const f of all) f.ws.terminate();
      if (ext) ext.ws.terminate();
      await stop(srv);
    }
  }

  // ── The Primary's own commands share the slot and the queue (T11, S2) ──
  {
    const { port, srv } = await primaryWith({ POLTERTAB_MAX_CONCURRENCY: "1" });
    const all = [];
    let ext = null;
    try {
      // The Primary's own get_title is held; every Secondary command is tagged.
      ext = extensionOn(port, (m) => (m.action === "get_title" ? 800 : m.hold || 0));
      await initialize(srv);
      await waitFor("extension connected", () => srv.stderr.includes("Chrome extension connected"));
      const s = await v2(port);
      all.push(s);

      await test("U7 (T11) a Secondary's command waits while the Primary's own command holds the slot", async () => {
        const own = rpc(srv, "tools/call", { name: "browser_get_title", arguments: {} });
        await waitFor("own command at the extension", () => ext.seen.some((x) => x.m.action === "get_title"), 3000);
        proxy(s, "u7-s1");
        await waitFor("secondary answered", () => replyTo(s, "u7-s1"), 4000).catch(() => {});
        await own;
        assert.ok(ofType(s, "queued").some((m) => m.id === "u7-s1"), "no `queued` frame: the Primary's command was not counted");
        const ownDone = ext.seen.find((x) => x.m.action === "get_title").at + 800;
        assert.ok(reached(ext, "u7-s1") && reached(ext, "u7-s1").at >= ownDone - 50,
          "the Secondary's command reached the extension while the Primary's held the only slot");
      });

      await test("U8 (S2) the Primary's own command queues behind a Secondary's and still succeeds", async () => {
        proxy(s, "u8-s1", { hold: 800 });
        await waitFor("slot taken", () => reached(ext, "u8-s1"), 2000);
        const before = ext.seen.length;
        const reply = await rpc(srv, "tools/call", { name: "browser_get_title", arguments: {} });
        const own = ext.seen.slice(before).find((x) => x.m.action === "get_title");
        assert.ok(own, "the Primary's command never reached the extension");
        assert.ok(own.at >= reached(ext, "u8-s1").at + 750, `sent ${own.at - reached(ext, "u8-s1").at} ms into an 800 ms hold`);
        assert.ok(reply.result && !reply.result.isError, JSON.stringify(reply));
      });
    } finally {
      for (const f of all) f.ws.terminate();
      if (ext) ext.ws.terminate();
      await stop(srv);
    }
  }

  // ── Deadlines at dequeue (T9b, T9c): a 4 s budget, so 2 s to be dequeued ──
  {
    const { port, srv } = await primaryWith({ POLTERTAB_MAX_CONCURRENCY: "1", POLTERTAB_COMMAND_TIMEOUT_MS: "4000" });
    const all = [];
    let ext = null;
    try {
      ext = extensionOn(port);
      await waitFor("extension connected", () => srv.stderr.includes("Chrome extension connected"));
      const [holder, s] = await v2(port, 2);
      all.push(holder, s);

      await test("U9 (T9b, R-M2) a command still queued past its caller's deadline is dropped with [queue_timeout action=...]", async () => {
        proxy(holder, "u9-hold", { hold: 3000 });
        await waitFor("slot taken", () => reached(ext, "u9-hold"), 2000);
        proxy(s, "u9-s1");
        await waitFor("queued", () => ofType(s, "queued").some((m) => m.id === "u9-s1"), 1000);
        await waitFor("holder answered", () => replyTo(holder, "u9-hold"), 5000);
        await waitFor("s1 answered", () => replyTo(s, "u9-s1"), 1000).catch(() => {});
        await sleep(300);
        assert.ok(!reached(ext, "u9-s1"), "a command past its deadline was executed (ghost execution)");
        assert.ok(!ofType(s, "dispatched").some((m) => m.id === "u9-s1"), "an expired command was announced as dispatched");
        const r = replyTo(s, "u9-s1");
        assert.ok(r, "the dropped command was never answered");
        assert.strictEqual(r.success, false);
        assert.ok(/^\[queue_timeout action=get_url\]/.test(r.error), `error: ${r.error}`);
      });

      await test("U10 (T9c) a command dequeued inside its deadline is dispatched and succeeds", async () => {
        proxy(holder, "u10-hold", { hold: 1000 });
        await waitFor("slot taken", () => reached(ext, "u10-hold"), 2000);
        proxy(s, "u10-s1", { hold: 300 });
        await waitFor("s1 answered", () => replyTo(s, "u10-s1"), 4000).catch(() => {});
        assert.ok(ofType(s, "dispatched").some((m) => m.id === "u10-s1"), "no `dispatched` frame");
        const r = replyTo(s, "u10-s1");
        assert.ok(r && r.success, JSON.stringify(r));
      });
    } finally {
      for (const f of all) f.ws.terminate();
      if (ext) ext.ws.terminate();
      await stop(srv);
    }
  }

  // ── The Secondary's half: frames re-arm its timer and never settle ──
  {
    const port = await freePort();
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const sent = [];
    wss.on("connection", (ws) => {
      ws.on("error", () => {});
      ws.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.type === "secondary_mcp") {
          ws.send(JSON.stringify({ type: "secondary_accepted", nodeId: m.nodeId, primaryVersion: "test" }));
        } else if (m.type === "proxy_command") {
          // With a 3 s client budget, the reply at 6 s only arrives in time if
          // each frame re-armed the timer: queued at 2 s → 5 s, dispatched at
          // 4 s → 7 s.
          const send = (o) => ws.readyState === WebSocket.OPEN && (ws.send(JSON.stringify(o)), sent.push(o.type || "reply"));
          setTimeout(() => send({ type: "queued", id: m.id, position: 1 }), 2000);
          setTimeout(() => send({ type: "dispatched", id: m.id }), 4000);
          setTimeout(() => send({ id: m.id, success: true, data: { url: "http://queued-primary/", title: "Q", tabId: 3 } }), 6000);
        }
      });
    });
    await new Promise((r) => server.listen(port, r));
    let secondary = null;
    try {
      secondary = startServer({ port, env: { POLTERTAB_COMMAND_TIMEOUT_MS: "3000" } });
      await initialize(secondary);
      await waitFor("secondary connected", () => wss.clients.size === 1, 5000);

      await test("U11 a v2 Secondary re-arms its timer on `queued` and `dispatched`, and settles only on the reply", async () => {
        const t0 = Date.now();
        const reply = await rpc(secondary, "tools/call", { name: "browser_get_url", arguments: {} });
        const text = reply.result ? reply.result.content.map((c) => c.text).join("\n") : JSON.stringify(reply);
        assert.ok(reply.result && !reply.result.isError, `caller saw an error after ${Date.now() - t0} ms: ${text}`);
        assert.ok(/queued-primary/.test(text), text);
        assert.deepStrictEqual(sent, ["queued", "dispatched", "reply"]);
      });
    } finally {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close();
      await stop(secondary);
    }
  }

  // ── /status (T7) ──
  {
    const { port, srv } = await primaryWith({ POLTERTAB_MAX_CONCURRENCY: "2", POLTERTAB_QUEUE_DEPTH: "3" });
    const all = [];
    let ext = null;
    try {
      ext = extensionOn(port);
      await waitFor("extension connected", () => srv.stderr.includes("Chrome extension connected"));
      const legacy = await legacyOn(port, srv);
      const legacyAt = Date.now();
      const s = await v2(port);
      all.push(legacy, s);
      await sleep(600);
      proxy(s, "st-1", { hold: 1500 });
      proxy(s, "st-2", { hold: 1500 });
      proxy(s, "st-3");
      await waitFor("st-3 queued", () => ofType(s, "queued").some((m) => m.id === "st-3"), 1000).catch(() => {});

      let res = null;
      let body = null;
      try {
        res = await getStatus(port, { headers: { Origin: "http://evil.example" } });
        body = JSON.parse(res.body);
      } catch (_) {}

      await test("U12 (T7) GET /status answers 200 JSON: role, pid, version, port", () => {
        assert.ok(res, "no answer from /status");
        assert.strictEqual(res.status, 200, `HTTP ${res.status}`);
        assert.ok(/application\/json/.test(res.headers["content-type"] || ""), `content-type ${res.headers["content-type"]}`);
        assert.ok(body, `not JSON: ${res.body.slice(0, 200)}`);
        assert.strictEqual(body.role, "primary");
        assert.strictEqual(body.pid, srv.proc.pid);
        assert.strictEqual(body.port, port);
        assert.ok(typeof body.version === "string" && body.version, `version ${body.version}`);
      });

      await test("U13 (T7) /status lists each Secondary with nodeId, version, protocol, idle_ms and queued count", () => {
        assert.ok(body && Array.isArray(body.secondaries), "no secondaries array");
        const mine = body.secondaries.find((x) => x.nodeId === s.nodeId);
        const old = body.secondaries.find((x) => x.nodeId === legacy.nodeId);
        assert.ok(mine, "the v2 Secondary is missing");
        assert.ok(old, "the legacy Secondary is missing");
        assert.strictEqual(mine.version, "test");
        assert.strictEqual(mine.protocol, "v2");
        assert.strictEqual(mine.pid, process.pid);
        assert.strictEqual(mine.queued_commands, 1);
        assert.ok(Number.isInteger(mine.idle_ms) && mine.idle_ms < 1000, `v2 idle_ms ${mine.idle_ms} right after a command`);
        assert.strictEqual(old.version, null);
        assert.strictEqual(old.protocol, "legacy");
        const sinceLegacy = Date.now() - legacyAt;
        assert.ok(Number.isInteger(old.idle_ms) && Math.abs(old.idle_ms - sinceLegacy) < 1000,
          `legacy idle_ms ${old.idle_ms}, connected ${sinceLegacy} ms ago`);
      });

      await test("U14 (T7) /status reports in-flight and queued counts against the ceiling, with numeric wait percentiles", () => {
        const q = body && body.queue;
        assert.ok(q, "no queue section");
        assert.strictEqual(q.in_flight, 2);
        assert.strictEqual(q.max_in_flight, 2);
        assert.strictEqual(q.queued, 1);
        assert.strictEqual(q.max_queued_per_secondary, 3);
        const p = q.wait_percentiles_ms || {};
        for (const k of ["p50", "p95", "p99"]) assert.strictEqual(typeof p[k], "number", `${k}: ${p[k]}`);
      });

      await test("U15 /status sends no CORS header, even to a page origin", () => {
        assert.ok(res, "no answer from /status");
        assert.strictEqual(res.headers["access-control-allow-origin"], undefined);
      });

      await test("U16 from a non-loopback address /status is refused and the bridge rejects a foreign origin", async () => {
        const lan = Object.values(os.networkInterfaces()).flat()
          .find((i) => i && i.family === "IPv4" && !i.internal);
        if (!lan) return console.log("          (no non-loopback IPv4 address; skipped)");

        // /status from LAN IP: refused at the application layer (wildcard TCP
        // bind is intentional — it makes legacy servers get EADDRINUSE — but
        // /status data must never leak to pages on the network).
        const statusRes = await getStatus(port, { host: lan.address });
        assert.strictEqual(statusRes.status, 404, `/status from ${lan.address} must be 404`);
        assert.strictEqual(statusRes.body, "", "no body leaked to non-loopback caller");

        // WebSocket upgrade from LAN with a foreign page origin must be rejected
        // (allowOrigin guard), so LAN reachability cannot drive the bridge.
        const rejected = await new Promise((resolve) => {
          const ws = new WebSocket(`ws://${lan.address}:${port}`, {
            headers: { Origin: "http://evil.example.com" },
            handshakeTimeout: 3000,
          });
          ws.once("open", () => { ws.terminate(); resolve(false); });
          ws.once("error", () => resolve(true));
        });
        assert.ok(rejected, "WebSocket with foreign origin from LAN must be rejected");

        // Loopback /status still works.
        const local = await getStatus(port, { host: "127.0.0.1" });
        assert.strictEqual(local.status, 200, "/status from 127.0.0.1 must still be 200");
      });
    } finally {
      for (const f of all) f.ws.terminate();
      if (ext) ext.ws.terminate();
      await stop(srv);
    }
  }

  // ── MUST-1: Primary survives extension disconnect with a queued command ──
  // Failure scenario (Jim's review): commands queued under load → extension's
  // MV3 service worker restarts → extensionSocket = null → in-flight command's
  // 35 s timer fires → extensionInFlight--; _tryDequeue() → dequeues →
  // onDispatch() → _dispatchProxyNow → extensionSocket.send on null →
  // TypeError in a bare setTimeout callback → uncaughtException, Primary dies.
  //
  // To reproduce the crash the queued item must be FRESH at dequeue time so
  // the deadline check (elapsed > COMMAND_TIMEOUT_MS − 2000) does not fire
  // first. We enqueue u17-queued close to the holder's timer-fire point so
  // its elapsed ≈ 900 ms < COMMAND_TIMEOUT_MS − 2000 = 2000 ms.
  {
    const CMD_TIMEOUT = 4000;
    const { port, srv } = await primaryWith({
      POLTERTAB_MAX_CONCURRENCY: "1",
      POLTERTAB_COMMAND_TIMEOUT_MS: String(CMD_TIMEOUT),
    });
    const all = [];
    let ext = null;
    try {
      // Extension holds every command indefinitely; the holder will time out.
      ext = extensionOn(port, () => 60000);
      await waitFor("extension connected", () => srv.stderr.includes("Chrome extension connected"));
      const s = await v2(port);
      all.push(s);

      await test("U17 (MUST-1) Primary survives extension disconnect with a command queued; caller gets not-connected error", async () => {
        // u17-hold fills the one slot; extension holds it until the 4 s timer.
        proxy(s, "u17-hold");
        await waitFor("slot taken", () => ext.seen.length > 0, 2000);
        // Wait until 900 ms before the holder times out, then enqueue a fresh
        // command. At timer fire its elapsed ≈ 900 ms < 4000 − 2000 = 2000 ms,
        // so the deadline check in _tryDequeue does not fire and the code path
        // reaches the extension-not-connected guard (the MUST-1 crash site).
        await sleep(CMD_TIMEOUT - 900);
        proxy(s, "u17-queued");
        await waitFor("queued ack", () => ofType(s, "queued").some((m) => m.id === "u17-queued"), 400);
        // Kill the extension socket → extensionSocket = null in the bridge.
        ext.ws.terminate();
        ext = null;
        // Give the holder's timer time to fire and attempt the dequeue.
        await waitFor("u17-queued answered", () => replyTo(s, "u17-queued"), 2000).catch(() => {});
        // Primary must still be reachable — if it crashed this throws.
        let alive = false;
        try {
          const r = await getStatus(port);
          alive = r.status === 200;
        } catch (_) {}
        assert.ok(alive, "Primary process crashed after extension disconnect with a non-empty queue");
        const r = replyTo(s, "u17-queued");
        assert.ok(r, "queued command was never answered (Primary may have crashed)");
        assert.strictEqual(r.success, false, JSON.stringify(r));
        assert.ok(
          /Browser extension not connected/.test(r.error),
          `expected not-connected error, got: ${r.error}`,
        );
      });
    } finally {
      for (const f of all) f.ws.terminate();
      if (ext) ext.ws.terminate();
      await stop(srv);
    }
  }

  // U18: Primary must be reachable via ::1 (IPv6 loopback) so that Node 18
  // clients work. Node 18 resolves 'localhost' to ::1 first (no happy-eyeballs
  // fallback). Failing before fix: the Primary only listens on 127.0.0.1, so
  // the connection is refused and an unhandled 'error' event crashes the run.
  {
    const { port, srv } = await primaryWith({});
    try {
      await test("U18 Primary is reachable via ::1 (Node 18 localhost resolves to ::1)", async () => {
        const connected = await new Promise((resolve) => {
          const ws = new WebSocket(`ws://[::1]:${port}`, { handshakeTimeout: 2000 });
          ws.once("open", () => { ws.terminate(); resolve(true); });
          // Handled: refused connect must fail the test, not crash the run.
          ws.once("error", () => resolve(false));
        });
        assert.ok(connected, "Primary refused ::1 connection — Node 18 clients dialling localhost would get ECONNREFUSED");
      });
    } finally {
      await stop(srv);
    }
  }
}

module.exports = groupU;
