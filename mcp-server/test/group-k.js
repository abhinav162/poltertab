const {
  WebSocket,
  assert,
  callExtractAll,
  fakeExtension,
  fs,
  getMemory,
  initialize,
  memoryHome,
  page12,
  path,
  rpc,
  scriptedExtension,
  startServer,
  test,
  textOf,
  waitFor,
  withServer,
} = require("./harness.js");

async function groupK() {
  console.log("\nK. benchmark-run regressions");

  const note = (obstacle) => [{ obstacle, solution: "s", timestamp: 1 }];

  await test("K1 www.<host> finds notes saved under the bare host", async () => {
    // The bug: kw.com.json existed and a lookup for www.kw.com returned [] —
    // silently, so T1's own documented first step found nothing.
    const home = memoryHome({ "kw.com.json": note("12 agents per page") });
    await withServer(home, async (srv) => {
      const text = textOf(await getMemory(srv, "www.kw.com"));
      assert.ok(/12 agents per page/.test(text), `returned: ${text}`);
    });
  });

  await test("K2 the bare host finds notes saved under www.<host>", async () => {
    // The store already holds both spellings, so the fallback runs both ways.
    const home = memoryHome({ "www.linkedin.com.json": note("voyager graphql") });
    await withServer(home, async (srv) => {
      const text = textOf(await getMemory(srv, "linkedin.com"));
      assert.ok(/voyager graphql/.test(text), `returned: ${text}`);
    });
  });

  await test("K3 a full URL is accepted where a hostname is expected", async () => {
    const home = memoryHome({ "kw.com.json": note("paginate with ?page=N") });
    await withServer(home, async (srv) => {
      const text = textOf(await getMemory(srv, "https://www.kw.com/agents?page=3"));
      assert.ok(/paginate with \?page=N/.test(text), `returned: ${text}`);
    });
  });

  await test("K4 a hostname cannot read outside the memory directory", async () => {
    // The host was interpolated straight into a path, and it comes from a model.
    const home = memoryHome({
      "kw.com.json": note("fine"),
      "../secret.json": note("PRIVATE-MARKER"),
    });
    await withServer(home, async (srv) => {
      const reply = await getMemory(srv, "../secret");
      const text = textOf(reply);
      assert.ok(
        !/PRIVATE-MARKER/.test(text),
        `escaped the memory dir: ${text.slice(0, 120)}`,
      );
    });
  });

  await test("K5 a note saved under one spelling is found under the other", async () => {
    const home = memoryHome({});
    await withServer(home, async (srv) => {
      await rpc(srv, "tools/call", {
        name: "browser_save_site_memory",
        arguments: {
          hostname: "www.kw.com",
          obstacle: "socials sit outside .agent-card-info",
          solution: "use .agent-card as the record root",
        },
      });
      const text = textOf(await getMemory(srv, "kw.com"));
      assert.ok(/socials sit outside/.test(text), `returned: ${text}`);
      // One file per site, not one per spelling. (A fresh home also receives
      // the legacy-migration copies, so this checks the pair, not the listing.)
      const dir = path.join(home, "navigation_memory");
      assert.ok(fs.existsSync(path.join(dir, "kw.com.json")));
      assert.ok(
        !fs.existsSync(path.join(dir, "www.kw.com.json")),
        "saved a second file for the www spelling",
      );
    });
  });

  await test("K6 output_file confines an absolute path and says it did", async () => {
    const home = memoryHome({});
    await withServer(home, async (srv) => {
      const ext = fakeExtension();
      await waitFor("ext open", () => ext.open);
      const reply = await rpc(srv, "tools/call", {
        name: "browser_get_network_state",
        arguments: { output_file: "/Users/somebody/Desktop/agents.json" },
      });
      const text = textOf(reply);
      // Silently writing somewhere else is how a caller ends up looking for a
      // file that was never going to be there.
      assert.ok(
        /downloads/.test(text),
        `no indication of where it actually went: ${text}`,
      );
      assert.ok(
        !fs.existsSync("/Users/somebody/Desktop/agents.json"),
        "wrote outside the downloads dir",
      );
      ext.ws.close();
    });
  });

  await test("K7 extract_all reports fill as counts, and the baseline as ratios", async () => {
    // The inconsistency: extract returned counts under fill_rates while
    // extract_all returned fractions under a near-identical name.
    const srv = startServer();
    try {
      await waitFor("listening", () =>
        srv.stderr.includes("WebSocket server listening"),
      );
      const ext = scriptedExtension((n) => (n <= 2 ? page12(n) : []));
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const out = await callExtractAll(srv, {
        limit: 500,
        fields: {
          name: { sel: "a.name", get: "text" },
          url: { sel: "a.name", get: "href" },
          phone: { sel: "a[href^='tel:']", get: "href" },
        },
      });

      assert.strictEqual(out.count, 24);
      // 24 rows, every one with a name and url; phone is null on 2 per page.
      assert.strictEqual(out.fill_rates.name, 24, JSON.stringify(out.fill_rates));
      assert.strictEqual(out.fill_rates.url, 24);
      assert.strictEqual(out.fill_rates.phone, 20);
      assert.strictEqual(
        out.baseline_fill_rates,
        undefined,
        "the ambiguously-named key is still there",
      );
      // Ratios stay fractions, since they are compared across pages of
      // differing size.
      assert.ok(
        out.baseline_fill_ratios.phone > 0.8 && out.baseline_fill_ratios.phone < 0.9,
        JSON.stringify(out.baseline_fill_ratios),
      );
      assert.strictEqual(out.baseline_fill_ratios.name, 1);
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });
}

module.exports = groupK;
