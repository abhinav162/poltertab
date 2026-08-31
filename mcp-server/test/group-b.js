const {
  assert,
  contentScriptSandbox,
  test,
} = require("./harness.js");

async function groupB() {
  console.log("\nB. content_script injection idempotence");

  await test("B1 one injection registers exactly one command listener", () => {
    const s = contentScriptSandbox();
    s.inject();
    assert.strictEqual(s.counts().commandListeners, 1);
  });

  await test("B2 six injections still leave one command listener", () => {
    const s = contentScriptSandbox();
    for (let i = 0; i < 6; i++) s.inject();
    const c = s.counts();
    assert.strictEqual(c.commandListeners, 1, `got ${c.commandListeners}`);
  });

  await test("B3 six injections inject the interceptor exactly once", () => {
    const s = contentScriptSandbox();
    for (let i = 0; i < 6; i++) s.inject();
    const c = s.counts();
    assert.strictEqual(c.interceptors, 1, `got ${c.interceptors} interceptors`);
    assert.strictEqual(c.messageListeners, 1, `got ${c.messageListeners} forwarders`);
  });

  await test("B4 one click command produces exactly one click (was 2, 5, 9...)", async () => {
    const s = contentScriptSandbox();
    const observed = [];
    for (let n = 1; n <= 3; n++) {
      s.inject(); // background.js re-injects before every DOM command
      await s.dispatch({
        source: "poltertab",
        action: "click",
        params: { selector: "#inc" },
      });
      observed.push(s.counts().clicks);
    }
    assert.deepStrictEqual(
      observed,
      [1, 2, 3],
      `cumulative clicks ${observed.join(",")} — expected 1,2,3`,
    );
  });

  await test("B5 a real page load clears the sentinel and re-registers", () => {
    const s1 = contentScriptSandbox();
    s1.inject();
    s1.inject();
    const s2 = contentScriptSandbox(); // fresh document == fresh isolated world
    s2.inject();
    assert.strictEqual(s2.counts().commandListeners, 1, "new document must register");
  });
}

module.exports = groupB;
