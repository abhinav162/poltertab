const {
  WebSocket,
  assert,
  fakeExtension,
  handshake,
  initialize,
  path,
  rpc,
  sleep,
  startServer,
  test,
  textOf,
  waitFor,
} = require("./harness.js");

async function groupL() {
  console.log("\nL. bridge handshake origin check");

  const srv = startServer();
  try {
    await waitFor("listening", () =>
      srv.stderr.includes("WebSocket server listening"),
    );

    await test("L1 a page origin is refused before it can impersonate the extension", async () => {
      // The drive-by: any site the user visits may open ws:// to loopback. If
      // it gets in, the nodeId-less branch installs it as `extensionSocket`,
      // dropping the real extension and taking over every later command.
      const r = await handshake("https://evil.example");
      assert.strictEqual(r.accepted, false, "a page origin completed the handshake");
      assert.ok(
        r.status === 403 || /403|unexpected server response/i.test(r.error || ""),
        `expected a 403 refusal, got ${JSON.stringify(r)}`,
      );
    });

    await test("L2 the refusal is logged, not silent", () => {
      assert.ok(
        srv.stderr.includes("Refused WebSocket handshake from origin https://evil.example"),
        "a rejected handshake must be distinguishable from an extension that never connected",
      );
    });

    await test("L3 the extension's own origin is accepted", async () => {
      const r = await handshake("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
      assert.strictEqual(r.accepted, true, JSON.stringify(r));
    });

    await test("L4 a Secondary node (no Origin header) is accepted", async () => {
      // Node's ws client sends no Origin. This is the path every Secondary MCP
      // server takes, so refusing it would break multi-agent mode outright.
      const r = await handshake(null);
      assert.strictEqual(r.accepted, true, JSON.stringify(r));
    });

    await test("L5 a real extension still drives a command end to end", async () => {
      // The check sits on the handshake, so prove the accepted path is not just
      // open but functional.
      await initialize(srv);
      const ext = fakeExtension();
      await waitFor("extension connected", () => ext.open);
      await waitFor("server saw it", () => srv.stderr.includes("Chrome extension connected"));
      const reply = await rpc(srv, "tools/call", {
        name: "browser_get_url",
        arguments: {},
      });
      assert.ok(textOf(reply).includes("http://t/"), textOf(reply));
      ext.ws.close();
    });
  } finally {
    srv.proc.kill();
    await sleep(200);
  }
}

module.exports = groupL;
