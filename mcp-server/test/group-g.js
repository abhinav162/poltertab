const {
  assert,
  frameSearchSandbox,
  test,
} = require("./harness.js");

async function groupG() {
  console.log("\nG. cross-frame element search");

  await test("G1 click finds an element in the second frame when top frame misses", async () => {
    const bg = frameSearchSandbox({
      frames: [
        { frameId: 0, elements: {} },
        { frameId: 123, elements: { "#app-btn": { clicked: "#app-btn", tag: "button" } } },
      ],
    });
    const reply = await bg.command({ id: "g1", action: "click", selector: "#app-btn" });
    assert.ok(reply, "no reply received");
    assert.strictEqual(reply.success, true, reply.error || "failed");
    assert.strictEqual(reply.data.clicked, "#app-btn");
  });

  await test("G2 fill works in an iframe (the OCI textarea bug)", async () => {
    const bg = frameSearchSandbox({
      frames: [
        { frameId: 0, elements: {} },
        { frameId: 456, elements: { "#chat": { filled: "#chat", value: "hi" } } },
      ],
    });
    const reply = await bg.command({ id: "g2", action: "fill", selector: "#chat", value: "hi" });
    assert.ok(reply, "no reply");
    assert.strictEqual(reply.success, true, reply.error || "failed");
  });

  await test("G3 top frame wins when it has the element (no unnecessary frame search)", async () => {
    const bg = frameSearchSandbox({
      frames: [
        { frameId: 0, elements: { "#nav": { clicked: "#nav", tag: "a" } } },
        { frameId: 789, elements: { "#nav": { clicked: "#nav", tag: "button" } } },
      ],
    });
    const reply = await bg.command({ id: "g3", action: "click", selector: "#nav" });
    assert.strictEqual(reply.success, true);
    // Top frame served it — tag is "a" not "button"
    assert.strictEqual(reply.data.tag, "a");
  });

  await test("G4 genuinely absent element reports not found across all frames", async () => {
    const bg = frameSearchSandbox({
      frames: [
        { frameId: 0, elements: {} },
        { frameId: 100, elements: {} },
        { frameId: 200, elements: {} },
      ],
    });
    const reply = await bg.command({ id: "g4", action: "click", selector: "#ghost" });
    assert.strictEqual(reply.success, false);
    assert.ok(/not found/i.test(reply.error), reply.error);
  });

  await test("G5 scrape with selector searches frames (empty result = miss)", async () => {
    const bg = frameSearchSandbox({
      frames: [
        { frameId: 0, elements: {} },
        { frameId: 555, elements: { "#data": [{ tag: "span", text: "value" }] } },
      ],
    });
    const reply = await bg.command({ id: "g5", action: "scrape", selector: "#data" });
    assert.ok(reply, "no reply");
    assert.strictEqual(reply.success, true, reply.error || "failed");
  });

  await test("G7 many empty frames do not burn the timeout budget (was: 54s)", async () => {
    // 20 empty frames + 1 with the target. Without _noWait, this would take
    // 20 x 3s = 60s. With fast-probe it should resolve in < 2s.
    const frames = [];
    for (let i = 0; i < 20; i++) {
      frames.push({ frameId: i * 10, elements: {} });
    }
    frames.push({
      frameId: 999,
      elements: { "#target": { clicked: "#target", tag: "button" } },
    });
    const bg = frameSearchSandbox({ frames });
    const start = Date.now();
    const reply = await bg.command({ id: "g7", action: "click", selector: "#target" });
    const elapsed = Date.now() - start;
    assert.strictEqual(reply.success, true, reply.error || "failed");
    assert.strictEqual(reply.data.clicked, "#target");
    assert.ok(
      elapsed < 5000,
      `took ${elapsed}ms across 21 frames — _noWait is not being passed`,
    );
  });

  await test("G8 late modal in top frame still resolves after fast-probe miss", async () => {
    // All frames miss on the fast probe. Frame 0 gets a retry with the wait.
    // Simulate the element appearing 500ms into the retry window.
    const frames = [
      { frameId: 0, elements: {} },
      { frameId: 100, elements: {} },
    ];
    const bg = frameSearchSandbox({ frames });
    // Inject the element into frame 0 after a delay
    setTimeout(() => {
      frames[0].elements["#late"] = { clicked: "#late", tag: "div" };
    }, 500);
    const reply = await bg.command({ id: "g8", action: "click", selector: "#late" });
    assert.strictEqual(reply.success, true, reply.error || "late modal not found");
  });

  await test("G9 extract finds records in a child frame when the top frame has none", async () => {
    const bg = frameSearchSandbox({
      frames: [
        { frameId: 0, records: {} },
        { frameId: 123, records: { ".card": [{ name: "Ann" }, { name: "Cal" }] } },
      ],
    });
    const reply = await bg.command({
      id: "g9",
      action: "extract",
      record: ".card",
      fields: { name: { sel: "a", get: "text" } },
    });
    assert.strictEqual(reply.success, true, reply.error || "failed");
    assert.strictEqual(reply.data.count, 2);
  });

  await test("G10 zero records returns the explanation, not an iframe's error", async () => {
    // The live shape on a kw.com profile page: frame 0 has the content script
    // and no matching records; a child iframe has no content script at all.
    // The frameless child's "Receiving end does not exist" was being thrown as
    // the result, which read as "the content script never attached" when the
    // real answer was "that record selector matches nothing here".
    const bg = frameSearchSandbox({
      frames: [
        { frameId: 0, records: {} },
        { frameId: 7, noContentScript: true },
      ],
    });
    const reply = await bg.command({
      id: "g10",
      action: "extract",
      record: "div.profile-contact",
      fields: { phone: { sel: "a", get: "href" } },
    });
    assert.strictEqual(
      reply.success,
      true,
      `threw instead of answering: ${reply.error}`,
    );
    assert.strictEqual(reply.data.records_found, 0);
    assert.ok(
      /no matches for "div.profile-contact"/.test(reply.data.warnings.join(" ")),
      `lost the diagnostic: ${JSON.stringify(reply.data.warnings)}`,
    );
  });

  await test("G6 snapshot aggregates across all frames", async () => {
    const bg = frameSearchSandbox({
      frames: [
        { frameId: 0, snapshotNodes: [{ ref: "@e1", tag: "nav", text: "shell" }] },
        { frameId: 777, snapshotNodes: [{ ref: "@e1", tag: "button", text: "app btn" }] },
      ],
    });
    const reply = await bg.command({ id: "g6", action: "snapshot" });
    assert.strictEqual(reply.success, true, reply.error || "failed");
    // Should have nodes from both frames
    assert.ok(
      reply.data.nodes.length >= 2,
      "snapshot did not aggregate across frames: " + reply.data.nodes.length,
    );
  });
}

module.exports = groupG;
