const {
  PORT,
  WebSocket,
  assert,
  fs,
  initialize,
  os,
  path,
  rpc,
  sleep,
  startServer,
  test,
  textOf,
  waitFor,
} = require("./harness.js");

async function groupH() {
  console.log("\nH. update notice + version skew (real processes, fake extension)");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "poltertab-notice-"));
  // Claim the registry reported something far newer, fresh enough to be trusted
  // from cache so the test never touches the network.
  fs.writeFileSync(
    path.join(home, "update-check.json"),
    JSON.stringify({ checkedAt: Date.now(), latest: "99.0.0" }),
  );

  const srv = startServer({ home, env: { POLTERTAB_NO_UPDATE_CHECK: "" } });
  try {
    await waitFor(
      "server listening",
      () => srv.stderr.includes("WebSocket server listening"),
    );

    // An ancient but *parseable* version, unlike the shared fake extension's
    // "test" — skew can only be computed from real semver on both sides.
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const seen = [];
    await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
    });
    ws.send(JSON.stringify({ type: "extension_ready", version: "0.1.0" }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      seen.push(m);
      if (m.id && m.action) {
        ws.send(JSON.stringify({ id: m.id, success: true, data: { title: "T" } }));
      }
    });
    await sleep(500);

    await rpc(srv, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });

    let first;
    await test("H1 the first tool response carries the notice", async () => {
      first = textOf(
        await rpc(srv, "tools/call", { name: "browser_get_title", arguments: {} }),
      );
      assert.ok(/\[PolterTab\]/.test(first), `no notice in: ${first}`);
    });

    await test("H2 the notice names the skew and the available version", async () => {
      assert.ok(/0\.1\.0/.test(first), "skew not described");
      assert.ok(/older than this server/.test(first), "skew direction not stated");
      assert.ok(/99\.0\.0/.test(first), "available version not mentioned");
    });

    await test("H3 the tool's own payload survives alongside the notice", async () => {
      // Appending to content must not corrupt what the caller actually asked for.
      assert.ok(/"title"/.test(first), `payload lost: ${first}`);
    });

    await test("H4 the notice appears once per process, not on every call", async () => {
      const second = textOf(
        await rpc(srv, "tools/call", { name: "browser_get_title", arguments: {} }),
      );
      assert.ok(!/\[PolterTab\]/.test(second), `notice repeated: ${second}`);
      assert.ok(/"title"/.test(second), "second call lost its payload");
    });

    await test("H5 the server tells the extension its version", async () => {
      // Without this the popup has our version but nothing to compare it to.
      const hello = seen.find((m) => m.type === "server_version");
      assert.ok(hello, `never sent server_version: ${JSON.stringify(seen)}`);
      assert.ok(/^\d+\.\d+\.\d+/.test(hello.version), `odd version: ${hello.version}`);
    });

    await test("H6 skew is logged to stderr, never to the JSON-RPC stream", async () => {
      assert.ok(/VERSION SKEW/.test(srv.stderr), "skew not logged");
      for (const m of srv.messages) {
        assert.ok(
          !/VERSION SKEW/.test(m.line),
          `skew log leaked onto stdout: ${m.line}`,
        );
      }
    });

    await test("H7 the extension version is recorded for doctor to read", async () => {
      const state = JSON.parse(
        fs.readFileSync(path.join(home, "state.json"), "utf8"),
      );
      assert.strictEqual(state.extensionVersion, "0.1.0");
      assert.ok(state.seenAt > 0, "no timestamp recorded");
    });

    ws.close();
  } finally {
    srv.proc.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

module.exports = groupH;
