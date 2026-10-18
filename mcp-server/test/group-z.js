// Z. Easy pairing — PairHost unit tests + behavioural WS tests
//
//   Z1  PairHost.generateForSocket pushes pair_code with 4-char ALPHABET code
//   Z2  PairHost.generateForSocket voids old code for same socket
//   Z3  PairHost.handleCodeRequest is throttled (30 s / socket)
//   Z4  PairHost.submitCode correct → ok:true, single-use
//   Z5  PairHost.submitCode 5 wrong → locked_out; resets on success
//   Z6  PairHost.submitCode expired code → reason:"expired"
//   Z7  PairHost.onSocketClose voids code and throttle tracking
//   Z8  WS unpaired extension_ready → receives pair_code (4-char ALPHABET)
//   Z9  WS correct code → uploads_pair_result ok:true + extensionId + uploads_paired + config has bare ID
//   Z10 pair_code string never appears in server logs after pairing
//   Z11 pair_code string never appears in config.json after pairing
//   Z12 uploads_pair_submit from chrome-extension origin is silently rejected
//   Z13 MUST 1: ping must NOT regenerate code or stack a new prompt (temp listener, real handler)
//   Z14 MUST 3: expiry timer regenerates code; expired submission is not a wrong guess
//   Z15 MUST 4: positional id unpairs only that id; --id still works
//   Z16 SHOULD 3: temp listener closes on success
//   Z17 SHOULD 3: temp listener closes on Enter-skip
//   Z18 SHOULD 3: temp listener closes on lockout (5 wrong codes)
//   Z19 SHOULD 3: port is free after temp listener resolves
//   Z20 temp listener replies error to non-pairing messages (pairing-mode guard)
//   Z21 write failure re-pushes to the matched extension, not the closure socket

"use strict";

const { REPO, assert, fs, path, test, WebSocket, startServer, waitFor, sleep } = require("./harness.js");
const { freePort, stop } = require("./group-s.js");
const os = require("os");
const crypto = require("crypto");

const PAIR_HOST = path.join(REPO, "mcp-server", "pair-host.js");

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function makeTmpHome() {
  const dir = path.join(os.tmpdir(), "poltertab-z-" + crypto.randomBytes(4).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// Minimal fake ws object sufficient for PairHost unit tests.
function fakeWs(readyState = 1) {
  const sent = [];
  return {
    readyState,
    sent,
    send(data) { sent.push(JSON.parse(data)); },
  };
}

async function groupZ() {
  console.log("\nZ. easy pairing");

  // ── Z1: generateForSocket pushes pair_code with 4-char ALPHABET code ───────
  await test("Z1 generateForSocket pushes pair_code with 4-char ALPHABET code", () => {
    delete require.cache[require.resolve(PAIR_HOST)];
    const { PairHost } = require(PAIR_HOST);
    const ph = new PairHost();
    const ws = fakeWs();

    ph.generateForSocket(ws, "chrome-extension://abc");

    assert.strictEqual(ws.sent.length, 1, "exactly one message sent");
    const msg = ws.sent[0];
    assert.strictEqual(msg.type, "pair_code");
    assert.ok(typeof msg.code === "string" && msg.code.length === 4, `code must be 4 chars, got: ${msg.code}`);
    for (const ch of msg.code) {
      assert.ok(ALPHABET.includes(ch), `char '${ch}' not in ALPHABET`);
    }
  });

  // ── Z2: generateForSocket voids old code for same socket ───────────────────
  await test("Z2 generateForSocket voids old code for same socket", () => {
    delete require.cache[require.resolve(PAIR_HOST)];
    const { PairHost } = require(PAIR_HOST);
    const ph = new PairHost();
    const ws = fakeWs();

    ph.generateForSocket(ws, "chrome-extension://abc");
    const firstCode = ws.sent[0].code;

    ph.generateForSocket(ws, "chrome-extension://abc");
    const secondCode = ws.sent[1].code;

    // Old code is no longer submittable.
    const result = ph.submitCode(firstCode);
    assert.ok(!result.ok, "old code must be voided");
    assert.ok(result.reason === "wrong" || result.reason === "expired", `expected wrong/expired, got: ${result.reason}`);

    // New code IS submittable.
    const result2 = ph.submitCode(secondCode);
    assert.ok(result2.ok, "new code must be valid");
  });

  // ── Z3: handleCodeRequest is throttled (30 s / socket) ─────────────────────
  await test("Z3 handleCodeRequest is throttled within 30s", () => {
    delete require.cache[require.resolve(PAIR_HOST)];
    const { PairHost } = require(PAIR_HOST);
    const ph = new PairHost();
    const ws = fakeWs();

    // First request — generates a code and pushes it.
    ph.handleCodeRequest(ws, "chrome-extension://abc");
    assert.strictEqual(ws.sent.length, 1, "first request should send code");

    // Second request within throttle window — re-sends existing code, no new generate.
    ph.handleCodeRequest(ws, "chrome-extension://abc");
    assert.strictEqual(ws.sent.length, 2, "throttled re-request should re-send code");
    assert.strictEqual(ws.sent[0].code, ws.sent[1].code, "throttled re-request must re-send same code");
  });

  // ── Z4: submitCode correct → ok:true, single-use ───────────────────────────
  await test("Z4 submitCode correct → ok:true and single-use", () => {
    delete require.cache[require.resolve(PAIR_HOST)];
    const { PairHost } = require(PAIR_HOST);
    const ph = new PairHost();
    const ws = fakeWs();

    ph.generateForSocket(ws, "chrome-extension://myext");
    const code = ws.sent[0].code;

    const result = ph.submitCode(code);
    assert.ok(result.ok, "correct code must succeed");
    assert.strictEqual(result.extensionId, "chrome-extension://myext");
    assert.strictEqual(result.extWs, ws);

    // Single-use: same code again must fail.
    const result2 = ph.submitCode(code);
    assert.ok(!result2.ok, "code must be single-use");
  });

  // ── Z5: 5 wrong → locked_out; wrong count resets on success ────────────────
  await test("Z5 five wrong codes trigger lockout; wrong count resets on success", () => {
    delete require.cache[require.resolve(PAIR_HOST)];
    const { PairHost } = require(PAIR_HOST);
    const ph = new PairHost();
    const ws = fakeWs();
    ph.generateForSocket(ws, "chrome-extension://ext");
    const goodCode = ws.sent[0].code;

    // Submit 4 wrong codes — should not lock out yet.
    for (let i = 0; i < 4; i++) {
      const r = ph.submitCode("ZZZZ");
      assert.ok(!r.ok);
      assert.notStrictEqual(r.reason, "locked_out", `should not lock out after ${i + 1} wrongs`);
    }
    // 5th wrong → locked_out.
    const r5 = ph.submitCode("ZZZZ");
    assert.ok(!r5.ok);
    assert.strictEqual(r5.reason, "locked_out");
    assert.ok(typeof r5.secsLeft === "number" && r5.secsLeft > 0);

    // Correct code is also refused while locked out.
    const locked = ph.submitCode(goodCode);
    assert.ok(!locked.ok);
    assert.strictEqual(locked.reason, "locked_out");
  });

  // ── Z6: submitCode on expired code → reason:"expired" ──────────────────────
  await test("Z6 submitCode expired code returns reason expired", () => {
    delete require.cache[require.resolve(PAIR_HOST)];
    const { PairHost } = require(PAIR_HOST);
    const ph = new PairHost();
    const ws = fakeWs();

    ph.generateForSocket(ws, "chrome-extension://ext");
    const code = ws.sent[0].code;

    // Manually backdating the entry's expiresAt simulates TTL expiry.
    const entry = ph._codes.get(code);
    assert.ok(entry, "entry must exist");
    entry.expiresAt = Date.now() - 1; // already expired

    const result = ph.submitCode(code);
    assert.ok(!result.ok);
    assert.strictEqual(result.reason, "expired");
  });

  // ── Z7: onSocketClose voids code and throttle tracking ─────────────────────
  await test("Z7 onSocketClose voids code and clears throttle tracking", () => {
    delete require.cache[require.resolve(PAIR_HOST)];
    const { PairHost } = require(PAIR_HOST);
    const ph = new PairHost();
    const ws = fakeWs();

    ph.generateForSocket(ws, "chrome-extension://ext");
    const code = ws.sent[0].code;

    // Confirm code is active.
    assert.ok(ph._codes.has(code), "code must be in map before close");

    ph.onSocketClose(ws);

    assert.ok(!ph._codes.has(code), "code must be voided on socket close");
    assert.ok(!ph._socketCodes.has(ws), "socket entry must be removed");
    assert.ok(!ph._socketLastRequest.has(ws), "throttle tracking must be cleared");

    // Code is no longer valid.
    const result = ph.submitCode(code);
    assert.ok(!result.ok);
  });

  // ── Z8: WS unpaired extension_ready → receives pair_code ───────────────────
  await test("Z8 WS: unpaired extension receives pair_code on extension_ready", async () => {
    const port = await freePort();
    const home = makeTmpHome();
    // No config.json → server has no paired IDs.
    const srv = startServer({ port, home });
    try {
      await waitFor("bridge up", () => srv.stderr.includes("WebSocket server listening"), 5000);

      const ext = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://unpaired" });
      const extMessages = [];
      await new Promise((res) => ext.on("open", res));
      ext.on("message", (raw) => extMessages.push(JSON.parse(raw)));

      ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));

      // Wait for pair_code push.
      await waitFor("pair_code received", () => extMessages.some((m) => m.type === "pair_code"), 3000);

      const pairMsg = extMessages.find((m) => m.type === "pair_code");
      assert.ok(pairMsg, "must receive pair_code");
      assert.ok(typeof pairMsg.code === "string" && pairMsg.code.length === 4,
        `code must be 4 chars, got: ${JSON.stringify(pairMsg.code)}`);
      for (const ch of pairMsg.code) {
        assert.ok(ALPHABET.includes(ch), `char '${ch}' not in ALPHABET`);
      }
      ext.close();
    } finally {
      await stop(srv);
      cleanup(home);
    }
  });

  // ── Z9: correct code → uploads_pair_result ok:true + uploads_paired + config ─
  await test("Z9 WS: correct code → paired; config has bare ID; extension gets uploads_paired", async () => {
    const port = await freePort();
    const home = makeTmpHome();
    const srv = startServer({ port, home });
    try {
      await waitFor("bridge up", () => srv.stderr.includes("WebSocket server listening"), 5000);

      // Connect extension (unpaired).
      const ext = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://abc123" });
      const extMessages = [];
      await new Promise((res) => ext.on("open", res));
      ext.on("message", (raw) => extMessages.push(JSON.parse(raw)));
      ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));
      await waitFor("pair_code", () => extMessages.some((m) => m.type === "pair_code"), 3000);

      const code = extMessages.find((m) => m.type === "pair_code").code;

      // Connect CLI socket (no origin).
      const cli = new WebSocket(`ws://localhost:${port}`);
      const cliMessages = [];
      await new Promise((res) => cli.on("open", res));
      cli.on("message", (raw) => cliMessages.push(JSON.parse(raw)));

      // Submit the correct code.
      cli.send(JSON.stringify({ type: "uploads_pair_submit", code }));

      await waitFor("uploads_pair_result", () => cliMessages.some((m) => m.type === "uploads_pair_result"), 3000);
      await waitFor("uploads_paired", () => extMessages.some((m) => m.type === "uploads_paired"), 3000);

      const result = cliMessages.find((m) => m.type === "uploads_pair_result");
      assert.ok(result.ok, `pair must succeed, got: ${JSON.stringify(result)}`);
      assert.strictEqual(result.extensionId, "abc123", `result must carry bare extensionId, got: ${JSON.stringify(result)}`);

      // Config must contain the bare extension ID (no chrome-extension:// prefix).
      const cfgPath = path.join(home, "config.json");
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const ids = cfg.trusted_extension_ids || [];
      assert.ok(ids.includes("abc123"), `config must have bare ID "abc123", got: ${JSON.stringify(ids)}`);
      // Bare ID must NOT include the scheme prefix.
      assert.ok(!ids.some((id) => id.includes("chrome-extension://")), "config must store bare ID, not full origin");

      ext.close();
      cli.close();
    } finally {
      await stop(srv);
      cleanup(home);
    }
  });

  // ── Z10: pair_code string never appears in server logs after pairing ────────
  await test("Z10 pair_code string never appears in server logs after pairing", async () => {
    const port = await freePort();
    const home = makeTmpHome();
    const srv = startServer({ port, home });
    try {
      await waitFor("bridge up", () => srv.stderr.includes("WebSocket server listening"), 5000);

      const ext = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://logtest" });
      const extMessages = [];
      await new Promise((res) => ext.on("open", res));
      ext.on("message", (raw) => extMessages.push(JSON.parse(raw)));
      ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));
      await waitFor("pair_code", () => extMessages.some((m) => m.type === "pair_code"), 3000);

      const code = extMessages.find((m) => m.type === "pair_code").code;

      const cli = new WebSocket(`ws://localhost:${port}`);
      const cliMessages = [];
      await new Promise((res) => cli.on("open", res));
      cli.on("message", (raw) => cliMessages.push(JSON.parse(raw)));
      cli.send(JSON.stringify({ type: "uploads_pair_submit", code }));
      await waitFor("paired", () => cliMessages.some((m) => m.type === "uploads_pair_result" && m.ok), 3000);

      // Give server a moment to flush any log lines.
      await sleep(100);

      // The pair code must NOT appear in server stderr (where bridge logs go).
      assert.ok(!srv.stderr.includes(code), `pair code "${code}" must not appear in server logs`);

      ext.close();
      cli.close();
    } finally {
      await stop(srv);
      cleanup(home);
    }
  });

  // ── Z11: pair_code string never appears in config.json after pairing ────────
  await test("Z11 pair_code string never appears in config.json after pairing", async () => {
    const port = await freePort();
    const home = makeTmpHome();
    const srv = startServer({ port, home });
    try {
      await waitFor("bridge up", () => srv.stderr.includes("WebSocket server listening"), 5000);

      const ext = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://cfgtest" });
      const extMessages = [];
      await new Promise((res) => ext.on("open", res));
      ext.on("message", (raw) => extMessages.push(JSON.parse(raw)));
      ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));
      await waitFor("pair_code", () => extMessages.some((m) => m.type === "pair_code"), 3000);

      const code = extMessages.find((m) => m.type === "pair_code").code;

      const cli = new WebSocket(`ws://localhost:${port}`);
      const cliMessages = [];
      await new Promise((res) => cli.on("open", res));
      cli.on("message", (raw) => cliMessages.push(JSON.parse(raw)));
      cli.send(JSON.stringify({ type: "uploads_pair_submit", code }));
      await waitFor("paired", () => cliMessages.some((m) => m.type === "uploads_pair_result" && m.ok), 3000);

      const cfgPath = path.join(home, "config.json");
      const cfgRaw = fs.readFileSync(cfgPath, "utf8");
      assert.ok(!cfgRaw.includes(code), `pair code "${code}" must not appear in config.json`);

      ext.close();
      cli.close();
    } finally {
      await stop(srv);
      cleanup(home);
    }
  });

  // ── Z12: uploads_pair_submit from chrome-extension origin is silently rejected
  await test("Z12 WS: uploads_pair_submit from extension origin is silently rejected", async () => {
    const port = await freePort();
    const home = makeTmpHome();
    const srv = startServer({ port, home });
    try {
      await waitFor("bridge up", () => srv.stderr.includes("WebSocket server listening"), 5000);

      // Extension socket: sends uploads_pair_submit (should be ignored).
      const ext = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://sneaky" });
      const extMessages = [];
      await new Promise((res) => ext.on("open", res));
      ext.on("message", (raw) => extMessages.push(JSON.parse(raw)));
      ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));

      // Wait for pair_code so server is fully ready.
      await waitFor("pair_code", () => extMessages.some((m) => m.type === "pair_code"), 3000);
      const code = extMessages.find((m) => m.type === "pair_code").code;

      // Extension sends uploads_pair_submit — must be silently ignored (no uploads_pair_result).
      ext.send(JSON.stringify({ type: "uploads_pair_submit", code }));
      await sleep(300);

      const gotResult = extMessages.some((m) => m.type === "uploads_pair_result");
      assert.ok(!gotResult, "extension socket must not receive uploads_pair_result from its own submit");

      ext.close();
    } finally {
      await stop(srv);
      cleanup(home);
    }
  });

  // ── Z13: MUST 1 — ping must NOT regenerate code or stack a prompt (real handler) ─
  await test("Z13 MUST 1: ping does not regenerate code or push new pair_code (real pair-flow handler)", async () => {
    const port = await freePort();
    const { pairViaTempListener } = require(path.join(REPO, "bin", "pair-flow.js"));

    let questionCount = 0;
    let pendingCb = null;
    const rl = {
      question: (_prompt, cb) => { questionCount++; pendingCb = cb; },
      close: () => {},
    };

    const listenerPromise = pairViaTempListener(port, rl);
    await sleep(50);

    const ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://z13" });
    const extMessages = [];
    await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });
    ext.on("message", (raw) => extMessages.push(JSON.parse(raw)));

    // extension_ready → listener must push exactly one pair_code and call rl.question once.
    ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));
    await waitFor("pair_code after extension_ready", () => extMessages.some((m) => m.type === "pair_code"), 3000);

    // Send two pings — must NOT push another pair_code or stack another rl.question.
    ext.send(JSON.stringify({ type: "ping" }));
    ext.send(JSON.stringify({ type: "ping" }));
    await sleep(100);

    assert.strictEqual(
      extMessages.filter((m) => m.type === "pair_code").length, 1,
      "ping must not push a new pair_code",
    );
    assert.strictEqual(questionCount, 1, "rl.question must be called exactly once (not once per ping)");

    // Resolve the listener cleanly via Enter-skip.
    if (pendingCb) pendingCb("");
    ext.close();
    await listenerPromise;
  });

  // ── Z14: MUST 3 — expiry timer regenerates code; expired ≠ wrong guess ──────
  await test("Z14 MUST 3: expired code triggers regeneration and does not count as wrong", async () => {
    const { PairHost } = require(PAIR_HOST);
    const ph = new PairHost({ codeTtlMs: 80 }); // very short TTL for the test

    const messages = [];
    const ws = { readyState: 1, send: (s) => messages.push(JSON.parse(s)) };

    ph.generateForSocket(ws, "chrome-extension://z14");
    assert.strictEqual(messages.length, 1, "should push initial pair_code");
    const originalCode = messages[0].code;

    // Wait for the expiry timer to fire and regenerate.
    await new Promise((r) => setTimeout(r, 150));

    assert.ok(messages.length >= 2, `expiry timer must push a second pair_code (got ${messages.length})`);
    const newCode = messages[messages.length - 1].code;
    assert.notStrictEqual(newCode, originalCode, "regenerated code must differ from expired one");

    // Submitting the expired code must return reason:"expired" WITHOUT incrementing wrongCount.
    const expiredResult = ph.submitCode(originalCode);
    assert.strictEqual(expiredResult.ok, false, "expired code must not ok");
    assert.strictEqual(expiredResult.reason, "expired", `expected reason "expired", got ${expiredResult.reason}`);
    assert.strictEqual(ph._lockout.wrongCount, 0, "expired guess must not increment wrongCount");

    ph.onSocketClose(ws);
  });

  // ── Z15: MUST 4 — positional id unpairs only that id ─────────────────────────
  await test("Z15 MUST 4: positional id form unpairs only the named id", async () => {
    const home = makeTmpHome();
    const savedHome = process.env.POLTERTAB_HOME;
    process.env.POLTERTAB_HOME = home;
    // Invalidate the cached config module so it reads from the new home.
    const configKey = Object.keys(require.cache).find((k) => k.endsWith("mcp-server/config.js"));
    const uploadsKey = Object.keys(require.cache).find((k) => k.endsWith("mcp-server/uploads-config.js"));
    if (configKey) delete require.cache[configKey];
    if (uploadsKey) delete require.cache[uploadsKey];
    try {
      const { addTrustedExtensionId, getTrustedExtensionIds } = require("../../mcp-server/uploads-config.js");
      const { run: uploadsRun } = require("../../bin/uploads.js");

      addTrustedExtensionId("aabbccdd00000000000000000000001a");
      addTrustedExtensionId("aabbccdd00000000000000000000002b");
      assert.strictEqual(getTrustedExtensionIds().length, 2, "pre-condition: 2 ids");

      // Positional form — unpairs only the first id.
      await uploadsRun(["unpair", "aabbccdd00000000000000000000001a"]);

      const remaining = getTrustedExtensionIds();
      assert.ok(!remaining.includes("aabbccdd00000000000000000000001a"), "named id must be removed");
      assert.ok(remaining.includes("aabbccdd00000000000000000000002b"), "other id must remain");
    } finally {
      if (savedHome === undefined) delete process.env.POLTERTAB_HOME;
      else process.env.POLTERTAB_HOME = savedHome;
      if (configKey) delete require.cache[configKey];
      if (uploadsKey) delete require.cache[uploadsKey];
      cleanup(home);
    }
  });

  // ── Z16–Z19: SHOULD 3 — temp listener exit paths and port cleanup ─────────────

  // Helper: fake readline that answers with `answer` on the first question call.
  function fakeRl(answer) {
    return {
      question: (_prompt, cb) => setImmediate(() => cb(answer)),
      close: () => {},
    };
  }

  await test("Z16 SHOULD 3: temp listener resolves ok:true on correct code (success path)", async () => {
    const port = await freePort();
    const { pairViaTempListener } = require(path.join(REPO, "bin", "pair-flow.js"));
    const { PairHost } = require(PAIR_HOST);

    // Intercept the generated code so the readline can feed it back.
    let capturedCode = null;
    const _orig = PairHost.prototype.generateForSocket;
    PairHost.prototype.generateForSocket = function (ws, extensionId) {
      _orig.call(this, ws, extensionId);
      const code = this._socketCodes.get(ws);
      if (code) capturedCode = code;
    };

    let result, ext;
    try {
      const rl = {
        question: (_prompt, cb) => {
          const wait = () => {
            if (capturedCode) { setImmediate(() => cb(capturedCode)); return; }
            setTimeout(wait, 20);
          };
          wait();
        },
        close: () => {},
      };

      const listenerPromise = pairViaTempListener(port, rl);
      await sleep(50);
      ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://z16" });
      await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });
      ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));
      result = await listenerPromise;
    } finally {
      PairHost.prototype.generateForSocket = _orig;
    }

    if (ext) ext.close();
    assert.ok(result.ok, `should succeed, got: ${JSON.stringify(result)}`);
    assert.ok(typeof result.extensionId === "string" && result.extensionId.length > 0, "must return extensionId");
  });

  await test("Z17 SHOULD 3: temp listener resolves ok:false/skipped on Enter-skip", async () => {
    const port = await freePort();
    const { pairViaTempListener } = require(path.join(REPO, "bin", "pair-flow.js"));

    const rl = {
      question: (_prompt, cb) => setImmediate(() => cb("")), // Enter with empty input
      close: () => {},
    };

    const listenerPromise = pairViaTempListener(port, rl);

    await sleep(50);
    const ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://z17" });
    await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });
    ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));

    const result = await listenerPromise;
    ext.close();
    assert.ok(!result.ok, "should not be ok");
    assert.strictEqual(result.reason, "skipped", `expected "skipped", got ${result.reason}`);
  });

  await test("Z18 SHOULD 3: temp listener resolves ok:false/locked on 5 wrong codes", async () => {
    const port = await freePort();
    const { pairViaTempListener } = require(path.join(REPO, "bin", "pair-flow.js"));

    let callCount = 0;
    const rl = {
      question: (_prompt, cb) => setImmediate(() => {
        callCount++;
        cb("XXXX"); // always wrong
      }),
      close: () => {},
    };

    const listenerPromise = pairViaTempListener(port, rl);

    await sleep(50);
    const ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://z18" });
    await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });
    ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));

    const result = await listenerPromise;
    ext.close();
    assert.ok(!result.ok, "should not be ok");
    assert.strictEqual(result.reason, "locked", `expected "locked", got ${result.reason}`);
  });

  await test("Z19 SHOULD 3: port is free after temp listener resolves", async () => {
    const port = await freePort();
    const { pairViaTempListener } = require(path.join(REPO, "bin", "pair-flow.js"));
    const net = require("net");

    const rl = fakeRl(""); // skip immediately
    const listenerPromise = pairViaTempListener(port, rl);

    await sleep(50);
    const ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://z19" });
    await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });
    ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));

    await listenerPromise;
    ext.close();

    // The port must be free now — binding a new server must succeed.
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.listen(port, "127.0.0.1", () => { probe.close(resolve); });
      probe.on("error", reject);
    });
  });

  // ── Z20: temp listener replies error to non-pairing messages ──────────────
  await test("Z20 temp listener replies pairing-mode error to non-pairing messages", async () => {
    const port = await freePort();
    const { pairViaTempListener } = require(path.join(REPO, "bin", "pair-flow.js"));

    let pendingCb = null;
    const rl = {
      question: (_prompt, cb) => { pendingCb = cb; },
      close: () => {},
    };

    const listenerPromise = pairViaTempListener(port, rl);
    await sleep(50);

    const ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://z20" });
    const extMessages = [];
    await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });
    ext.on("message", (raw) => extMessages.push(JSON.parse(raw)));

    ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));
    await waitFor("pair_code", () => extMessages.some((m) => m.type === "pair_code"), 3000);

    // Send a non-pairing message (simulates an AI tool or Secondary dialing in).
    ext.send(JSON.stringify({ type: "get_status" }));
    await waitFor("error reply", () => extMessages.some((m) => m.type === "error"), 2000);

    const errMsg = extMessages.find((m) => m.type === "error");
    assert.ok(errMsg, "extension must receive an error reply for a non-pairing message");
    assert.strictEqual(
      errMsg.error,
      "pairing mode — restart your AI tool for browser control",
      "error text must match spec",
    );

    if (pendingCb) pendingCb("");
    ext.close();
    await listenerPromise;
  });

  // ── Z21: write failure re-pushes to the matched extension ─────────────────
  await test("Z21 write failure re-pushes to the matched extension, not the closure socket", async () => {
    const port = await freePort();
    const { PairHost } = require(PAIR_HOST);

    const home = makeTmpHome();
    const savedHome = process.env.POLTERTAB_HOME;
    process.env.POLTERTAB_HOME = home;

    // Require uploads-config unconditionally — require() creates the cache entry AND returns
    // the exact exports object pair-flow.js will destructure, so the throw always fires even
    // when the module was not previously in require.cache (CI cold-cache state).
    const uploadsConfig = require(path.join(REPO, "mcp-server", "uploads-config.js"));
    const _origAddFn = uploadsConfig.addTrustedExtensionId;
    uploadsConfig.addTrustedExtensionId = () => { throw new Error("write fail"); };
    // Loud-fail guard: ensures the patch is in place before pair-flow is re-required.
    assert.throws(
      () => uploadsConfig.addTrustedExtensionId(),
      /write fail/,
      "patch must apply before pair-flow is re-required",
    );

    // Delete pair-flow from cache so it re-requires uploads-config and captures the thrower.
    const pairFlowKey = Object.keys(require.cache).find((k) => k.endsWith("bin/pair-flow.js"));
    if (pairFlowKey) delete require.cache[pairFlowKey];

    let ext1, ext2, result;
    try {
      const { pairViaTempListener } = require(path.join(REPO, "bin", "pair-flow.js"));

      // ext1's askCode callback (first question) will answer with ext2's code.
      // ext2's askCode callback (second question) is held open — it's never answered.
      let firstCb = null;
      let callCount = 0;
      const rl = {
        question: (_prompt, cb) => {
          callCount++;
          if (callCount === 1) firstCb = cb;
          // second and beyond: held open; listener resolves without needing them.
        },
        close: () => {},
      };

      const listenerPromise = pairViaTempListener(port, rl);
      await sleep(50);

      // Connect ext1.
      const ext1Messages = [];
      ext1 = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://z21-first" });
      await new Promise((res, rej) => { ext1.on("open", res); ext1.on("error", rej); });
      ext1.on("message", (raw) => ext1Messages.push(JSON.parse(raw)));
      ext1.send(JSON.stringify({ type: "extension_ready", version: "test" }));
      await waitFor("ext1 pair_code", () => ext1Messages.some((m) => m.type === "pair_code"), 3000);
      await waitFor("ext1 rl.question", () => firstCb !== null, 1000);

      // Connect ext2.
      const ext2Messages = [];
      ext2 = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://z21-second" });
      await new Promise((res, rej) => { ext2.on("open", res); ext2.on("error", rej); });
      ext2.on("message", (raw) => ext2Messages.push(JSON.parse(raw)));
      ext2.send(JSON.stringify({ type: "extension_ready", version: "test" }));
      await waitFor("ext2 pair_code", () => ext2Messages.some((m) => m.type === "pair_code"), 3000);

      // Submit ext2's code from ext1's askCode callback → write fails → re-push must target ext2.
      const ext2Code = ext2Messages.find((m) => m.type === "pair_code").code;
      firstCb(ext2Code);

      result = await listenerPromise;

      // The re-push send and finish() run in the same tick; wait for ext2's socket to deliver.
      await waitFor("ext2 re-push pair_code", () => ext2Messages.filter((m) => m.type === "pair_code").length >= 2, 3000);

      const ext1PairCodes = ext1Messages.filter((m) => m.type === "pair_code").length;
      const ext2PairCodes = ext2Messages.filter((m) => m.type === "pair_code").length;
      assert.ok(ext2PairCodes >= 2, `ext2 must receive a re-pushed pair_code (got ${ext2PairCodes})`);
      assert.strictEqual(ext1PairCodes, 1, `ext1 must not receive a re-push (got ${ext1PairCodes})`);
      assert.strictEqual(result.reason, "config_write_failed", `expected config_write_failed, got ${result.reason}`);
    } finally {
      uploadsConfig.addTrustedExtensionId = _origAddFn;
      const freshKey = Object.keys(require.cache).find((k) => k.endsWith("bin/pair-flow.js"));
      if (freshKey) delete require.cache[freshKey];
      if (savedHome === undefined) delete process.env.POLTERTAB_HOME;
      else process.env.POLTERTAB_HOME = savedHome;
      cleanup(home);
    }
    if (ext1) ext1.close();
    if (ext2) ext2.close();
  });

  // ── Z22: running-server pings do not regenerate pair code ──────────────────
  await test("Z22 running server: pings do not regenerate pair code; original code accepted after pings", async () => {
    // Sub-check: generateForSocket void must add old code to _recentlyExpired so a
    // late submitCode returns "expired" not "wrong" (pair-host.js fix).
    {
      delete require.cache[require.resolve(PAIR_HOST)];
      const { PairHost } = require(PAIR_HOST);
      const ph = new PairHost();
      const ws = fakeWs();
      ph.generateForSocket(ws, "chrome-extension://z22-unit");
      const firstCode = ws.sent[0].code;
      ph.generateForSocket(ws, "chrome-extension://z22-unit"); // explicitly void firstCode
      const r = ph.submitCode(firstCode);
      assert.strictEqual(r.reason, "expired",
        `voided code must return "expired" not "wrong"; got: ${r.reason}`);
    }

    const port = await freePort();
    const home = makeTmpHome();
    const srv = startServer({ port, home });
    let ext, cli;
    try {
      await waitFor("bridge up", () => srv.stderr.includes("WebSocket server listening"), 5000);

      ext = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://z22-ext" });
      const extMsgs = [];
      await new Promise((res) => ext.on("open", res));
      ext.on("message", (raw) => extMsgs.push(JSON.parse(raw)));

      ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));
      await waitFor("first pair_code", () => extMsgs.some((m) => m.type === "pair_code"), 3000);
      const firstCode = extMsgs.find((m) => m.type === "pair_code").code;

      // Send several pings — must NOT generate additional codes (bridge.js fix).
      for (let i = 0; i < 3; i++) {
        ext.send(JSON.stringify({ type: "ping" }));
      }
      await sleep(300);

      const allCodes = extMsgs.filter((m) => m.type === "pair_code");
      assert.strictEqual(allCodes.length, 1,
        `pings must not regenerate code; got ${allCodes.length} pair_code messages`);

      // Original code must still be valid and accepted after pings.
      cli = new WebSocket(`ws://localhost:${port}`);
      const cliMsgs = [];
      await new Promise((res) => cli.on("open", res));
      cli.on("message", (raw) => cliMsgs.push(JSON.parse(raw)));

      cli.send(JSON.stringify({ type: "uploads_pair_submit", code: firstCode }));
      await waitFor("pair_result", () => cliMsgs.some((m) => m.type === "uploads_pair_result"), 3000);

      const result = cliMsgs.find((m) => m.type === "uploads_pair_result");
      assert.ok(result.ok, `code submitted after pings must be accepted; got: ${JSON.stringify(result)}`);
    } finally {
      if (ext) ext.close();
      if (cli) cli.close();
      await stop(srv);
      cleanup(home);
    }
  });

  // ── Z23: temp listener replies uploads_not_paired with _replyId ────────────
  await test("Z23 temp listener replies uploads_not_paired+_replyId to uploads_get_config", async () => {
    const port = await freePort();
    const freshKey = Object.keys(require.cache).find((k) => k.endsWith("bin/pair-flow.js"));
    if (freshKey) delete require.cache[freshKey];
    const { pairViaTempListener } = require(path.join(REPO, "bin", "pair-flow.js"));
    let pendingCb = null;
    const rl = {
      question: (_prompt, cb) => { pendingCb = cb; },
      close: () => {},
    };

    const listenerPromise = pairViaTempListener(port, rl);
    await sleep(50);

    const ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://z23-ext" });
    const extMsgs = [];
    await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });
    ext.on("message", (raw) => extMsgs.push(JSON.parse(raw)));
    ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));
    await waitFor("pair_code", () => extMsgs.some((m) => m.type === "pair_code"), 3000);

    // Background.js sends uploads_get_config with _replyId on behalf of popup/options.
    ext.send(JSON.stringify({ type: "uploads_get_config", _replyId: "z23-42" }));
    await sleep(300);

    const reply = extMsgs.find((m) => m._replyId === "z23-42");
    assert.ok(reply,
      `extension must receive a reply with _replyId "z23-42"; messages so far: ${JSON.stringify(extMsgs.map((m) => m.type))}`);
    assert.strictEqual(reply.type, "uploads_not_paired",
      `reply.type must be "uploads_not_paired", got: "${reply.type}"`);

    if (pendingCb) pendingCb("");
    ext.close();
    await listenerPromise;
  });

  // ── Z24: popup renders pairCode from state_update when server is unreachable ─
  await test("Z24 popup shows pairCode in uploads row from state_update even when server is unreachable", () => {
    const vm = require("vm");

    const messageListeners = [];
    const uploadsRow = { hidden: true, textContent: "", addEventListener() {} };
    const uploadsText = { textContent: "" };

    function makeEl() {
      return {
        textContent: "", className: "", hidden: true, title: "", style: {},
        appendChild() {}, addEventListener() {}, setAttribute() {}, append() {},
        classList: { add() {} },
      };
    }

    let _lastError = null;
    const sandbox = {
      document: {
        _cb: null,
        addEventListener(ev, cb) { if (ev === "DOMContentLoaded") this._cb = cb; },
        getElementById(id) {
          if (id === "uploads-summary") return uploadsRow;
          if (id === "uploads-summary-text") return uploadsText;
          return makeEl();
        },
        createElement() { return makeEl(); },
        createElementNS() { const e = makeEl(); e.setAttribute = () => {}; return e; },
        createTextNode() { return {}; },
      },
      chrome: {
        runtime: {
          get lastError() { return _lastError; },
          sendMessage(msg, cb) {
            if (!cb) return;
            if (msg && msg.type === "uploads_get_config") {
              // Simulate unreachable server — set lastError so popup leaves row hidden.
              _lastError = { message: "connection lost" };
              cb(null);
              _lastError = null;
            } else {
              cb({ connected: false, sessions: [], version: "1.0.0" });
            }
          },
          onMessage: { addListener(cb) { messageListeners.push(cb); } },
          openOptionsPage() {},
        },
      },
      console,
    };

    const popupSrc = fs.readFileSync(path.join(REPO, "chrome-extension", "popup.js"), "utf8");
    vm.runInNewContext(popupSrc, sandbox);
    if (sandbox.document._cb) sandbox.document._cb();

    // Simulate background.js broadcasting state_update with pair code.
    for (const l of messageListeners) {
      l({ type: "state_update", state: { connected: false, sessions: [], pairCode: "ABCD" } });
    }

    assert.strictEqual(uploadsRow.hidden, false,
      "uploads row must be visible after state_update with pairCode when server is unreachable");
    assert.ok(uploadsText.textContent.includes("ABCD"),
      `uploads text must include pair code "ABCD"; got: "${uploadsText.textContent}"`);
  });

  // ── Z25: temp listener terminates connected clients after pair; port freed ──
  await test("Z25 temp listener terminates connected extension socket after pair; port is free", async () => {
    const port = await freePort();
    const freshKey2 = Object.keys(require.cache).find((k) => k.endsWith("bin/pair-flow.js"));
    if (freshKey2) delete require.cache[freshKey2];
    const { pairViaTempListener } = require(path.join(REPO, "bin", "pair-flow.js"));
    const { PairHost } = require(PAIR_HOST);
    const net = require("net");

    let capturedCode = null;
    const _orig = PairHost.prototype.generateForSocket;
    PairHost.prototype.generateForSocket = function (ws, extensionId) {
      _orig.call(this, ws, extensionId);
      const code = this._socketCodes.get(ws);
      if (code) capturedCode = code;
    };

    let ext;
    try {
      const rl = {
        question: (_prompt, cb) => {
          const wait = () => {
            if (capturedCode) { setImmediate(() => cb(capturedCode)); return; }
            setTimeout(wait, 20);
          };
          wait();
        },
        close: () => {},
      };

      const listenerPromise = pairViaTempListener(port, rl);
      await sleep(50);

      // Connect ext but do NOT close it — it must be terminated by cleanup().
      ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://z25-ext" });
      await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });
      ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));

      const result = await listenerPromise;
      assert.ok(result.ok, `pair must succeed; got: ${JSON.stringify(result)}`);

      await sleep(200); // give cleanup a moment to finalize

      // Port must be free even though we never called ext.close() — cleanup must have terminated it.
      await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.listen(port, "127.0.0.1", () => { probe.close(resolve); });
        probe.on("error", (e) => reject(new Error(`port ${port} still in use after pair cleanup: ${e.message}`)));
      });
    } finally {
      PairHost.prototype.generateForSocket = _orig;
      const cleanKey = Object.keys(require.cache).find((k) => k.endsWith("bin/pair-flow.js"));
      if (cleanKey) delete require.cache[cleanKey];
      if (ext) { try { ext.terminate(); } catch (_) {} }
    }
  });
}

module.exports = groupZ;
