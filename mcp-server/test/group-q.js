const {
  assert,
  backgroundSandbox,
  fs,
  path,
  REPO,
  test,
  waitFor,
} = require("./harness.js");

// One agent driving several tabs. Every case runs against the REAL
// background.js through the stubbed chrome.* sandbox, and reads targeting back
// through get_url, which answers with the tab it resolved.
async function groupQ() {
  console.log("\nQ. one agent, many tabs");

  let n = 0;
  const call = async (bg, action, params = {}) => {
    const id = `q${n++}`;
    bg.command({ id, action, ...params });
    await waitFor(`${action} reply`, () => bg.replyFor(id), 5000);
    return bg.replyFor(id);
  };
  const ok = async (bg, action, params) => {
    const r = await call(bg, action, params);
    assert.strictEqual(r.success, true, `${action}: ${JSON.stringify(r)}`);
    return r.data;
  };
  const fresh = () => {
    const bg = backgroundSandbox();
    bg.cfg.fireAll = true;
    bg.cfg.activeTabs = [{ id: 7, url: "http://mine/", title: "the user's tab" }];
    return bg;
  };

  await test("Q1 tab_new opens a tab and makes it current", async () => {
    const bg = fresh();
    const a = await ok(bg, "tab_new", { url: "http://a.test/" });
    const b = await ok(bg, "tab_new", { url: "http://b.test/" });
    assert.notStrictEqual(a.tabId, b.tabId);
    assert.strictEqual(b.current, true);
    assert.strictEqual((await ok(bg, "get_url")).tabId, b.tabId);
  });

  await test("Q2 an explicit tabId acts on that tab without moving the pointer", async () => {
    const bg = fresh();
    const a = await ok(bg, "tab_new");
    const b = await ok(bg, "tab_new");
    assert.strictEqual((await ok(bg, "get_url", { tabId: a.tabId })).tabId, a.tabId);
    assert.strictEqual((await ok(bg, "get_url")).tabId, b.tabId);
  });

  await test("Q3 tab_switch moves where untargeted calls land", async () => {
    const bg = fresh();
    const a = await ok(bg, "tab_new");
    await ok(bg, "tab_new");
    await ok(bg, "tab_switch", { tabId: a.tabId });
    assert.strictEqual((await ok(bg, "get_url")).tabId, a.tabId);
    const nav = await ok(bg, "navigate", { url: "http://next.test/" });
    assert.strictEqual(nav.tabId, a.tabId, "navigate left the switched-to tab");
  });

  // The headline bug: an unknown session fell through to the active one, so
  // the second session navigated the first one's tab and both pointed at it.
  await test("Q4 navigate with a second session opens it its own tab", async () => {
    const bg = fresh();
    const a = await ok(bg, "navigate", { url: "http://a.test/", session: "a" });
    const b = await ok(bg, "navigate", { url: "http://b.test/", session: "b" });
    assert.notStrictEqual(a.tabId, b.tabId, "session b took over session a's tab");
    assert.strictEqual((await ok(bg, "get_url", { session: "a" })).tabId, a.tabId);
    assert.strictEqual((await ok(bg, "get_url", { session: "b" })).tabId, b.tabId);
  });

  await test("Q5 an unknown session on a non-navigate call errors instead of borrowing a tab", async () => {
    const bg = fresh();
    await ok(bg, "navigate", { url: "http://a.test/", session: "a" });
    const r = await call(bg, "get_url", { session: "nope" });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /Session "nope" does not exist/);
  });

  await test("Q6 a closed current tab is reported, not swapped for the user's tab", async () => {
    const bg = fresh();
    const a = await ok(bg, "tab_new");
    bg.closeTab(a.tabId); // the user closes it
    const r = await call(bg, "get_url");
    assert.strictEqual(r.success, false, "acted on another tab");
    assert.match(r.error, new RegExp(`tab ${a.tabId}\\) was closed`));
    const ctx = await ok(bg, "session_context");
    assert.strictEqual(ctx.closedTabId, a.tabId);
    // navigate recovers by opening a fresh tab.
    const nav = await ok(bg, "navigate", { url: "http://again.test/" });
    assert.notStrictEqual(nav.tabId, a.tabId);
    assert.strictEqual((await ok(bg, "get_url")).tabId, nav.tabId);
  });

  await test("Q7 an explicit dead tabId gets a clear error", async () => {
    const bg = fresh();
    const a = await ok(bg, "tab_new");
    bg.closeTab(a.tabId);
    const r = await call(bg, "get_url", { tabId: a.tabId });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /closed or does not exist.*browser_tab_list/);
  });

  // One extension serves the Primary and every Secondary. A shared pointer let
  // one agent's call move another's current tab.
  await test("Q8 each agent keeps its own current tab", async () => {
    const bg = fresh();
    const mine = await ok(bg, "tab_new");
    const theirs = await ok(bg, "tab_new", { _client: "node-2" });
    assert.strictEqual((await ok(bg, "get_url")).tabId, mine.tabId);
    assert.strictEqual(
      (await ok(bg, "get_url", { _client: "node-2" })).tabId,
      theirs.tabId,
    );
  });

  await test("Q9 tab_list shows PolterTab's tabs and marks the current one", async () => {
    const bg = fresh();
    const a = await ok(bg, "tab_new");
    const b = await ok(bg, "tab_new", { session: "work" });
    const list = await ok(bg, "tab_list");
    assert.deepStrictEqual(list.tabs.map((t) => t.tabId).sort(), [a.tabId, b.tabId].sort());
    assert.strictEqual(list.current, b.tabId);
    assert.strictEqual(list.tabs.find((t) => t.tabId === b.tabId).session, "work");
    const all = await ok(bg, "tab_list", { all: true });
    assert.ok(all.tabs.some((t) => t.tabId === 7), "all: true left out the user's tab");
  });

  await test("Q10 tab_close closes PolterTab's tabs but refuses the user's", async () => {
    const bg = fresh();
    const a = await ok(bg, "tab_new");
    const refused = await call(bg, "tab_close", { tabId: 7 });
    assert.strictEqual(refused.success, false);
    assert.match(refused.error, /not opened by PolterTab/);

    const closed = await ok(bg, "tab_close"); // default: the current tab
    assert.strictEqual(closed.closed, a.tabId);
    assert.strictEqual(closed.current, null);
    assert.strictEqual((await ok(bg, "tab_list")).count, 0);
    assert.strictEqual((await call(bg, "get_url")).success, false);
  });

  await test("Q11 tab_switch by session, and a session's tab_close drops the session", async () => {
    const bg = fresh();
    const a = await ok(bg, "tab_new", { session: "a" });
    await ok(bg, "tab_new", { session: "b" });
    const sw = await ok(bg, "tab_switch", { session: "a" });
    assert.strictEqual(sw.tabId, a.tabId);
    await ok(bg, "tab_close", { session: "a" });
    const sessions = (await ok(bg, "session_list")).sessions.map((s) => s.name);
    assert.deepStrictEqual(sessions, ["b"]);
  });

  await test("Q12 single-tab use is unchanged: first navigate opens a tab, the rest reuse it", async () => {
    const bg = fresh();
    const first = await ok(bg, "navigate", { url: "http://p1.test/" });
    const second = await ok(bg, "navigate", { url: "http://p2.test/" });
    assert.strictEqual(second.tabId, first.tabId);
    assert.strictEqual(bg.created.length, 1);
    // With nothing navigated, a read still falls back to the user's tab.
    assert.strictEqual((await ok(fresh(), "get_url")).tabId, 7);
  });

  await test("Q13 the bridge stamps the proxying agent instead of injecting a session", () => {
    const src = fs.readFileSync(path.join(REPO, "mcp-server", "bridge.js"), "utf8");
    assert.ok(/_client: ws\.nodeId/.test(src), "proxy path does not stamp _client");
    assert.ok(!/"agent_" \+ nodeId/.test(src), "secondary still injects a session");
  });
  // SB-5 (live MT-20): navigate({tabId}) moved the pointer to that tab, so the
  // agent's next untargeted call landed there — the opposite of what tabId
  // promises on every other tool.
  await test("Q14 navigate with an explicit tabId does not move the pointer", async () => {
    const bg = fresh();
    const a = await ok(bg, "tab_new");
    const b = await ok(bg, "tab_new");
    const nav = await ok(bg, "navigate", { tabId: a.tabId, url: "http://elsewhere.test/" });
    assert.strictEqual(nav.tabId, a.tabId);
    assert.strictEqual((await ok(bg, "get_url")).tabId, b.tabId, "navigate({tabId}) moved the current tab");
  });

}

module.exports = groupQ;
