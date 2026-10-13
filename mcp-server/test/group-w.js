const http = require("http");
const net = require("net");
const {
  WebSocket,
  assert,
  fs,
  path,
  vm,
  EXT,
  REPO,
  initialize,
  rpc,
  sleep,
  startServer,
  test,
  waitFor,
} = require("./harness.js");
const { freePort, fakeSecondary, stop } = require("./group-s.js");
const { fakePrimary, errText } = require("./group-t.js");

// Extension reconnect + version handshake (DAG-23 PR-4, design §3.6, §7.4,
// §7.6; T10), plus the follow-ups carried from the legacy-bind review.
//
// The extension. When the Primary goes away the extension used to arm a
// chrome.alarms poll and wait — and Chrome clamps alarms to 30 s, so every
// command in that gap failed. Now it dials again at once, then backs off 1 s,
// 2 s, 4 s … capped at 30 s while the worker is awake, with the alarm kept as
// the backstop for a suspended worker. Whatever fires, there is one socket.
//
// The Primary. "Extension not connected" now says which of two things it is:
// the extension was here and is on its way back (reconnecting, with how long
// it has been gone), or it never came (check Chrome). A v2 Secondary on a
// different major version is closed 4002 with a reason; a versionless one is
// still never closed. /status answers only to a loopback Host header, so a
// DNS-rebound page cannot read it.
//
// W0–W5  extension reconnect loop (background.js in a vm, fake socket/timers)
// W6–W8  never-connected vs reconnecting, both the Primary's own and proxied
// W9–W12 version handshake: 4002 for a major mismatch, nothing for the rest
// W13    the Secondary's side of 4002: one clear error, no retry storm
// W14–15 /status Host allowlist (DNS rebinding); bad Origin over ::1

const OWN_MAJOR = Number(require(path.join(REPO, "package.json")).version.split(".")[0]);

// ── The extension under a controllable clock ──
//
// The real background.js and its bg/ modules, in a vm. Sockets start
// CONNECTING and move only when the test says so; timers run only when the
// test fires them; alarms remember what is armed and fire on demand.
function extensionWorker() {
  const sockets = [];
  const timers = [];
  const alarms = new Map();
  const alarmListeners = [];

  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = 2;
    }
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, delay = 0) => {
      const t = { fn, delay, live: true };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.live = false;
    },
    setInterval: () => ({}),
    clearInterval() {},
    JSON,
    Date,
    Math,
    Promise,
    Error,
    Object,
    WebSocket: FakeSocket,
    chrome: {
      runtime: {
        getManifest: () => ({ version: "test" }),
        sendMessage: () => Promise.resolve(),
        onMessage: { addListener() {} },
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} },
      },
      alarms: {
        get: (name, cb) => cb && cb(alarms.get(name) || null),
        create: (name, info) => alarms.set(name, { name, ...info }),
        clear: (name, cb) => {
          alarms.delete(name);
          if (cb) cb(true);
        },
        onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
      },
      storage: {
        local: {
          get: (keys, cb) => (cb ? cb({}) : Promise.resolve({})),
          set: (_o, cb) => (cb ? cb() : Promise.resolve()),
        },
        session: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener() {} },
      },
      tabs: {
        get: async (id) => ({ id, url: "http://t/", title: "T", status: "complete" }),
        query: async () => [],
        onRemoved: { addListener() {} },
        onUpdated: { addListener() {} },
      },
      tabGroups: { get: async () => ({ id: 1 }), query: async () => [], update: async () => {} },
      webNavigation: { onCompleted: { addListener() {}, removeListener() {} } },
      scripting: { executeScript: async () => [] },
    },
  };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(EXT, file), "utf8"), sandbox);
    }
  };
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), sandbox);

  const live = () => timers.filter((t) => t.live);
  const w = {
    sockets,
    alarms,
    last: () => sockets[sockets.length - 1],
    open(s = w.last()) {
      s.readyState = 1;
      s.onopen && s.onopen();
    },
    // A socket that dies, whether it ever opened or not.
    drop(s = w.last()) {
      s.readyState = 3;
      s.onclose && s.onclose({ code: 1006, reason: "" });
    },
    pending: live,
    // Run every live timer due within `upTo` ms, as though that much time
    // passed. Timers armed meanwhile wait for the next call.
    advance(upTo) {
      for (const t of live()) {
        if (t.delay <= upTo) {
          t.live = false;
          t.fn();
        }
      }
    },
    fireAlarm(name) {
      for (const fn of alarmListeners) fn({ name });
    },
    reconnectAlarmArmed: () => [...alarms.keys()].some((n) => /reconnect/i.test(n)),
  };
  return w;
}

function getStatus(port, { host = "127.0.0.1", hostHeader } = {}) {
  return new Promise((resolve) => {
    const headers = hostHeader === undefined ? {} : { Host: hostHeader };
    const req = http.get({ host, port, path: "/status", headers, timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("no answer within 2 s")));
    req.on("error", (e) => resolve({ status: null, body: e.message }));
  });
}

// HTTP/1.0 with no Host header at all, which http.get cannot send.
function getStatusNoHost(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write("GET /status HTTP/1.0\r\n\r\n"));
    let raw = "";
    sock.on("data", (d) => (raw += d));
    sock.on("end", () => {
      const m = raw.match(/^HTTP\/1\.\d (\d{3})/);
      resolve({ status: m ? Number(m[1]) : null, body: raw.split("\r\n\r\n").slice(1).join("") });
    });
    sock.on("error", (e) => resolve({ status: null, body: e.message }));
    sock.setTimeout(2000, () => sock.destroy());
  });
}

function extensionOn(port) {
  const ws = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://test" });
  ws.on("open", () => ws.send(JSON.stringify({ type: "extension_ready", version: "test" })));
  ws.on("error", () => {});
  return ws;
}

const accepted = (f) => f.seen.some((m) => m.type === "secondary_accepted");

function proxyAndWait(f, id) {
  f.ws.send(JSON.stringify({ type: "proxy_command", id, action: "get_url", params: {} }));
  return waitFor(`reply to ${id}`, () => f.seen.find((m) => m.id === id && !m.type), 3000).then(() =>
    f.seen.find((m) => m.id === id && !m.type),
  );
}

async function primaryOn(env) {
  const port = await freePort();
  const srv = startServer({ port, env });
  await waitFor("primary listening", () => srv.stderr.includes("WebSocket server listening"));
  return { port, srv };
}

async function groupW() {
  console.log("\nW. extension reconnect + version handshake");

  // ── W0–W5: the extension's reconnect loop ──

  await test("W0 a dropped connection is redialled at once, before any timer runs", () => {
    const w = extensionWorker();
    w.open();
    const before = w.sockets.length;
    w.drop();
    assert.strictEqual(w.sockets.length, before + 1, "no new socket straight after onclose");
  });

  await test("W1 consecutive failures back off 1 s, 2 s, 4 s … capped at 30 s, one timer at a time", () => {
    const w = extensionWorker();
    w.open();
    w.drop(); // immediate redial
    const delays = [];
    for (let i = 0; i < 7; i++) {
      w.drop(); // that dial fails without opening
      const p = w.pending();
      assert.strictEqual(p.length, 1, `after failure ${i + 1}: ${p.length} retry timers pending`);
      delays.push(p[0].delay);
      const n = w.sockets.length;
      w.advance(p[0].delay);
      assert.strictEqual(w.sockets.length, n + 1, `retry ${i + 1} did not dial`);
    }
    assert.deepStrictEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  await test("W2 a successful connection resets the back-off", () => {
    const w = extensionWorker();
    w.open();
    w.drop();
    w.drop();
    w.advance(1000);
    w.drop();
    w.advance(2000);
    w.open(); // back
    assert.strictEqual(w.pending().length, 0, "a retry timer survived the connection");
    const before = w.sockets.length;
    w.drop();
    assert.strictEqual(w.sockets.length, before + 1, "second outage was not redialled at once");
    w.drop();
    assert.deepStrictEqual(w.pending().map((t) => t.delay), [1000]);
  });

  await test("W3 the reconnect alarm stays armed as the backstop for a suspended worker", () => {
    const w = extensionWorker();
    w.open();
    assert.ok(!w.reconnectAlarmArmed(), "reconnect alarm armed while connected");
    w.drop();
    assert.ok(w.reconnectAlarmArmed(), "no reconnect alarm after the connection dropped");
    w.open();
    assert.ok(!w.reconnectAlarmArmed(), "reconnect alarm left armed after reconnecting");
  });

  await test("W4 alarm and retry timer racing open one socket, and the timer dies with the connection", () => {
    const w = extensionWorker();
    w.open();
    w.drop();
    w.drop(); // retry timer (1 s) now pending
    const before = w.sockets.length;
    w.fireAlarm("poltertab-reconnect"); // the alarm gets there first
    assert.strictEqual(w.sockets.length, before + 1, "alarm did not dial");
    w.advance(1000); // the timer fires while that dial is still CONNECTING
    assert.strictEqual(w.sockets.length, before + 1, "timer opened a second socket");
    w.open();
    w.advance(60000);
    w.fireAlarm("poltertab-reconnect");
    assert.strictEqual(w.sockets.length, before + 1, "a socket was opened beside a live connection");
  });

  await test("W5 a superseded socket's late close cannot orphan the live one", () => {
    const w = extensionWorker();
    w.open();
    const a = w.last();
    a.readyState = 2; // CLOSING: connect() may already replace it
    w.fireAlarm("poltertab-reconnect");
    const b = w.last();
    assert.notStrictEqual(a, b, "connect() did not replace a CLOSING socket");
    w.open(b);
    const before = w.sockets.length;
    w.drop(a); // a's close arrives after b is up
    w.advance(60000);
    w.fireAlarm("poltertab-reconnect");
    assert.strictEqual(w.sockets.length, before, "the stale close made the extension dial beside a live socket");
    b.onmessage({ data: JSON.stringify({ id: "w5", action: "unknown_action_w5" }) });
    return sleep(50).then(() =>
      assert.ok(b.sent.some((m) => m.id === "w5"), "the live socket no longer carries replies"),
    );
  });

  // ── W6–W8: why the extension is missing ──
  {
    const { port, srv } = await primaryOn();
    try {
      await initialize(srv);
      await test("W6 a Primary the extension never reached says extension_never_connected", async () => {
        const text = errText(await rpc(srv, "tools/call", { name: "browser_get_url", arguments: {} }));
        assert.ok(text.includes(`[extension_never_connected port=${port}]`), text);
      });

      const v2 = fakeSecondary(port, { version: "test" });
      await waitFor("v2 accepted", () => accepted(v2), 3000);
      await test("W7a a proxied command before the extension ever came says extension_never_connected", async () => {
        const r = await proxyAndWait(v2, "w7a");
        assert.strictEqual(r.success, false);
        assert.ok(r.error.includes(`[extension_never_connected port=${port}]`), r.error);
      });

      const ext = extensionOn(port);
      await waitFor("extension connected", () => srv.stderr.includes("Chrome extension connected"));
      ext.terminate();
      await waitFor("extension gone", () => srv.stderr.includes("Chrome extension disconnected"));

      await test("W7b a proxied command after the extension left says extension_reconnecting with elapsed", async () => {
        const r = await proxyAndWait(v2, "w7b");
        assert.strictEqual(r.success, false);
        assert.ok(new RegExp(`\\[extension_reconnecting port=${port} elapsed=\\d+s\\]`).test(r.error), r.error);
      });

      await test("W8 the Primary's own command after the extension left says extension_reconnecting", async () => {
        const text = errText(await rpc(srv, "tools/call", { name: "browser_get_url", arguments: {} }));
        const m = text.match(new RegExp(`\\[extension_reconnecting port=${port} elapsed=(\\d+)s\\]`));
        assert.ok(m, text);
        // It waited for the extension (5 s) before giving up, so elapsed counts that too.
        assert.ok(Number(m[1]) >= 4, `elapsed=${m[1]}s`);
      });
      v2.ws.terminate();
    } finally {
      await stop(srv);
    }
  }

  // ── W9–W12: version handshake on a real Primary ──
  {
    const { port, srv } = await primaryOn();
    const fakes = [];
    try {
      const other = `${OWN_MAJOR + 1}.0.0`;
      const newer = fakeSecondary(port, { version: other });
      fakes.push(newer);
      await waitFor("closed", () => newer.closed, 3000).catch(() => {});
      await test("W9 a v2 Secondary on another major version is closed 4002 with a reason", () => {
        assert.strictEqual(newer.code, 4002, `closed with ${newer.code}`);
        const info = JSON.parse(newer.reason);
        assert.strictEqual(info.reason, "version_incompatible");
        assert.strictEqual(info.required, `${OWN_MAJOR}.x`);
        assert.strictEqual(info.got, other);
        assert.ok(Buffer.byteLength(newer.reason) <= 123, "close reason over the RFC 6455 limit");
        assert.ok(!newer.seen.some((m) => m.type === "secondary_accepted"), "accepted before being closed");
      });

      const older = fakeSecondary(port, { version: `${Math.max(0, OWN_MAJOR - 1)}.9.9` });
      fakes.push(older);
      if (OWN_MAJOR > 0) {
        await waitFor("closed", () => older.closed, 3000).catch(() => {});
        await test("W10 an older major is closed 4002 too", () => {
          assert.strictEqual(older.code, 4002, `closed with ${older.code}`);
        });
      }

      const minor = fakeSecondary(port, { version: `${OWN_MAJOR}.99.0` });
      const label = fakeSecondary(port, { version: "test" });
      fakes.push(minor, label);
      await waitFor("accepted", () => accepted(minor) && accepted(label), 3000).catch(() => {});
      await test("W11 same major (any minor) and a non-semver version are accepted", () => {
        assert.ok(accepted(minor), `same-major closed ${minor.code}`);
        assert.ok(accepted(label), `non-semver closed ${label.code}`);
      });

      const legacy = fakeSecondary(port);
      fakes.push(legacy);
      await waitFor("legacy registered", () => srv.stderr.includes(`Secondary node connected: ${legacy.nodeId}`), 3000);
      await sleep(500);
      await test("W12 a versionless Secondary is still never closed", () => {
        assert.ok(!legacy.closed, `legacy closed with ${legacy.code}`);
      });
    } finally {
      for (const f of fakes) f.ws.terminate();
      await stop(srv);
    }
  }

  // ── W13: the Secondary's side of 4002 ──
  {
    const port = await freePort();
    const primary = fakePrimary(port);
    primary.onHandshake = (c) =>
      c.ws.close(4002, JSON.stringify({ reason: "version_incompatible", required: "9.x", got: c.version }));
    await primary.listen();
    const node = startServer({ port });
    try {
      await waitFor("first dial", () => primary.conns.length >= 1, 10000);
      await initialize(node);
      const reply = await rpc(node, "tools/call", { name: "browser_get_url", arguments: {} });
      await sleep(3500); // past the first back-off step (2 s ± 25%)
      await test("W13 a Secondary closed 4002 says version_incompatible and does not redial or promote", () => {
        const text = errText(reply);
        assert.ok(text.includes("[version_incompatible"), text);
        assert.ok(text.includes("9.x"), `no required version in: ${text}`);
        assert.strictEqual(primary.conns.length, 1, `dialled the Primary ${primary.conns.length} times`);
        assert.ok(!node.stderr.includes("Attempting to become Primary"), "tried to promote");
      });
    } finally {
      await stop(node);
      await primary.close();
    }
  }

  // ── W14–W15: /status Host allowlist, Origin over ::1 ──
  {
    const { port, srv } = await primaryOn();
    try {
      await test("W14a /status answers a loopback Host, with or without the port", async () => {
        for (const h of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, "localhost", "127.0.0.1", "[::1]", `LOCALHOST:${port}`]) {
          const r = await getStatus(port, { hostHeader: h });
          assert.strictEqual(r.status, 200, `Host ${h} got ${r.status}`);
        }
      });
      await test("W14b /status refuses any other Host with an empty 404 (DNS rebinding)", async () => {
        for (const h of [`evil.example:${port}`, "evil.example", `localhost.evil.example:${port}`, `127.0.0.1.nip.io:${port}`, `localhost:${port}@evil.example`]) {
          const r = await getStatus(port, { hostHeader: h });
          assert.strictEqual(r.status, 404, `Host ${h} got ${r.status}`);
          assert.strictEqual(r.body, "", `Host ${h} got a body`);
        }
        const r = await getStatusNoHost(port);
        assert.strictEqual(r.status, 404, `no Host got ${r.status}`);
        assert.strictEqual(r.body, "", "no Host got a body");
      });
      await test("W15 a WebSocket upgrade with a page Origin over ::1 is refused", async () => {
        const out = await new Promise((resolve) => {
          const ws = new WebSocket(`ws://[::1]:${port}`, { origin: "https://evil.example", handshakeTimeout: 2000 });
          ws.on("open", () => {
            ws.terminate();
            resolve({ accepted: true });
          });
          ws.on("unexpected-response", (_q, res) => resolve({ accepted: false, status: res.statusCode }));
          ws.on("error", (e) => resolve({ accepted: false, error: e.message }));
        });
        assert.strictEqual(out.accepted, false, "page-origin handshake over ::1 was accepted");
        assert.strictEqual(out.status, 403, JSON.stringify(out));
      });
    } finally {
      await stop(srv);
    }
  }
}

module.exports = groupW;
