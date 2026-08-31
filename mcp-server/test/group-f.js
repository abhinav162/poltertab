const {
  assert,
  fakeEl,
  fakeField,
  fakeRoot,
  shadowSandbox,
  test,
} = require("./harness.js");

// ───────────────── F. fill across field types ─────────────────

async function groupF() {
  console.log("\nF. fill across field types");

  await test("F1 fills a <textarea> (was: Illegal invocation)", async () => {
    const ta = fakeField("textarea", { id: "chat" });
    const s = shadowSandbox({ lightDescendants: [ta] });
    const res = await s.send("fill", { selector: "#chat", value: "hello" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(ta.value, "hello");
  });

  await test("F2 still fills an <input>", async () => {
    const inp = fakeField("input", { id: "q" });
    const s = shadowSandbox({ lightDescendants: [inp] });
    const res = await s.send("fill", { selector: "#q", value: "typed" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(inp.value, "typed");
  });

  await test("F3 fills a contenteditable composer", async () => {
    const div = fakeField("div", { id: "composer", contentEditable: true });
    const s = shadowSandbox({ lightDescendants: [div] });
    const res = await s.send("fill", { selector: "#composer", value: "rich" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(div.textContent, "rich");
  });

  await test("F4 dispatches input and change so frameworks notice", async () => {
    const inp = fakeField("input", { id: "q" });
    const s = shadowSandbox({ lightDescendants: [inp] });
    await s.send("fill", { selector: "#q", value: "x" });
    assert.deepStrictEqual(inp.events, ["input", "change"]);
  });

  await test("F5 fills a textarea nested in a shadow root", async () => {
    const ta = fakeField("textarea", { id: "deep-chat" });
    const host = fakeEl("div", { shadow: fakeRoot([ta]) });
    const s = shadowSandbox({ lightDescendants: [host] });
    const res = await s.send("fill", { selector: "#deep-chat", value: "deep" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(ta.value, "deep");
  });
}

module.exports = groupF;
