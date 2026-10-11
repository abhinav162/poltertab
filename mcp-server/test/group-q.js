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

  // SB-3 (live): tab_new on a session whose tab was closed rebound the name
  // to a fresh tab without a word, so the caller could not tell it had lost
  // the old page.
  await test("Q15 tab_new on a session whose tab closed says it replaced it", async () => {
    const bg = fresh();
    const a = await ok(bg, "tab_new", { session: "s", url: "http://old.test/" });
    bg.closeTab(a.tabId);
    const b = await ok(bg, "tab_new", { session: "s", url: "http://new.test/" });
    assert.notStrictEqual(b.tabId, a.tabId);
    assert.strictEqual(b.replacedClosedTab, a.tabId, "no notice that the session's old tab was gone");
    const fresh2 = await ok(bg, "tab_new", { session: "t" });
    assert.strictEqual(fresh2.replacedClosedTab, undefined);
  });

  // SB-4 (live MT-39): a restarted Secondary comes back under a new nodeId and
  // its old pointer stayed in chrome.storage.session forever.
  await test("Q16 a departed agent's empty pointer is pruned, a live one is kept", async () => {
    const bg = fresh();
    const gone = await ok(bg, "tab_new", { _client: "node-gone" });
    await ok(bg, "tab_close", { tabId: gone.tabId, _client: "node-gone" });
    await ok(bg, "tab_new", { _client: "node-idle" });
    bg.cfg.clockOffset = 25 * 60 * 60 * 1000;
    await ok(bg, "tab_new");
    const current = bg.sessionStore.zc_tab_state.current;
    assert.ok(!("node-gone" in current), "dead agent's pointer never pruned");
    assert.ok("node-idle" in current, "an agent still holding a live tab lost its pointer");
    assert.ok("primary" in current);
  });

  // SB-1 / MT-48: a tab adopted via session_create({tabId}) was opened by the
  // user, so tab_close must refuse it without force — but the old guard checked
  // `!name`, which was false for a session, bypassing the check entirely.
  await test("Q17 tab_close refuses an adopted user tab unless force is set", async () => {
    const bg = fresh();
    // Adopt the user's pre-existing tab (id 7, in activeTabs, not owned by PolterTab).
    await ok(bg, "session_create", { session: "u", tabId: 7 });

    // Without force: must refuse with needs_user_permission.
    const refused = await call(bg, "tab_close", { session: "u" });
    assert.strictEqual(refused.success, false, "adopted user tab closed without force");
    assert.match(refused.error, /needs_user_permission/);

    // Session still intact after the refusal (no side-effects on a refused close).
    const ctx = await ok(bg, "session_context", { session: "u" });
    assert.strictEqual(ctx.tabId, 7, "session lost its tab after a refused close");

    // With force: closes successfully.
    const forced = await ok(bg, "tab_close", { session: "u", force: true });
    assert.strictEqual(forced.closed, 7);
    assert.strictEqual(forced.session, "u");
  });

  // SB-1 variant: session_close must apply the same guard as tab_close. Before
  // this fix, close() called chrome.tabs.remove() with no owned/force check, so
  // browser_session_close({name}) silently closed a tab the user had open.
  await test("Q19 session_close refuses an adopted user tab without force", async () => {
    const bg = fresh();
    // Adopt the user's pre-existing tab (id 7, not owned by PolterTab).
    await ok(bg, "session_create", { session: "u", tabId: 7 });

    // Without force: must refuse with needs_user_permission.
    const refused = await call(bg, "session_close", { name: "u" });
    assert.strictEqual(refused.success, false, "session_close closed adopted user tab without force");
    assert.match(refused.error, /needs_user_permission/);

    // Session still intact after the refusal.
    const ctx = await ok(bg, "session_context", {});
    assert.strictEqual(ctx.tabId, 7, "session lost its tab after a refused close");

    // With force: succeeds.
    const forced = await ok(bg, "session_close", { name: "u", force: true });
    assert.strictEqual(forced.closed, "u");
  });

  // S2: screenshot() must not permanently steal focus from the tab the user had
  // active. After capturing, restore the previously focused tab so tab_new(
  // {background:true}) promises are honoured and the user's cursor doesn't jump.
  await test("Q20 screenshot restores the tab that was active before the capture", async () => {
    const bg = fresh();
    const a = await ok(bg, "tab_new", { url: "http://a.test/" });
    const b = await ok(bg, "tab_new", { url: "http://b.test/" });

    // Simulate: the browser has tab A focused (e.g. user clicked it).
    bg.cfg.activeTabs = [{ id: a.tabId, url: "http://a.test/", title: "A" }];

    const before = bg.updated.length;
    await ok(bg, "screenshot", { tabId: b.tabId }); // capture tab B, not active
    const after = bg.updated.slice(before);

    // Must have restored A as the active tab.
    assert.ok(
      after.some((u) => u.id === a.tabId),
      "screenshot did not restore the previously active tab",
    );
  });

  // N6: two commands that wake the service worker at the same time both call
  // load() before it finishes. Without memoization the second call enters the
  // load body independently and can overwrite in-memory mutations made by the
  // first. The fix makes load() return the same promise for every concurrent
  // caller.
  await test("Q23 concurrent tab_new calls both complete without clobbering each other", async () => {
    const bg = fresh();
    const id1 = `q${n++}`;
    const id2 = `q${n++}`;
    // Fire both without awaiting — both handlers start before either completes load().
    bg.command({ id: id1, action: "tab_new", url: "http://a.test/" });
    bg.command({ id: id2, action: "tab_new", url: "http://b.test/" });
    await waitFor("concurrent tab_new 1", () => bg.replyFor(id1), 5000);
    await waitFor("concurrent tab_new 2", () => bg.replyFor(id2), 5000);
    assert.strictEqual(bg.replyFor(id1).success, true, "first concurrent tab_new failed");
    assert.strictEqual(bg.replyFor(id2).success, true, "second concurrent tab_new failed");
    assert.notStrictEqual(
      bg.replyFor(id1).data.tabId,
      bg.replyFor(id2).data.tabId,
      "both concurrent tab_new returned the same tabId",
    );
  });

  // MT-15: tab_close on a tabId Chrome does not have must return tab_not_found,
  // not silently succeed. MT-16 (a tab PolterTab opened, then Chrome closed)
  // collapses into the same error because we cannot distinguish them without
  // persisting a "ever-owned" set; both now return tab_not_found.
  await test("Q18 tab_close on a non-alive tabId returns tab_not_found", async () => {
    const bg = fresh();
    const a = await ok(bg, "tab_new");

    // Chrome closes the tab externally (e.g. user closes it).
    bg.closeTab(a.tabId);

    const r = await call(bg, "tab_close", { tabId: a.tabId });
    assert.strictEqual(r.success, false, "closed tab should return tab_not_found error");
    assert.match(r.error, /tab_not_found/);

    // Current tab pointer and other tools must be unaffected.
    const b = await ok(bg, "tab_new", { url: "http://other.test/" });
    assert.ok(b.tabId, "tab_new still works after a failed tab_close");
  });
}

module.exports = groupQ;
