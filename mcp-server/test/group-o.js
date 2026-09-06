const {
  assert,
  fakeExtension,
  memoryHome,
  rpc,
  test,
  waitFor,
  withServer,
} = require("./harness.js");
const fs = require("fs");
const os = require("os");
const path = require("path");

// In-process unit tests for memory.js. config.js reads POLTERTAB_HOME at load,
// so set an isolated home before requiring the module.
process.env.POLTERTAB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "poltertab-mem-"));
const memory = require("../memory.js");
const MEM_DIR = path.join(process.env.POLTERTAB_HOME, "navigation_memory");

async function groupO() {
  console.log("\nO. site-memory selector store");

  await test("O1 recordSelector then getSelector round-trips a fingerprint", () => {
    memory.recordSelector("o1.example", "#save", { tag: "button", text: "Save" });
    const got = memory.getSelector("o1.example", "#save");
    assert.ok(got, "selector was not stored");
    assert.deepStrictEqual(got.fingerprint, { tag: "button", text: "Save" });
    assert.strictEqual(got.failCount, 0);
  });

  await test("O2 reads an old bare-array file as {notes, selectors}", () => {
    fs.writeFileSync(
      path.join(MEM_DIR, "o2.example.json"),
      JSON.stringify([{ obstacle: "x", solution: "y", timestamp: 1 }]),
    );
    const m = memory.readMemory("o2.example");
    assert.deepStrictEqual(m.notes, [{ obstacle: "x", solution: "y", timestamp: 1 }]);
    assert.deepStrictEqual(m.selectors, {});
  });

  await test("O3 saveMemory dedups an identical note", () => {
    memory.saveMemory("o3.example", "same", "fix");
    const n = memory.saveMemory("o3.example", "same", "fix");
    assert.strictEqual(n, 1, "identical note was stored twice");
  });

  await test("O4 notes are capped at 100", () => {
    for (let i = 0; i < 130; i++) memory.saveMemory("o4.example", "ob" + i, "s");
    assert.strictEqual(memory.readMemory("o4.example").notes.length, 100);
  });

  await test("O5 selectors are capped, evicting the extras", () => {
    for (let i = 0; i < 210; i++)
      memory.recordSelector("o5.example", "#s" + i, { tag: "button" });
    assert.strictEqual(
      Object.keys(memory.readMemory("o5.example").selectors).length,
      200,
    );
  });

  await test("O6 a selector that keeps failing is dropped after 3 misses", () => {
    memory.recordSelector("o6.example", "#gone", { tag: "button" });
    memory.noteSelectorFail("o6.example", "#gone");
    memory.noteSelectorFail("o6.example", "#gone");
    assert.ok(memory.getSelector("o6.example", "#gone"), "dropped too early");
    memory.noteSelectorFail("o6.example", "#gone");
    assert.strictEqual(
      memory.getSelector("o6.example", "#gone"),
      null,
      "not dropped after MAX_FAILS",
    );
  });

  await test("O7 auto-injects a stored fingerprint into a click on the same host", async () => {
    const home = memoryHome({
      "t.json": {
        notes: [],
        selectors: {
          "#save": { fingerprint: { tag: "button", text: "Save" }, lastOk: 1, failCount: 0 },
        },
      },
    });
    await withServer(home, async (srv) => {
      const ext = fakeExtension();
      await waitFor("ext open", () => ext.open);
      // A get_url reveals we're on http://t/, priming the host cache.
      await rpc(srv, "tools/call", { name: "browser_get_url", arguments: {} });
      // Click with no fingerprint of its own — the server should supply one.
      await rpc(srv, "tools/call", {
        name: "browser_click",
        arguments: { selector: "#save" },
      });
      const click = ext.seen.find((m) => m.action === "click");
      assert.ok(click, "click never reached the extension");
      assert.deepStrictEqual(
        click.fingerprint,
        { tag: "button", text: "Save" },
        "stored fingerprint was not injected",
      );
      ext.ws.close();
    });
  });
  await test("O8 a corrupt memory file reads as empty instead of throwing", () => {
    fs.writeFileSync(path.join(MEM_DIR, "o8.example.json"), '{"notes":[{"obst');
    const m = memory.readMemory("o8.example");
    assert.deepStrictEqual(m.notes, []);
    assert.deepStrictEqual(m.selectors, {});
  });

  await test("O9 a corrupt file cannot brick getSelector on the click path", () => {
    fs.writeFileSync(path.join(MEM_DIR, "o9.example.json"), "{not json");
    assert.strictEqual(memory.getSelector("o9.example", "#save"), null);
  });

  await test("O10 an unwritable store never throws at a caller mid-click", () => {
    memory.recordSelector("o10.example", "#save", { tag: "button" });
    // Writes go temp-file-then-rename, so only an unwritable *directory* blocks
    // them — a read-only file still renames fine.
    fs.chmodSync(MEM_DIR, 0o500);
    try {
      // A completed click must not be reported as a failure because the
      // bookkeeping write failed afterwards.
      memory.recordSelector("o10.example", "#other", { tag: "a" });
      memory.noteSelectorFail("o10.example", "#save");
    } finally {
      fs.chmodSync(MEM_DIR, 0o700);
    }
  });
}

module.exports = groupO;
