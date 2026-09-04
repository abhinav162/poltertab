const {
  WebSocket,
  assert,
  callExtractAll,
  fs,
  initialize,
  page12,
  path,
  rpc,
  scriptedExtension,
  startServer,
  test,
  textOf,
  waitFor,
} = require("./harness.js");

async function groupJ() {
  console.log("\nJ. the pagination loop");

  await test("J1 walks pages to the limit in ONE tool call, deduped", async () => {
    const srv = startServer();
    try {
      await waitFor("listening", () => srv.stderr.includes("WebSocket server listening"));
      const ext = scriptedExtension(page12);
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const out = await callExtractAll(srv, { limit: 30 });
      assert.strictEqual(out.count, 30, JSON.stringify(out).slice(0, 400));
      assert.strictEqual(out.stopped_because, "limit_reached");
      assert.strictEqual(out.pages_fetched, 3, "should need exactly 3 pages of 12");
      assert.strictEqual(
        new Set(out.rows.map((r) => r.url)).size,
        30,
        "duplicate records in the output",
      );
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });

  await test("J2 a site that ignores ?page halts instead of returning page 1 forever", async () => {
    const srv = startServer();
    try {
      await waitFor("listening", () => srv.stderr.includes("WebSocket server listening"));
      // Every page returns page 1's records — the ?size=50 trap.
      const ext = scriptedExtension(() => page12(1));
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const out = await callExtractAll(srv, { limit: 100 });
      assert.strictEqual(out.stopped_because, "duplicate_page");
      assert.strictEqual(out.count, 12, "emitted repeats of the same page as new data");
      assert.ok(out.pages_fetched <= 3, `kept going: ${out.pages_fetched} pages`);
      assert.ok(
        /not advancing/.test(out.warnings.join(" ")),
        out.warnings.join(" "),
      );
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });

  await test("J3 an empty page ends the run and says so", async () => {
    const srv = startServer();
    try {
      await waitFor("listening", () => srv.stderr.includes("WebSocket server listening"));
      const ext = scriptedExtension((n) => (n <= 2 ? page12(n) : []));
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const out = await callExtractAll(srv, { limit: 500 });
      assert.strictEqual(out.stopped_because, "empty_page");
      assert.strictEqual(out.count, 24);
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });

  await test("J4 fill rates collapsing halts the run and keeps what was collected", async () => {
    const srv = startServer();
    try {
      await waitFor("listening", () => srv.stderr.includes("WebSocket server listening"));
      // Page 3 is a different layout: the name column stops being populated.
      const ext = scriptedExtension((n) =>
        n < 3
          ? page12(n)
          : page12(n).map((r) => ({ ...r, name: null })),
      );
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const out = await callExtractAll(srv, { limit: 500 });
      assert.strictEqual(out.stopped_because, "fill_rate_deviation");
      assert.strictEqual(out.count, 24, "should keep pages 1-2 rather than lose them");
      assert.ok(/name 0% vs baseline 100%/.test(out.warnings.join(" ")), out.warnings.join(" "));
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });

  await test("J5 max_pages is a hard guard", async () => {
    const srv = startServer();
    try {
      await waitFor("listening", () => srv.stderr.includes("WebSocket server listening"));
      const ext = scriptedExtension(page12);
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const out = await callExtractAll(srv, { limit: 1000, max_pages: 2 });
      assert.strictEqual(out.stopped_because, "max_pages");
      assert.strictEqual(out.pages_fetched, 2);
      assert.strictEqual(out.count, 24);
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });

  await test("J6 output_file writes a real CSV and returns only a summary", async () => {
    const srv = startServer();
    try {
      await waitFor("listening", () => srv.stderr.includes("WebSocket server listening"));
      const ext = scriptedExtension((n) =>
        n === 1
          ? [
              { name: 'Ann "The Closer", Lee', url: "http://t/a", phone: "1" },
              { name: "Cal\nBrown", url: "http://t/c", phone: null },
            ]
          : [],
      );
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const out = await callExtractAll(srv, { limit: 50, output_file: "agents.csv" });

      assert.ok(out.file, "no file path returned");
      assert.strictEqual(out.rows, undefined, "raw rows came back inline anyway");
      assert.strictEqual(out.sample.length, 2);
      assert.deepStrictEqual(out.fields, ["name", "url", "phone"]);

      const csv = fs.readFileSync(out.file, "utf8");
      assert.ok(csv.startsWith("name,url,phone\n"), csv);
      // A quote inside a quoted field must be doubled and a comma must not
      // split the row — the difference between a file that imports and one that
      // imports wrongly. A field holding a newline legitimately spans two
      // lines, so this is asserted against the whole text, not line by line.
      assert.ok(csv.includes('"Ann ""The Closer"", Lee",http://t/a,1'), csv);
      assert.ok(csv.includes('"Cal\nBrown",http://t/c,'), csv);
      assert.ok(!/null/.test(csv), "a null was written as the text 'null'");
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });

  await test("J7 url_template without {page} is rejected up front", async () => {
    const srv = startServer();
    try {
      await waitFor("listening", () => srv.stderr.includes("WebSocket server listening"));
      const ext = scriptedExtension(page12);
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const reply = await rpc(srv, "tools/call", {
        name: "browser_extract_all",
        arguments: {
          url_template: "http://t/agents",
          record: ".agent-card",
          fields: { name: { sel: "a", get: "text" } },
        },
      });
      assert.ok(reply.result.isError, "silently scraped page 1 N times");
      assert.ok(/\{page\}/.test(textOf(reply)), textOf(reply));
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });
}

module.exports = groupJ;
