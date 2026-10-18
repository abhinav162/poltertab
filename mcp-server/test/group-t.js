const http = require("http");
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
const { freePort, fakeSecondary, stamped, stop } = require("./group-s.js");

// Idle eviction with lazy reconnect (DAG-23 PR-2, design §3.3, T2).
//
// A Secondary that sends no command for POLTERTAB_IDLE_EVICTION_MS is closed by
// the Primary with 4001, freeing its slot. It must not read that close as
// "Primary died" (no promotion) or as a refusal (no timed retry): it stays
// down until its agent's next tool call, which dials, waits for
// secondary_accepted and then sends — with no error the caller can see. Every
// case runs on its own free port with an 800 ms idle timeout.

const IDLE_MS = 800;
const EVICT_WITHIN_MS = IDLE_MS + 3000;

const count = (s, needle) => s.split(needle).length - 1;
const nodeIdsIn = (s) => [...s.matchAll(/Node (\S+) running as Secondary/g)].map((m) => m[1]);
const accepted = (f) => f.seen.some((m) => m.type === "secondary_accepted");

// A Chrome extension on a real Primary. A command carrying `hold` is answered
// that many ms late, to keep it in flight.
function extensionOn(port) {
  const ws = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://test" });
  const st = { ws, seen: [] };
  ws.on("open", () => ws.send(JSON.stringify({ type: "extension_ready", version: "test" })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (!m.id || !m.action) return;
    st.seen.push(m);
    const reply = () =>
      ws.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ id: m.id, success: true, data: { url: "http://t/", title: "T", tabId: 1 } }));
    m.hold ? setTimeout(reply, m.hold) : reply();
  });
  ws.on("error", () => {});
  return st;
}

function proxy(f, id, params = {}) {
  f.ws.send(JSON.stringify({ type: "proxy_command", id, action: "get_url", params }));
}

// A Primary whose behaviour each case scripts: when to ACK, and whether to
// answer a command or evict on it. It counts raw TCP connections too, so a
// port probe shows up even though it never becomes a WebSocket.
function fakePrimary(port) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const st = { server, wss, tcp: 0, conns: [], ackDelay: 0, onCommand: null, onHandshake: null };
  server.on("connection", () => st.tcp++);
  st.reply = (c, m) =>
    c.ws.send(JSON.stringify({ id: m.id, success: true, data: { url: "http://fake-primary/", title: "F", tabId: 7 } }));
  st.evict = (c) => c.ws.close(4001, JSON.stringify({ reason: "idle_evicted", idle_ms: 900 }));
  wss.on("connection", (ws) => {
    const c = { ws, at: Date.now(), nodeId: null, version: null, ackAt: null, commands: [], closed: false };
    st.conns.push(c);
    ws.on("close", () => (c.closed = true));
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "secondary_mcp") {
        c.nodeId = m.nodeId;
        c.version = m.version;
        if (st.onHandshake) return st.onHandshake(c, m);
        const ack = () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          c.ackAt = Date.now();
          ws.send(JSON.stringify({ type: "secondary_accepted", nodeId: m.nodeId, primaryVersion: "test" }));
        };
        st.ackDelay ? setTimeout(ack, st.ackDelay) : ack();
      } else if (m.type === "proxy_command") {
        c.commands.push({ at: Date.now(), m });
        (st.onCommand || st.reply)(c, m);
      }
    });
  });
  st.listen = () => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
  st.close = () => new Promise((resolve) => {
    for (const c of wss.clients) c.terminate();
    wss.close();
    server.close(() => resolve());
  });
  return st;
}

function getUrl(srv) {
  return rpc(srv, "tools/call", { name: "browser_get_url", arguments: {} });
}

const errText = (reply) =>
  reply && reply.result ? reply.result.content.map((c) => c.text).join("\n") : JSON.stringify(reply);

async function groupT() {
  console.log("\nT. idle eviction + lazy reconnect");

  await test("T0 POLTERTAB_IDLE_EVICTION_MS takes whole ms > 0; anything else means 5 minutes", () => {
    const { IDLE_EVICTION_MS, resolveIdleEvictionMs: r } = require("../config.js");
    assert.strictEqual(typeof r, "function", "no resolver exported");
    assert.strictEqual(r({}), 300000);
    assert.strictEqual(r({ POLTERTAB_IDLE_EVICTION_MS: "500" }), 500);
    // 0 would evict every Secondary on the next tick: not a setting anyone means.
    for (const junk of ["0", "-1", "lots", "2.5", ""]) {
      assert.strictEqual(r({ POLTERTAB_IDLE_EVICTION_MS: junk }), 300000, `"${junk}"`);
    }
    if (!process.env.POLTERTAB_IDLE_EVICTION_MS) assert.strictEqual(IDLE_EVICTION_MS, 300000);
  });

  // ── The Primary's half: who is evicted, when, and what it frees ──
  {
    const port = await freePort();
    const primary = startServer({
      port,
      env: { POLTERTAB_IDLE_EVICTION_MS: String(IDLE_MS), POLTERTAB_MAX_SECONDARIES: "1" },
    });
    const all = [];
    let ext = null;
    try {
      await waitFor("primary listening", () => primary.stderr.includes("WebSocket server listening"));
      ext = extensionOn(port);
      await waitFor("extension connected", () => primary.stderr.includes("Chrome extension connected"));

      const idle = fakeSecondary(port, { version: "test" });
      const legacy = fakeSecondary(port);
      all.push(idle, legacy);
      await waitFor("idle accepted", () => accepted(idle), 3000);
      const t0 = Date.now();
      await waitFor("idle evicted", () => idle.closed, EVICT_WITHIN_MS).catch(() => {});
      // idle.closed is set by the client-side WebSocket close event. The Primary
      // writes its log line on the server side and may lag the close event by
      // several ms under load. Wait for it before asserting.
      if (idle.closed) {
        await waitFor("primary logs disconnect", () => primary.stderr.includes(`Secondary node disconnected: ${idle.nodeId}`), 3000).catch(() => {});
      }

      await test("T1 (T2) an idle v2 Secondary is closed with 4001 and a JSON reason", () => {
        assert.ok(idle.closed, `still open ${Date.now() - t0} ms after its last activity`);
        assert.strictEqual(idle.code, 4001, `closed with ${idle.code}, reason ${JSON.stringify(idle.reason)}`);
        assert.ok(Buffer.byteLength(idle.reason) <= 123, "close reason exceeds RFC 6455's 123 bytes");
        const reason = JSON.parse(idle.reason);
        assert.strictEqual(reason.reason, "idle_evicted");
        assert.ok(reason.idle_ms >= IDLE_MS, `idle_ms ${reason.idle_ms} is under the ${IDLE_MS} ms timeout`);
        assert.ok(primary.stderr.includes(`Secondary node disconnected: ${idle.nodeId}`), "the Primary still lists it");
      });

      await test("T2 the evicted Secondary's slot is free again", async () => {
        // The ceiling is 1, so this is refused with 4000 if the slot was kept.
        const next = fakeSecondary(port, { version: "test" });
        all.push(next);
        await waitFor("next settled", () => accepted(next) || next.closed, 3000).catch(() => {});
        assert.ok(accepted(next), `refused: ${next.code} ${next.reason}`);
        next.ws.terminate();
        await waitFor("next gone", () => primary.stderr.includes(`Secondary node disconnected: ${next.nodeId}`), 3000);
      });

      await test("T3 (T8) a legacy Secondary is never evicted", async () => {
        // Its only answer to a close is to try to promote: the loop PR-1 removed.
        await sleep(Math.max(0, t0 + 3 * IDLE_MS - Date.now()));
        assert.ok(legacy.open && !legacy.closed, `closed with ${legacy.code} ${legacy.reason}`);
      });

      // T4 and T5 each need the one slot, whether or not eviction freed it.
      const freeSlot = async () => {
        for (const f of all.filter((f) => f !== legacy && !f.closed)) {
          f.ws.terminate();
          await waitFor("slot freed", () => primary.stderr.includes(`Secondary node disconnected: ${f.nodeId}`), 3000).catch(() => {});
        }
      };
      await freeSlot();

      await test("T4 commands keep a Secondary connected; silence after them evicts it", async () => {
        const busy = fakeSecondary(port, { version: "test" });
        all.push(busy);
        await waitFor("busy accepted", () => accepted(busy), 3000);
        const until = Date.now() + 3 * IDLE_MS;
        for (let i = 0; Date.now() < until; i++) {
          proxy(busy, `busy-${i}`);
          await sleep(IDLE_MS / 3);
        }
        assert.ok(!busy.closed, `evicted while active: ${busy.code} ${busy.reason}`);
        await waitFor("busy evicted", () => busy.closed, EVICT_WITHIN_MS).catch(() => {});
        assert.strictEqual(busy.code, 4001, `not evicted once silent (closed: ${busy.closed}, code ${busy.code})`);
      });

      await freeSlot();

      await test("T5 (R-S2) a command in flight blocks eviction until it is answered", async () => {
        const slow = fakeSecondary(port, { version: "test" });
        all.push(slow);
        await waitFor("slow accepted", () => accepted(slow), 3000);
        proxy(slow, "slow-1", { hold: 3 * IDLE_MS + 500 });
        await waitFor("slow answered", () => slow.seen.some((m) => m.id === "slow-1"), 3 * IDLE_MS + 3000).catch(() => {});
        // Evicted first, the socket is gone and the answer never arrives.
        const answer = slow.seen.find((m) => m.id === "slow-1");
        assert.ok(answer && answer.success, `evicted mid-command: closed ${slow.closed}, code ${slow.code} ${slow.reason}`);
        await waitFor("slow evicted", () => slow.closed, EVICT_WITHIN_MS).catch(() => {});
        assert.strictEqual(slow.code, 4001, `not evicted after the reply (closed: ${slow.closed}, code ${slow.code})`);
      });
    } finally {
      for (const f of all) f.ws.terminate();
      if (ext) ext.ws.terminate();
      await stop(primary);
    }
  }

  // ── The Secondary's half, against a scripted Primary ──
  {
    const port = await freePort();
    const fake = fakePrimary(port);
    let secondary = null;
    try {
      await fake.listen();
      fake.onCommand = null;
      secondary = startServer({ port });
      const lines = stamped(secondary);
      await initialize(secondary);
      await waitFor("secondary accepted", () => fake.conns[0] && fake.conns[0].ackAt, 5000);
      const nodeId = fake.conns[0].nodeId;
      const tcpBefore = fake.tcp;
      fake.evict(fake.conns[0]);
      const evictedAt = Date.now();
      // PR-1's backoff at attempt 0 is at most 2.5 s; give it twice that.
      await sleep(5000);

      await test("T6 eviction never triggers a reconnect, a probe or a promotion", () => {
        assert.strictEqual(fake.conns.length, 1, `reconnected ${fake.conns.length - 1} times on its own`);
        assert.strictEqual(fake.tcp, tcpBefore, `${fake.tcp - tcpBefore} TCP connections after the eviction`);
        const after = lines.filter((l) => l.t >= evictedAt).map((l) => l.line).join("\n");
        assert.ok(!/become Primary|WebSocket server listening|Retrying/.test(after), `after eviction:\n${after}`);
      });

      await test("T7 (T2) the next tool call reconnects under the same nodeId, waits for the ACK, and succeeds", async () => {
        fake.ackDelay = 300;
        const t0 = Date.now();
        const reply = await getUrl(secondary);
        const c = fake.conns[1];
        assert.ok(!reply.result || !reply.result.isError, `caller saw an error: ${errText(reply)}`);
        assert.ok(/fake-primary/.test(errText(reply)), `unexpected result: ${errText(reply)}`);
        assert.ok(c, "no second connection");
        assert.ok(c.at >= t0, `reconnected ${t0 - c.at} ms before the tool call`);
        assert.strictEqual(c.nodeId, nodeId, "a new nodeId on reconnect");
        assert.ok(c.version, "the reconnect did not declare a version");
        assert.strictEqual(c.commands.length, 1, `${c.commands.length} commands on the new connection`);
        assert.ok(c.commands[0].at >= c.ackAt, "the command was sent before secondary_accepted");
        assert.deepStrictEqual([...new Set(nodeIdsIn(secondary.stderr))], [nodeId], "the Secondary minted a new nodeId");
      });

      await test("T8 (R-S3) two tool calls after an eviction share one reconnect, promptly", async () => {
        fake.ackDelay = 0;
        fake.evict(fake.conns[1]);
        await waitFor("conn 2 closed", () => fake.conns[1].closed, 2000);
        await sleep(300);
        const before = fake.conns.length;
        const t0 = Date.now();
        const [a, b] = await Promise.all([getUrl(secondary), getUrl(secondary)]);
        const took = Date.now() - t0;
        assert.ok(!a.result.isError && !b.result.isError, `errors: ${errText(a)} / ${errText(b)}`);
        assert.strictEqual(fake.conns.length - before, 1, `${fake.conns.length - before} new connections`);
        assert.ok(took < 1000, `took ${took} ms; a lazy reconnect is one local handshake`);
      });

      await test("T9 (R-S2) a command cut off by 4001 fails as evicted_mid_command and is not retried", async () => {
        fake.onCommand = (c) => fake.evict(c);
        const sentSoFar = () => fake.conns.reduce((n, c) => n + c.commands.length, 0);
        const before = sentSoFar();
        const t0 = Date.now();
        const reply = await getUrl(secondary);
        const took = Date.now() - t0;
        const tcp = fake.tcp;
        assert.ok(reply.result && reply.result.isError, `not an error: ${errText(reply)}`);
        assert.ok(/\[evicted_mid_command action=get_url\]/.test(errText(reply)), errText(reply));
        assert.ok(/not auto-retried/i.test(errText(reply)), errText(reply));
        assert.ok(took < 2000, `took ${took} ms`);
        await sleep(3000);
        const sent = sentSoFar() - before;
        assert.strictEqual(sent, 1, `the command was sent ${sent} times`);
        assert.strictEqual(fake.tcp, tcp, `${fake.tcp - tcp} connections after the eviction`);
      });

      // T9 leaves the node evicted. One reconnect must end the evicted state:
      // a node that re-dials on every call replaces its own live socket each
      // time and strands the reply to the call before.
      await test("T12 calls after a reconnect reuse it; one eviction costs one connection", async () => {
        fake.onCommand = null;
        const before = fake.conns.length;
        for (let i = 0; i < 3; i++) {
          const reply = await getUrl(secondary);
          assert.ok(!reply.result.isError, `call ${i + 1}: ${errText(reply)}`);
        }
        assert.strictEqual(fake.conns.length - before, 1, `${fake.conns.length - before} new connections for 3 calls`);
        assert.ok(!fake.conns[fake.conns.length - 1].closed, "the reconnected socket was closed");
      });
    } finally {
      await stop(secondary);
      await fake.close();
    }
  }

  // ── End to end on a real Primary, then with the Primary gone ──
  {
    const port = await freePort();
    const env = { POLTERTAB_IDLE_EVICTION_MS: String(IDLE_MS) };
    const primary = startServer({ port, env });
    let secondary = null;
    let ext = null;
    try {
      await waitFor("primary listening", () => primary.stderr.includes("WebSocket server listening"));
      ext = extensionOn(port);
      await waitFor("extension connected", () => primary.stderr.includes("Chrome extension connected"));
      secondary = startServer({ port, env });
      const lines = stamped(secondary);
      await initialize(secondary);
      await waitFor("secondary connected", () => primary.stderr.includes("Secondary node connected"));
      const nodeId = nodeIdsIn(secondary.stderr)[0];
      const gone = `Secondary node disconnected: ${nodeId}`;
      await waitFor("evicted", () => primary.stderr.includes(gone), EVICT_WITHIN_MS).catch(() => {});

      await test("T10 (T2) a real Secondary is evicted, then its next tool call succeeds as the same agent", async () => {
        assert.ok(primary.stderr.includes(gone), "never evicted");
        await sleep(1000);
        assert.strictEqual(count(secondary.stderr, "Connected to Primary MCP Server."), 1, "reconnected before any tool call");
        const before = ext.seen.length;
        const reply = await getUrl(secondary);
        assert.ok(!reply.result.isError, `caller saw an error: ${errText(reply)}`);
        const envelope = ext.seen.slice(before).find((m) => m.action === "get_url");
        assert.ok(envelope, "nothing reached the extension");
        assert.strictEqual(envelope._client, nodeId, "the extension saw a different agent");
        assert.ok(!secondary.stderr.includes("WebSocket server listening"), "the Secondary promoted");
      });

      // Evicted again, then the Primary dies while nobody is looking.
      const mark = primary.stderr.length;
      await waitFor("evicted again", () => primary.stderr.slice(mark).includes(gone), EVICT_WITHIN_MS).catch(() => {});
      primary.proc.kill("SIGKILL");
      await sleep(500);

      await test("T11 a tool call with the Primary gone fails as reconnect_failed, then PR-1's backoff promotes once", async () => {
        const t0 = Date.now();
        const reply = await getUrl(secondary);
        assert.ok(reply.result && reply.result.isError, `not an error: ${errText(reply)}`);
        assert.ok(new RegExp(`\\[reconnect_failed port=${port}\\]`).test(errText(reply)), errText(reply));
        await waitFor("promoted", () => secondary.stderr.includes("WebSocket server listening"), 10000).catch(() => {});
        const bound = lines.filter((l) => l.t >= t0 && l.line.includes("WebSocket server listening"));
        assert.strictEqual(bound.length, 1, `bound the port ${bound.length} times`);
        // _backoffDelay(0) is 2 s ±25%: never sooner than 1.5 s after the failed dial.
        assert.ok(bound[0].t - t0 >= 1500, `promoted ${bound[0].t - t0} ms after the failed dial`);
        const dials = lines.filter((l) => l.t >= t0 && l.line.includes("Secondary WebSocket error")).length;
        assert.ok(dials <= 2, `${dials} failed dials before promoting`);
      });
    } finally {
      if (ext) ext.ws.terminate();
      await stop(secondary, primary);
    }
  }
}

module.exports = groupT;
// Group W (extension reconnect + version handshake) scripts its own Primary.
Object.assign(groupT, { fakePrimary, errText });
