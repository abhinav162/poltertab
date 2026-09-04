const {
  assert,
  fakeEl,
  fakeRoot,
  path,
  shadowSandbox,
  test,
} = require("./harness.js");

async function groupE() {
  console.log("\nE. shadow DOM piercing + late-element retry");

  await test("E1 clicks an element two nested open shadow roots deep", async () => {
    const deep = fakeEl("button", { id: "deep", text: "DEEP" });
    const innerHost = fakeEl("div", { id: "inner", shadow: fakeRoot([deep]) });
    const outerHost = fakeEl("div", { id: "outer", shadow: fakeRoot([innerHost]) });
    const s = shadowSandbox({ lightDescendants: [outerHost] });
    const res = await s.send("click", { selector: "#deep" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(deep.clicks, 1, "deep element was not clicked");
  });

  await test("E2 reaches a CLOSED shadow root via chrome.dom", async () => {
    const deep = fakeEl("button", { id: "sealed" });
    const host = fakeEl("div", { closedShadow: fakeRoot([deep]) });
    const s = shadowSandbox({ lightDescendants: [host] });
    const res = await s.send("click", { selector: "#sealed" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(deep.clicks, 1, "closed root was not pierced");
  });

  await test("E3 without chrome.dom, a closed root stays unreachable", async () => {
    const deep = fakeEl("button", { id: "sealed" });
    const host = fakeEl("div", { closedShadow: fakeRoot([deep]) });
    const s = shadowSandbox({ chromeDom: false, lightDescendants: [host] });
    const res = await s.send("click", { selector: "#sealed" });
    assert.strictEqual(res.success, false, "should not resolve without chrome.dom");
    assert.strictEqual(deep.clicks, 0);
  });

  await test("E4 light DOM wins: a light match never traverses shadow roots", async () => {
    const target = fakeEl("button", { id: "here" });
    const shadowChild = fakeEl("button", { id: "elsewhere" });
    const host = fakeEl("div", { shadow: fakeRoot([shadowChild]) });
    const s = shadowSandbox({ lightDescendants: [target, host] });
    const res = await s.send("click", { selector: "#here" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(target.clicks, 1);
    assert.strictEqual(
      s.queried.length,
      1,
      `traversed ${s.queried.length} roots for a light-DOM hit`,
    );
  });

  await test("E5 a self-referential host cannot hang the page", async () => {
    const host = fakeEl("div", { id: "loop" });
    host.shadowRoot = fakeRoot([host]); // points back at itself
    const s = shadowSandbox({ lightDescendants: [host] });
    const started = Date.now();
    const res = await s.send("click", { selector: "#nope" });
    assert.strictEqual(res.success, false);
    assert.ok(
      Date.now() - started < 12000,
      `took ${Date.now() - started}ms — depth cap missing?`,
    );
  });

  await test("E6 waits for a late-rendering modal instead of failing instantly", async () => {
    const late = fakeEl("button", { id: "modal-btn" });
    const present = [];
    const s = shadowSandbox({ lightDescendants: present });
    setTimeout(() => present.push(late), 400); // portal mounts after the click
    const res = await s.send("click", { selector: "#modal-btn" });
    assert.strictEqual(res.success, true, `gave up too early: ${res.error}`);
    assert.strictEqual(late.clicks, 1);
  });

  await test("E7 a genuinely absent element still reports not found", async () => {
    const s = shadowSandbox({ lightDescendants: [] });
    const res = await s.send("click", { selector: "#ghost" });
    assert.strictEqual(res.success, false);
    assert.ok(/not found/i.test(res.error), res.error);
  });

  await test("E8 scrape reaches into shadow roots too", async () => {
    const deep = fakeEl("span", { id: "val", text: "shadow value" });
    const host = fakeEl("div", { shadow: fakeRoot([deep]) });
    const s = shadowSandbox({ lightDescendants: [host] });
    const res = await s.send("scrape", { selector: "#val" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(res.data.length, 1, "scrape stayed light-DOM only");
    assert.strictEqual(res.data[0].text, "shadow value");
  });

  await test("E9 an @e ref from a snapshot resolves to the element it was stamped on", async () => {
    // SKILL.md tells the agent to prefer a snapshot ref over a generated class
    // chain, and snapshot hands back "@e3" for every node. But "@e3" is not
    // valid CSS, not valid XPath and matches no text, so it fell through every
    // strategy and threw "Element not found" — the documented path never worked.
    const target = fakeEl("button", { attrs: { "data-zc-ref": "@e3" } });
    const other = fakeEl("button", { attrs: { "data-zc-ref": "@e1" } });
    const s = shadowSandbox({ lightDescendants: [other, target] });
    const res = await s.send("click", { selector: "@e3" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(target.clicks, 1, "@e ref did not resolve to its element");
    assert.strictEqual(other.clicks, 0, "@e ref hit the wrong element");
  });

  await test("E10 an @e ref reaches through a shadow root", async () => {
    const deep = fakeEl("button", { attrs: { "data-zc-ref": "@e7" } });
    const host = fakeEl("div", { shadow: fakeRoot([deep]) });
    const s = shadowSandbox({ lightDescendants: [host] });
    const res = await s.send("click", { selector: "@e7" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(deep.clicks, 1, "ref lookup stopped at the light DOM");
  });

  await test("E11 a bare @-string that is not a ref is not treated as one", async () => {
    // Guard the translation's blast radius: only @e<digits> is a ref.
    const el = fakeEl("button", { attrs: { "data-zc-ref": "@email" } });
    const s = shadowSandbox({ lightDescendants: [el] });
    const res = await s.send("click", { selector: "@email" });
    assert.strictEqual(res.success, false, "@email was rewritten as a ref selector");
  });
}

module.exports = groupE;
