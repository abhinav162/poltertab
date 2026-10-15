const {
  DOWNLOADS,
  REPO,
  TAB,
  WebSocket,
  assert,
  fakeExtension,
  fs,
  initialize,
  path,
  rpc,
  sleep,
  startServer,
  test,
  textOf,
  waitFor,
} = require("./harness.js");

async function groupD() {
  console.log("\nD. mcp-server end-to-end (real processes, fake extension)");

  fs.rmSync(DOWNLOADS, { recursive: true, force: true });

  const primary = startServer();
  await waitFor(
    "primary listening",
    () => primary.stderr.includes("Primary WebSocket server listening"),
    10000,
  );
  const ext = fakeExtension();
  await waitFor("extension connected", () => ext.open, 10000);
  await waitFor(
    "server acked extension",
    () => primary.stderr.includes("Chrome extension connected"),
    10000,
  );
  await initialize(primary);

  const secondary = startServer();
  await waitFor(
    "secondary mode",
    () => secondary.stderr.includes("running as Secondary"),
    10000,
  );
  await initialize(secondary);

  try {
    await test("D1 tools/list exposes the full browser toolset", async () => {
      const r = await rpc(primary, "tools/list", {});
      const names = r.result.tools.map((t) => t.name);
      assert.strictEqual(names.length, 28, `got ${names.length} tools`);
      assert.strictEqual(new Set(names).size, names.length, "duplicate tool names detected");
      assert.ok(names.includes("browser_get_network_state"));
      assert.ok(names.every((n) => n.startsWith("browser_")));
    });

    await test("D2 primary: output_file writes to disk and returns a short string", async () => {
      ext.pushNetworkData(3);
      await sleep(300);
      const r = await rpc(primary, "tools/call", {
        name: "browser_get_network_state",
        arguments: { output_file: "primary.json" },
      });
      const text = textOf(r);
      assert.ok(
        text.startsWith("Data successfully written to"),
        `returned payload instead of a path: ${text.slice(0, 80)}`,
      );
      assert.ok(text.includes("Captured 3 requests"), text);
      const written = fs.readdirSync(DOWNLOADS).filter((f) => f.startsWith("primary_"));
      assert.strictEqual(written.length, 1, `files: ${written}`);
      const saved = JSON.parse(fs.readFileSync(path.join(DOWNLOADS, written[0]), "utf8"));
      assert.strictEqual(saved.capturedRequests, 3);
    });

    await test("D3 secondary: output_file is honoured too (was silently ignored)", async () => {
      ext.pushNetworkData(4);
      await sleep(300);
      const r = await rpc(secondary, "tools/call", {
        name: "browser_get_network_state",
        arguments: { output_file: "secondary.json" },
      });
      const text = textOf(r);
      assert.ok(
        text.startsWith("Data successfully written to"),
        `secondary flooded the context instead of writing a file: ${text.slice(0, 80)}`,
      );
      assert.ok(text.includes("Captured 4 requests"), text);
      const written = fs.readdirSync(DOWNLOADS).filter((f) => f.startsWith("secondary_"));
      assert.strictEqual(written.length, 1, `files: ${written}`);
    });

    await test("D4 secondary without output_file still returns the payload inline", async () => {
      ext.pushNetworkData(2);
      await sleep(300);
      const r = await rpc(secondary, "tools/call", {
        name: "browser_get_network_state",
        arguments: {},
      });
      const parsed = JSON.parse(textOf(r));
      assert.strictEqual(parsed.capturedRequests, 2);
      assert.strictEqual(parsed.tabId, TAB);
    });

    await test("D5 output_file cannot escape the downloads directory", async () => {
      ext.pushNetworkData(1);
      await sleep(300);
      const r = await rpc(primary, "tools/call", {
        name: "browser_get_network_state",
        arguments: { output_file: "../../../evil.json" },
      });
      const text = textOf(r);
      assert.ok(text.includes(DOWNLOADS), text);
      assert.ok(!fs.existsSync(path.join(REPO, "evil.json")), "escaped to repo root");
      assert.ok(
        !fs.existsSync(path.join(REPO, "..", "evil.json")),
        "escaped above the repo",
      );
    });

    await test("D6 tool arguments may be omitted entirely", async () => {
      const r = await rpc(primary, "tools/call", {
        name: "browser_get_title",
      });
      assert.ok(r.result, JSON.stringify(r).slice(0, 200));
    });

    await test("D7 a tab-close log never lands on the JSON-RPC stream", async () => {
      ext.pushNetworkData(1);
      await sleep(200);
      ext.ws.send(JSON.stringify({ type: "tab_closed", tabId: TAB }));
      await waitFor(
        "tab_closed handled",
        () => primary.stderr.includes("Clearing network state for closed tab"),
        10000,
      );
      const noise = primary.messages.filter((m) => {
        if (m.parsed === undefined) {
          try {
            m.parsed = JSON.parse(m.line);
          } catch {
            m.parsed = null;
          }
        }
        return !m.parsed || m.parsed.jsonrpc !== "2.0";
      });
      assert.strictEqual(
        noise.length,
        0,
        `non-protocol bytes on stdout: ${noise.map((n) => n.line).join(" | ")}`,
      );
    });

    // M1: the direct path builds its envelope through _buildEnvelope, which
    // strips the reserved keys. The Primary's proxy path spread the Secondary's
    // params straight into {id, action, ...params}, so a tool argument named
    // "id" or "action" overwrote the routing — a reply id that matches no
    // pending command, or a different action than the tool named. Asserted
    // end-to-end rather than in group R, because this path only exists with a
    // live Primary, Secondary and extension, which this group already runs.
    await test("D8 a Secondary's tool args cannot override the envelope's id or action", async () => {
      const before = ext.seen.length;
      await rpc(secondary, "tools/call", {
        name: "browser_get_url",
        arguments: { id: "hijack", action: "evil", _client: "spoofed" },
      });
      const envelope = ext.seen
        .slice(before)
        .find((m) => m.id && m.action);
      assert.ok(envelope, "nothing reached the extension");
      assert.strictEqual(envelope.action, "get_url", "params.action hijacked the route");
      assert.notStrictEqual(envelope.id, "hijack", "params.id hijacked the reply id");
      assert.notStrictEqual(envelope._client, "spoofed", "params._client spoofed the agent");
      assert.ok(envelope._client, "the proxying Secondary was not identified");
      // The other half of the old Q13: a Secondary used to have
      // session: "agent_<nodeId>" injected into every command, overriding each
      // browser_tab_switch it made. Its identity rides on _client now.
      assert.ok(!("session" in envelope), "a session was injected into the envelope");
    });

    await test("D9 stdout carried only well-formed JSON-RPC for the whole run", () => {
      assert.ok(primary.messages.length >= 4, `only ${primary.messages.length} protocol messages`);
      for (const m of primary.messages) {
        assert.strictEqual(m.parsed && m.parsed.jsonrpc, "2.0", `bad line: ${m.line}`);
      }
    });
  } finally {
    ext.ws.close();
    secondary.proc.kill();
    primary.proc.kill();
    await sleep(300);
  }
}

module.exports = groupD;
