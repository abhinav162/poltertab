const { assert, fakeEl, fakeField, shadowSandbox, test } = require("./harness.js");

// ───────────── N. self-healing selectors (fingerprint relocation) ─────────────
//
// When a stored selector stops matching (the site changed an id/class), the
// caller can pass back the fingerprint a previous call returned; resolveElement
// relocates the element by structural similarity instead of failing.

async function groupN() {
  console.log("\nN. self-healing selectors");

  await test("N1 heals a stale selector using a returned fingerprint", async () => {
    const btn = fakeEl("button", { id: "submit", text: "Submit", attrs: { name: "go" } });
    const s = shadowSandbox({ lightDescendants: [btn] });

    // 1. a normal click hands back the element's fingerprint
    const first = await s.send("click", { selector: "#submit" });
    assert.strictEqual(first.success, true, first.error);
    assert.ok(first.data.fingerprint, "click should return a fingerprint");

    // 2. the site is redesigned: same button, new id
    btn.id = "submit-v2";

    // 3. the old selector now misses; the fingerprint relocates it
    const second = await s.send("click", {
      selector: "#submit",
      fingerprint: first.data.fingerprint,
    });
    assert.strictEqual(second.success, true, second.error);
    assert.strictEqual(second.data.healed, true, "should report it healed");
    assert.strictEqual(btn.clicks, 2, "healed click did not reach the element");
  });

  await test("N2 fill heals a drifted field the same way", async () => {
    const inp = fakeField("input", { id: "email", attrs: { name: "email", type: "email" } });
    const s = shadowSandbox({ lightDescendants: [inp] });

    const first = await s.send("fill", { selector: "#email", value: "a@b.com" });
    assert.ok(first.data.fingerprint, "fill should return a fingerprint");

    inp.id = "email-2"; // redesigned
    const second = await s.send("fill", {
      selector: "#email",
      value: "c@d.com",
      fingerprint: first.data.fingerprint,
    });
    assert.strictEqual(second.success, true, second.error);
    assert.strictEqual(second.data.healed, true);
    assert.strictEqual(inp.value, "c@d.com");
  });

  await test("N3 refuses to heal when nothing is similar enough", async () => {
    // Only a wildly different element is present; a bad match must not be forced.
    const btn = fakeEl("button", { id: "only", text: "Totally Different", attrs: { name: "xyz" } });
    const s = shadowSandbox({ lightDescendants: [btn] });
    const fp = {
      tag: "input",
      text: "Email address",
      attrs: { id: "email", name: "email", type: "email" },
      siblingTags: [],
      parent: {},
    };
    const res = await s.send("click", { selector: "#missing", fingerprint: fp });
    assert.strictEqual(res.success, false);
    assert.ok(/not found/i.test(res.error), res.error);
    assert.strictEqual(btn.clicks, 0, "healed onto a dissimilar element");
  });

  await test("N4 relocates to the best match, not just any match", async () => {
    const near = fakeEl("button", { id: "save-btn", text: "Save", attrs: { name: "save" } });
    const far = fakeEl("a", { id: "home", text: "Home" });
    const s = shadowSandbox({ lightDescendants: [far, near] });
    const fp = {
      tag: "button",
      text: "Save",
      attrs: { id: "save", name: "save" },
      siblingTags: [],
      parent: {},
    };
    const res = await s.send("click", { selector: "#save", fingerprint: fp });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(near.clicks, 1, "did not pick the closest match");
    assert.strictEqual(far.clicks, 0, "picked a worse match");
  });

  await test("N5 a decoy whose text equals the selector never shadows healing", async () => {
    // A visible <code>#save-btn</code> hint has textContent exactly "#save-btn".
    // The text-equality fallback used to return it, so a drifted selector never
    // reported a miss and healing never ran.
    const decoy = fakeEl("code", { text: "#save-btn" });
    const btn = fakeEl("button", { id: "save-btn", text: "Save changes", attrs: { name: "save" } });
    const s = shadowSandbox({ lightDescendants: [decoy, btn] });

    const first = await s.send("click", { selector: "#save-btn" });
    assert.strictEqual(first.data.tag, "button", "matched the decoy before any drift");

    btn.id = "save-btn-v2"; // redesigned
    const second = await s.send("click", {
      selector: "#save-btn",
      fingerprint: first.data.fingerprint,
    });
    assert.strictEqual(second.data.tag, "button", "healed onto the <code> decoy");
    assert.strictEqual(second.data.healed, true);
    assert.strictEqual(btn.clicks, 2);
    assert.strictEqual(decoy.clicks, 0);
  });

  await test("N6 a decoy text match does not mask a genuine miss", async () => {
    const decoy = fakeEl("code", { text: "#gone" });
    const s = shadowSandbox({ lightDescendants: [decoy] });
    const res = await s.send("click", { selector: "#gone" }); // no fingerprint
    assert.strictEqual(res.success, false, "returned the decoy instead of not-found");
    assert.ok(/not found/i.test(res.error), res.error);
    assert.strictEqual(decoy.clicks, 0);
  });
  await test("N7 the fast frame probe never heals (it would act in every frame)", async () => {
    // background.js probes ALL child frames in parallel with _noWait and the
    // content script *performs* the action wherever it resolves. Fingerprint
    // matching resolves in far more places than a selector, so healing on the
    // probe pass could click "Send" in three frames at once.
    const btn = fakeEl("button", { id: "send-v2", text: "Send", attrs: { name: "send" } });
    const s = shadowSandbox({ lightDescendants: [btn] });
    const fp = {
      tag: "button", text: "Send", attrs: { id: "send", name: "send" },
      siblingTags: [], parent: {},
    };
    const res = await s.send("click", { selector: "#send", fingerprint: fp, _noWait: true });
    assert.strictEqual(res.success, false, "healed during the fast probe");
    assert.strictEqual(btn.clicks, 0);
  });

  await test("N8 refuses to heal when two candidates match equally well", async () => {
    // A table of identical row buttons: every one scores the same after a class
    // rename, so "highest score wins" is a coin flip on which row gets deleted.
    const mk = () =>
      fakeEl("button", { text: "Delete", attrs: { class: "row-del", name: "del" } });
    const row1 = mk();
    const row2 = mk();
    const s = shadowSandbox({ lightDescendants: [row1, row2] });
    // Scores ~0.9 against BOTH rows — comfortably over the threshold, so this
    // exercises ambiguity rather than passing because nothing matched.
    const fp = {
      tag: "button", text: "Delete", attrs: { class: "row-del", name: "del" },
      siblingTags: [], parent: {},
    };
    const res = await s.send("click", { selector: ".row-del", fingerprint: fp });
    assert.strictEqual(res.success, false, "picked one of two identical candidates");
    assert.strictEqual(row1.clicks + row2.clicks, 0);
  });

  await test("N9 the stored fingerprint is the element as it was BEFORE the click", async () => {
    // A Follow button becomes "Following" the moment it is clicked. Capturing
    // the fingerprint in the return statement stored the post-click text, so the
    // next run scored against a label that no longer matches and the heal this
    // feature exists for failed.
    const btn = fakeEl("button", { id: "follow", text: "Follow" });
    const base = btn.dispatchEvent;
    btn.dispatchEvent = (e) => {
      const r = base(e);
      if (e.type === "click") btn.textContent = "Following";
      return r;
    };
    const s = shadowSandbox({ lightDescendants: [btn] });
    const res = await s.send("click", { selector: "#follow" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(
      res.data.fingerprint.text,
      "Follow",
      "stored the post-click label",
    );
  });

  await test("N10 an SVG class does not fingerprint as [object SVGAnimatedString]", async () => {
    // el.className on an SVG is an SVGAnimatedString: truthy, so it short-
    // circuited the getAttribute fallback and every SVG stored the same
    // stringified object — making unrelated icons look near-identical.
    const icon = fakeEl("svg", { id: "trash", attrs: { class: "icon-trash" } });
    icon.className = { baseVal: "icon-trash", animVal: "icon-trash" };
    const s = shadowSandbox({ lightDescendants: [icon] });
    const res = await s.send("click", { selector: "#trash" });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(res.data.fingerprint.attrs.class, "icon-trash");
  });

}

module.exports = groupN;
