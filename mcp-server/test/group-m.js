const {
  assert,
  fakeEl,
  fakeField,
  fakeRoot,
  shadowSandbox,
  test,
} = require("./harness.js");

// ─────────────── M. actionability gate (click / fill) ───────────────
//
// Resolving a selector is not enough: an element can be present but hidden,
// disabled, or under an overlay that eats the click. The old click() fired on
// the node regardless and "succeeded" on the wrong target. The gate now checks
// visible + enabled + hit-test before acting, and reports which one failed.

async function groupM() {
  console.log("\nM. actionability gate (click / fill)");

  await test("M1 a normal element clicks (gate is transparent)", async () => {
    const btn = fakeEl("button", { id: "go" });
    const s = shadowSandbox({ lightDescendants: [btn] });
    const res = await s.send("click", { selector: "#go" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(btn.clicks, 1);
  });

  await test("M2 a hidden element is not clicked (not visible)", async () => {
    const btn = fakeEl("button", { id: "ghost", hidden: true });
    const s = shadowSandbox({ lightDescendants: [btn] });
    const res = await s.send("click", { selector: "#ghost" });
    assert.strictEqual(res.success, false);
    assert.ok(/not visible/i.test(res.error), res.error);
    assert.strictEqual(btn.clicks, 0);
  });

  await test("M3 a disabled element is not clicked", async () => {
    const btn = fakeEl("button", { id: "off", disabled: true });
    const s = shadowSandbox({ lightDescendants: [btn] });
    const res = await s.send("click", { selector: "#off" });
    assert.strictEqual(res.success, false);
    assert.ok(/disabled/i.test(res.error), res.error);
    assert.strictEqual(btn.clicks, 0);
  });

  await test("M4 an overlay-covered element is not clicked (hit-test)", async () => {
    const overlay = fakeEl("div", { id: "modal" });
    const btn = fakeEl("button", { id: "under", coveredBy: overlay });
    const s = shadowSandbox({ lightDescendants: [btn, overlay] });
    const res = await s.send("click", { selector: "#under" });
    assert.strictEqual(res.success, false);
    assert.ok(/covered/i.test(res.error), res.error);
    assert.strictEqual(btn.clicks, 0, "clicked through an overlay");
  });

  await test("M5 waits for an overlay to clear, then clicks", async () => {
    const overlay = fakeEl("div", { id: "modal2" });
    const btn = fakeEl("button", { id: "reveal", coveredBy: overlay });
    const s = shadowSandbox({ lightDescendants: [btn, overlay] });
    setTimeout(() => (btn.__coveredBy = null), 200); // banner dismissed late
    const res = await s.send("click", { selector: "#reveal" });
    assert.strictEqual(res.success, true, `gave up before the overlay cleared: ${res.error}`);
    assert.strictEqual(btn.clicks, 1);
  });

  await test("M6 fill skips the hit-test: a covered input still fills", async () => {
    const overlay = fakeEl("div", { id: "veil" });
    const inp = fakeField("input", { id: "q", coveredBy: overlay });
    const s = shadowSandbox({ lightDescendants: [inp, overlay] });
    const res = await s.send("fill", { selector: "#q", value: "typed" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(inp.value, "typed");
  });

  await test("M8 clicks an element inside a shadow root (hit-test retargets)", async () => {
    // document.elementFromPoint reports the shadow HOST, and Node.contains does
    // not cross the boundary — so a document-level hit-test can never confirm a
    // shadow element and rejected every one as "covered".
    const deep = fakeEl("button", { id: "deep" });
    const host = fakeEl("div", { id: "host", shadow: fakeRoot([deep]) });
    const s = shadowSandbox({ lightDescendants: [host] });
    const res = await s.send("click", { selector: "#deep" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(deep.clicks, 1, "shadow element was not clicked");
  });

  await test("M9 an off-screen element is scrolled to before it is hit-tested", async () => {
    // scrollIntoView({behavior:"smooth"}) has not moved the element by the time
    // the gate's first synchronous check runs, so the hit-test read stale
    // off-viewport coordinates and reported "covered"/"not visible".
    const btn = fakeEl("button", { id: "below", offscreen: true });
    const s = shadowSandbox({ lightDescendants: [btn] });
    const res = await s.send("click", { selector: "#below", _noWait: true });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(btn.clicks, 1);
  });

  await test("M7 fill still refuses a disabled input", async () => {
    const inp = fakeField("input", { id: "ro", disabled: true });
    const s = shadowSandbox({ lightDescendants: [inp] });
    const res = await s.send("fill", { selector: "#ro", value: "nope" });
    assert.strictEqual(res.success, false);
    assert.ok(/disabled/i.test(res.error), res.error);
    assert.strictEqual(inp.value, "");
  });
}

module.exports = groupM;
