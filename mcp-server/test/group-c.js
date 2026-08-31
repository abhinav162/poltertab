const {
  assert,
  backgroundSandbox,
  sleep,
  test,
  waitFor,
} = require("./harness.js");

async function groupC() {
  console.log("\nC. background.js navigation load race");

  await test("C1 navigations do not each attach their own load listener", async () => {
    const bg = backgroundSandbox();
    assert.strictEqual(bg.navListenerCount(), 1, "expected one persistent listener");
    bg.cfg.activeTabs = [];
    bg.cfg.fireOnCompleteFor = 100;
    bg.command({ id: "n1", action: "navigate", url: "http://fast.test/" });
    await waitFor("navigate reply", () => bg.replyFor("n1"), 5000);
    // The second navigation reuses tab 100 via implicit tab tracking rather
    // than opening a new one, so it is tab 100 that completes again.
    bg.command({ id: "n1b", action: "navigate", url: "http://fast.test/" });
    await waitFor("second navigate reply", () => bg.replyFor("n1b"), 5000);
    assert.strictEqual(
      bg.navListenerCount(),
      1,
      "listener count grew per navigation",
    );
  });

  await test("C2 fast page via new tab resolves instead of hanging 30s", async () => {
    const bg = backgroundSandbox();
    bg.cfg.activeTabs = [];
    bg.cfg.fireOnCompleteFor = 100;
    bg.command({ id: "n2", action: "navigate", url: "http://fast.test/" });
    await waitFor("navigate reply", () => bg.replyFor("n2"), 5000);
    const reply = bg.replyFor("n2");
    assert.strictEqual(reply.success, true, JSON.stringify(reply));
    assert.strictEqual(reply.data.tabId, 100);
  });

  // This runs against the user's real browser. navigate used to commandeer
  // whatever tab they were looking at, which is a data-loss-shaped bug dressed
  // up as convenience — and the workaround for it got written into site memory
  // instead of being fixed.
  await test("C3 navigate opens its own tab, then reuses it", async () => {
    const bg = backgroundSandbox();
    bg.cfg.activeTabs = [{ id: 7, url: "http://mine/", title: "the user's tab" }];
    bg.cfg.fireOnCompleteFor = 100; // the tab navigate is about to create

    bg.command({ id: "n3", action: "navigate", url: "http://fast.test/" });
    await waitFor("first navigate", () => bg.replyFor("n3"), 5000);
    assert.strictEqual(bg.replyFor("n3").data.tabId, 100);
    assert.deepStrictEqual(
      bg.updated,
      [],
      "navigated the user's own tab out from under them",
    );
    assert.strictEqual(bg.created.length, 1);

    // ...and the next one must not open another, or a 17-page loop leaves 17
    // tabs behind.
    bg.command({ id: "n3b", action: "navigate", url: "http://second.test/" });
    await waitFor("second navigate", () => bg.replyFor("n3b"), 5000);
    assert.strictEqual(bg.replyFor("n3b").data.tabId, 100);
    assert.strictEqual(bg.created.length, 1, "opened a second tab");
    assert.deepStrictEqual(bg.updated.map((u) => u.id), [100]);
  });

  await test("C5 a loaded page that fired no completion event is not an error", async () => {
    const bg = backgroundSandbox();
    bg.cfg.fireOnCompleteFor = null; // SPA soft-nav, or a suspended worker
    bg.command({ id: "n5", action: "navigate", url: "http://spa.test/" });
    await sleep(50);
    bg.cfg.clockOffset = 31000; // walk past the 30s deadline

    await waitFor("navigate reply", () => bg.replyFor("n5"), 5000);
    const reply = bg.replyFor("n5");
    assert.strictEqual(
      reply.success,
      true,
      `reported a timeout on a page the tab says is loaded: ${reply.error}`,
    );
    assert.strictEqual(reply.data.status, "timeout_but_loaded");
    assert.strictEqual(reply.data.tabId, 100);
  });

  await test("C6 a page that really is still loading still fails", async () => {
    const bg = backgroundSandbox();
    bg.cfg.fireOnCompleteFor = null;
    bg.cfg.tabStatus = "loading";
    bg.command({ id: "n6", action: "navigate", url: "http://slow.test/" });
    await sleep(50);
    bg.cfg.clockOffset = 31000;

    await waitFor("navigate reply", () => bg.replyFor("n6"), 5000);
    const reply = bg.replyFor("n6");
    assert.strictEqual(reply.success, false, "claimed success on a loading tab");
    assert.ok(/timed out/.test(reply.error), reply.error);
    assert.ok(/loading/.test(reply.error), `error should name the real state: ${reply.error}`);
  });

  await test("C4 a load that predates the navigation does not satisfy it", async () => {
    const bg = backgroundSandbox();
    bg.cfg.activeTabs = [{ id: 9, url: "http://old/", title: "old" }];
    bg.cfg.fireOnCompleteFor = null; // this navigation never completes
    bg.fireComplete(9); // ...but the tab completed a load earlier
    await sleep(30);
    bg.command({ id: "n4", action: "navigate", url: "http://fast.test/" });
    await sleep(1200);
    assert.strictEqual(
      bg.replyFor("n4"),
      undefined,
      "resolved on a stale load — would hand back the previous page",
    );
  });
}

module.exports = groupC;
