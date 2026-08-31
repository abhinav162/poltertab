#!/usr/bin/env node
// PolterTab regression suite. Covers both halves of the project:
//   A  source invariants that are cheap to assert and easy to regress
//   B  content_script.js injection idempotence   (the N-clicks-per-command bug)
//   C  background.js navigation load race        (the 30s hang on fast pages)
//   D  mcp-server end-to-end over stdio          (output_file, stdout purity)
//   E  shadow DOM piercing + late-element retry  (the OCI-console class of bug)
//   I  record-scoped extraction                  (the field-shift / silent-empty bugs)
//   J  the pagination loop                       (halt conditions, CSV output)
//   K  benchmark-run regressions                 (site-memory lookup, output paths)
//   L  bridge handshake origin check             (the drive-by extension takeover)
//
// Run: node mcp-server/test/run.js
// No framework on purpose — plain asserts, one file, real processes.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..", "..");
const EXT = path.join(REPO, "chrome-extension");
const SERVER = path.join(REPO, "mcp-server", "index.js");
const PORT = 7931;
const TAB = 42;

// Servers under test get a disposable POLTERTAB_HOME. Previously these tests
// wrote into the real mcp-server/downloads and then rmSync'd it, which deleted
// whatever the user had actually scraped.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "poltertab-suite-"));
const DOWNLOADS = path.join(HOME, "downloads");

let pass = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL  ${name}\n          ${err.message.split("\n")[0]}`);
    failures.push(name);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ───────────────────────── A. source invariants ─────────────────────────

async function groupA() {
  console.log("\nA. source invariants");

  await test("A1 manifest declares an options page that exists", () => {
    const m = JSON.parse(
      fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"),
    );
    const page = m.options_page || (m.options_ui && m.options_ui.page);
    assert.ok(page, "no options_page/options_ui — openOptionsPage() will throw");
    assert.ok(
      fs.existsSync(path.join(EXT, page)),
      `options page ${page} missing on disk`,
    );
  });

  await test("A2 mcp-server never writes to stdout (it is the JSON-RPC channel)", () => {
    const src = fs.readFileSync(SERVER, "utf8");
    const hits = src.split("\n").filter((l) => /(^|[^.\w])console\.log\(/.test(l));
    assert.strictEqual(
      hits.length,
      0,
      `console.log would corrupt the protocol stream: ${hits.join(" | ")}`,
    );
  });

  await test("A4 README documents every tool the server exposes, and no others", () => {
    const idx = fs.readFileSync(SERVER, "utf8");
    const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
    const tools = [...idx.matchAll(/name:\s*"(browser_[a-z_]+)"/g)].map((m) => m[1]);
    const mentioned = new Set(readme.match(/browser_[a-z_]+/g) || []);
    assert.ok(tools.length >= 21, `only found ${tools.length} tools in the server`);
    const undocumented = tools.filter((t) => !mentioned.has(t));
    assert.deepStrictEqual(undocumented, [], `undocumented tools: ${undocumented}`);
    const bogus = [...mentioned].filter((m) => !tools.includes(m));
    assert.deepStrictEqual(bogus, [], `README names non-existent tools: ${bogus}`);
  });

  await test("A7 the skill names the extraction tools, and no phantom ones", () => {
    // The skill is what an agent reads before working a site. New tools that
    // never reach it are new tools nobody uses: the agent takes the
    // flat-scrape-and-reassemble route these exist to replace.
    const skill = fs.readFileSync(
      path.join(REPO, "skills", "browser-navigation-strategy", "SKILL.md"),
      "utf8",
    );
    const idx = fs.readFileSync(SERVER, "utf8");
    const tools = new Set(
      [...idx.matchAll(/name:\s*"(browser_[a-z_]+)"/g)].map((m) => m[1]),
    );
    const named = new Set(skill.match(/browser_[a-z_]+/g) || []);
    for (const must of ["browser_extract", "browser_extract_all"]) {
      assert.ok(named.has(must), `skill never mentions ${must}`);
    }
    const phantom = [...named].filter((n) => !tools.has(n));
    assert.deepStrictEqual(phantom, [], `skill names non-existent tools: ${phantom}`);
  });

  await test("A5 README does not claim the server exits on a busy port", () => {
    const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
    assert.ok(
      !/will exit with an `?EADDRINUSE/.test(readme),
      "stale claim: a busy port now means secondary mode, not an exit",
    );
  });

  await test("A6 snapshot descends into shadow roots so elements are discoverable", () => {
    const src = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");
    const walk = src.slice(src.indexOf("const walk = (el, depth)"));
    assert.ok(
      /shadowRootOf\(el\)/.test(walk.slice(0, 900)),
      "snapshot's walk no longer descends into shadow roots",
    );
  });

  await test("A8 the ref snapshot stamps is the ref resolveElement accepts", () => {
    // Two halves of one contract in one file, 160 lines apart. If snapshot's
    // prefix changes and the resolver's regex does not, every ref silently
    // stops resolving again — which is exactly how it shipped broken.
    const src = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");
    assert.ok(
      /setAttribute\("data-zc-ref", ref\)/.test(src),
      "snapshot no longer stamps data-zc-ref",
    );
    assert.ok(
      /"@e"\s*\+\s*\+\+counter/.test(src),
      "snapshot's ref is no longer @e<n>",
    );
    assert.ok(
      /\/\^@e\\d\+\$\/\.test\(selector\)/.test(src),
      "resolveElement no longer translates an @e ref",
    );
    assert.ok(
      /\[data-zc-ref="\$\{selector\}"\]/.test(src),
      "the ref is translated to some other attribute than the one stamped",
    );
  });

  await test("A9 the interceptor posts no synthetic startup record", () => {
    // TEST_INIT travelled content script → background → server and landed in
    // networkState as a real captured request, so every get_network_state on a
    // freshly loaded tab returned a fake entry that also ate the 500-cap.
    const src = fs.readFileSync(path.join(EXT, "interceptor.js"), "utf8");
    const posts = [...src.matchAll(/postMessage\(/g)];
    assert.ok(!/TEST_INIT/.test(src), "the TEST_INIT debug record is back");
    assert.strictEqual(
      posts.length,
      2,
      "interceptor should postMessage only from the fetch and XHR paths",
    );
  });

  await test("A3 content_script guards re-execution before registering anything", () => {
    const src = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");
    const guard = src.indexOf("__polterTabInjected");
    const listener = src.indexOf("addEventListener");
    const onMessage = src.indexOf("onMessage.addListener");
    assert.ok(guard !== -1, "no injection sentinel");
    assert.ok(guard < listener, "sentinel must precede window listeners");
    assert.ok(guard < onMessage, "sentinel must precede the command listener");
  });
}

// ────────────── B. content_script injection idempotence ──────────────

function contentScriptSandbox() {
  let clicks = 0;
  const appended = [];
  const messageListeners = [];
  const commandListeners = [];

  const el = {
    tagName: "BUTTON",
    scrollIntoView() {},
    dispatchEvent(e) {
      if (e.type === "click") clicks++;
      return true;
    },
  };

  const document = {
    title: "T",
    createElement: () => ({ set src(v) {}, get src() { return ""; }, remove() {} }),
    documentElement: { appendChild: (n) => appended.push(n) },
    head: { appendChild: (n) => appended.push(n) },
    querySelector: (sel) => (sel === "#inc" ? el : null),
    querySelectorAll: () => [],
    body: { innerText: "" },
  };

  const sandbox = {
    console: { log() {}, error() {} },
    setTimeout,
    clearTimeout,
    document,
    location: { href: "http://t/" },
    MouseEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    chrome: {
      runtime: {
        getURL: (p) => `chrome-extension://x/${p}`,
        sendMessage: () => Promise.resolve(),
        onMessage: { addListener: (fn) => commandListeners.push(fn) },
      },
      storage: { local: { get: (_k, cb) => cb && cb({}) } },
    },
    addEventListener: (_t, fn) => messageListeners.push(fn),
  };

  vm.createContext(sandbox);
  sandbox.window = sandbox;

  const code = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");
  return {
    inject: () => vm.runInContext(code, sandbox),
    counts: () => ({
      clicks,
      interceptors: appended.length,
      messageListeners: messageListeners.length,
      commandListeners: commandListeners.length,
    }),
    // Mirrors Chrome: every registered listener receives the message. Handlers
    // reply asynchronously now, so wait for each sendResponse.
    dispatch: async (msg) => {
      let responses = 0;
      await Promise.all(
        commandListeners.map(
          (fn) =>
            new Promise((resolve) =>
              fn(msg, {}, () => {
                responses++;
                resolve();
              }),
            ),
        ),
      );
      return responses;
    },
  };
}

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

// ─────────────── C. background.js navigation load race ───────────────

function backgroundSandbox() {
  const cfg = {
    activeTabs: [],
    fireOnCompleteFor: null, // tabId to complete immediately, or null for none
    nextTabId: 100,
    // Lets a test walk past a 30s deadline without waiting 30s for it.
    clockOffset: 0,
    // What chrome.tabs.get reports, so "loaded but no completion event" and
    // "genuinely still loading" can be told apart.
    tabStatus: "complete",
  };
  const created = [];
  const updated = [];
  const sent = [];
  const navListeners = [];
  const removedListeners = [];
  const sockets = [];

  const fireComplete = (tabId) => {
    for (const fn of navListeners) fn({ tabId, frameId: 0 });
  };
  const maybeFire = (tabId) => {
    // Simulates a fast page: the load finishes before the caller could have
    // attached a per-navigation listener.
    if (cfg.fireOnCompleteFor === tabId) fireComplete(tabId);
  };

  const tab = (id) => ({
    id,
    url: "http://fast.test/",
    title: "Fast",
    status: cfg.tabStatus,
  });

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    JSON,
    // Deadlines are measured with Date.now(), so an offset the test controls is
    // how a 30s timeout gets exercised in well under a second.
    Date: class extends Date {
      static now() {
        return Date.now() + cfg.clockOffset;
      }
    },
    Math,
    Promise,
    Error,
    Object,
    WebSocket: class {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        sockets.push(this);
      }
      send(data) {
        sent.push(JSON.parse(data));
      }
      close() {}
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: "test" }),
        sendMessage: () => Promise.resolve(),
        onMessage: { addListener() {} },
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} },
      },
      alarms: {
        get: (_n, cb) => cb && cb(null),
        create() {},
        clear() {},
        onAlarm: { addListener() {} },
      },
      storage: {
        local: {
          get: (keys, cb) => (cb ? cb({}) : Promise.resolve({})),
          set: (_o, cb) => (cb ? cb() : Promise.resolve()),
        },
        onChanged: { addListener() {} },
      },
      tabs: {
        get: async (id) => tab(id),
        create: async (props) => {
          const id = cfg.nextTabId++;
          created.push({ id, url: props.url });
          const t = { ...tab(id), url: props.url || "about:blank" };
          maybeFire(id);
          return t;
        },
        update: async (id, props) => {
          updated.push({ id, url: props.url });
          const t = { ...tab(id), url: props.url };
          maybeFire(id);
          return t;
        },
        query: async () => cfg.activeTabs,
        remove: async () => {},
        group: async () => 1,
        sendMessage: async () => ({ success: true }),
        onRemoved: { addListener: (fn) => removedListeners.push(fn) },
        onUpdated: { addListener() {} },
      },
      tabGroups: {
        get: async () => ({ id: 1 }),
        query: async () => [],
        update: async () => {},
      },
      webNavigation: {
        onCompleted: {
          addListener: (fn) => navListeners.push(fn),
          removeListener: (fn) => {
            const i = navListeners.indexOf(fn);
            if (i !== -1) navListeners.splice(i, 1);
          },
        },
      },
      scripting: { executeScript: async () => [] },
    },
  };

  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), sandbox);

  const ws = sockets[0];
  ws.onopen && ws.onopen();

  return {
    cfg,
    created,
    updated,
    fireComplete,
    navListenerCount: () => navListeners.length,
    command: (msg) => ws.onmessage({ data: JSON.stringify(msg) }),
    replyFor: (id) => sent.find((m) => m.id === id),
  };
}

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

// ──────────────── D. mcp-server end-to-end over stdio ────────────────

function startServer(opts = {}) {
  // Update checks are off unless a test opts in. Otherwise every run would hit
  // the real registry, and the moment this repo's version fell behind the
  // published one, a notice would be appended to every tool response and the
  // assertions below would start failing for a reason unrelated to their point.
  const proc = spawn(process.execPath, [SERVER, "--port", String(PORT)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      POLTERTAB_HOME: opts.home || HOME,
      POLTERTAB_NO_UPDATE_CHECK: "1",
      ...(opts.env || {}),
    },
  });
  const state = { proc, stdout: "", stderr: "", messages: [] };
  proc.stdout.on("data", (d) => {
    state.stdout += d.toString();
    let i;
    while ((i = state.stdout.indexOf("\n")) !== -1) {
      const line = state.stdout.slice(0, i).trim();
      state.stdout = state.stdout.slice(i + 1);
      if (line) state.messages.push({ line });
    }
  });
  proc.stderr.on("data", (d) => (state.stderr += d.toString()));
  return state;
}

let rpcId = 0;
function rpc(server, method, params) {
  const id = ++rpcId;
  server.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return waitFor(`rpc ${method}`, () => findReply(server, id), 15000).then(() =>
    findReply(server, id),
  );
}

function findReply(server, id) {
  for (const m of server.messages) {
    if (m.parsed === undefined) {
      try {
        m.parsed = JSON.parse(m.line);
      } catch {
        m.parsed = null; // non-JSON-RPC noise on stdout
      }
    }
    if (m.parsed && m.parsed.id === id) return m.parsed;
  }
  return null;
}

async function initialize(server) {
  await rpc(server, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "poltertab-test", version: "1.0.0" },
  });
  server.proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
}

function fakeExtension() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const state = { ws, open: false, seen: [] };
  ws.on("open", () => {
    state.open = true;
    ws.send(JSON.stringify({ type: "extension_ready", version: "test" }));
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    state.seen.push(m);
    if (m.id && m.action) {
      const data =
        m.action === "get_url"
          ? { url: "http://t/", title: "T", tabId: TAB }
          : { ok: true, tabId: TAB };
      ws.send(JSON.stringify({ id: m.id, success: true, data }));
    }
  });
  state.pushNetworkData = (n) => {
    for (let i = 0; i < n; i++) {
      ws.send(
        JSON.stringify({
          type: "network_data",
          tabId: TAB,
          url: `/api/thing?n=${i}`,
          body: JSON.stringify({ n: i }),
        }),
      );
    }
  };
  return state;
}

function textOf(reply) {
  assert.ok(reply.result, `no result: ${JSON.stringify(reply)}`);
  return reply.result.content.map((c) => c.text).join("\n");
}

async function groupD() {
  console.log("\nD. mcp-server end-to-end (real processes, fake extension)");

  fs.rmSync(DOWNLOADS, { recursive: true, force: true });

  const primary = startServer();
  await waitFor(
    "primary listening",
    () => primary.stderr.includes("Primary WebSocket server listening"),
    10000,
  );
  const ext = fakeExtension();
  await waitFor("extension connected", () => ext.open, 10000);
  await waitFor(
    "server acked extension",
    () => primary.stderr.includes("Chrome extension connected"),
    10000,
  );
  await initialize(primary);

  const secondary = startServer();
  await waitFor(
    "secondary mode",
    () => secondary.stderr.includes("running as Secondary"),
    10000,
  );
  await initialize(secondary);

  try {
    await test("D1 tools/list exposes the full browser toolset", async () => {
      const r = await rpc(primary, "tools/list", {});
      const names = r.result.tools.map((t) => t.name);
      assert.strictEqual(names.length, 23, `got ${names.length} tools`);
      assert.ok(names.includes("browser_get_network_state"));
      assert.ok(names.every((n) => n.startsWith("browser_")));
    });

    await test("D2 primary: output_file writes to disk and returns a short string", async () => {
      ext.pushNetworkData(3);
      await sleep(300);
      const r = await rpc(primary, "tools/call", {
        name: "browser_get_network_state",
        arguments: { output_file: "primary.json" },
      });
      const text = textOf(r);
      assert.ok(
        text.startsWith("Data successfully written to"),
        `returned payload instead of a path: ${text.slice(0, 80)}`,
      );
      assert.ok(text.includes("Captured 3 requests"), text);
      const written = fs.readdirSync(DOWNLOADS).filter((f) => f.startsWith("primary_"));
      assert.strictEqual(written.length, 1, `files: ${written}`);
      const saved = JSON.parse(fs.readFileSync(path.join(DOWNLOADS, written[0]), "utf8"));
      assert.strictEqual(saved.capturedRequests, 3);
    });

    await test("D3 secondary: output_file is honoured too (was silently ignored)", async () => {
      ext.pushNetworkData(4);
      await sleep(300);
      const r = await rpc(secondary, "tools/call", {
        name: "browser_get_network_state",
        arguments: { output_file: "secondary.json" },
      });
      const text = textOf(r);
      assert.ok(
        text.startsWith("Data successfully written to"),
        `secondary flooded the context instead of writing a file: ${text.slice(0, 80)}`,
      );
      assert.ok(text.includes("Captured 4 requests"), text);
      const written = fs.readdirSync(DOWNLOADS).filter((f) => f.startsWith("secondary_"));
      assert.strictEqual(written.length, 1, `files: ${written}`);
    });

    await test("D4 secondary without output_file still returns the payload inline", async () => {
      ext.pushNetworkData(2);
      await sleep(300);
      const r = await rpc(secondary, "tools/call", {
        name: "browser_get_network_state",
        arguments: {},
      });
      const parsed = JSON.parse(textOf(r));
      assert.strictEqual(parsed.capturedRequests, 2);
      assert.strictEqual(parsed.tabId, TAB);
    });

    await test("D5 output_file cannot escape the downloads directory", async () => {
      ext.pushNetworkData(1);
      await sleep(300);
      const r = await rpc(primary, "tools/call", {
        name: "browser_get_network_state",
        arguments: { output_file: "../../../evil.json" },
      });
      const text = textOf(r);
      assert.ok(text.includes(DOWNLOADS), text);
      assert.ok(!fs.existsSync(path.join(REPO, "evil.json")), "escaped to repo root");
      assert.ok(
        !fs.existsSync(path.join(REPO, "..", "evil.json")),
        "escaped above the repo",
      );
    });

    await test("D6 tool arguments may be omitted entirely", async () => {
      const r = await rpc(primary, "tools/call", {
        name: "browser_get_title",
      });
      assert.ok(r.result, JSON.stringify(r).slice(0, 200));
    });

    await test("D7 a tab-close log never lands on the JSON-RPC stream", async () => {
      ext.pushNetworkData(1);
      await sleep(200);
      ext.ws.send(JSON.stringify({ type: "tab_closed", tabId: TAB }));
      await waitFor(
        "tab_closed handled",
        () => primary.stderr.includes("Clearing network state for closed tab"),
        10000,
      );
      const noise = primary.messages.filter((m) => {
        if (m.parsed === undefined) {
          try {
            m.parsed = JSON.parse(m.line);
          } catch {
            m.parsed = null;
          }
        }
        return !m.parsed || m.parsed.jsonrpc !== "2.0";
      });
      assert.strictEqual(
        noise.length,
        0,
        `non-protocol bytes on stdout: ${noise.map((n) => n.line).join(" | ")}`,
      );
    });

    await test("D8 stdout carried only well-formed JSON-RPC for the whole run", () => {
      assert.ok(primary.messages.length >= 4, `only ${primary.messages.length} protocol messages`);
      for (const m of primary.messages) {
        assert.strictEqual(m.parsed && m.parsed.jsonrpc, "2.0", `bad line: ${m.line}`);
      }
    });
  } finally {
    ext.ws.close();
    secondary.proc.kill();
    primary.proc.kill();
    await sleep(300);
  }
}

// ───────── E. shadow DOM piercing + late-element retry ─────────

// Minimal DOM good enough for content_script's real code paths. Each "root"
// answers querySelector/querySelectorAll over a flat descendant list, so a
// shadow root is just another root — which is exactly how the traversal must
// see it.
function fakeEl(tag, opts = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    id: opts.id || "",
    textContent: opts.text || "",
    value: "",
    attributes: [],
    children: [],
    clicks: 0,
    scrollIntoView() {},
    focus() {},
    closest: () => null,
    // A real attribute map, so snapshot's data-zc-ref stamp and the selector
    // that reads it back are talking about the same thing.
    __attrs: { ...(opts.attrs || {}) },
    getAttribute: (k) => (k in el.__attrs ? el.__attrs[k] : null),
    setAttribute: (k, v) => {
      el.__attrs[k] = String(v);
    },
    matches: () => false,
    dispatchEvent(e) {
      if (e.type === "click") el.clicks++;
      return true;
    },
  };
  if (opts.shadow) el.shadowRoot = opts.shadow;
  if (opts.closedShadow) {
    el.shadowRoot = null; // what page script sees for a closed root
    el.__closedRoot = opts.closedShadow;
  }
  return el;
}

// The DOM's value setters are branded: calling HTMLInputElement's setter with
// a textarea receiver throws "Illegal invocation". Model that faithfully, or
// the bug this guards against is invisible to the suite.
class FakeHTMLElement {}
class FakeHTMLInputElement extends FakeHTMLElement {}
class FakeHTMLTextAreaElement extends FakeHTMLElement {}
for (const [Cls, brand] of [
  [FakeHTMLInputElement, "input"],
  [FakeHTMLTextAreaElement, "textarea"],
]) {
  Object.defineProperty(Cls.prototype, "value", {
    configurable: true,
    get() {
      return this.__value === undefined ? "" : this.__value;
    },
    set(v) {
      if (this.__brand !== brand) throw new TypeError("Illegal invocation");
      this.__value = v;
    },
  });
}

function fakeField(kind, opts = {}) {
  const Cls =
    kind === "textarea"
      ? FakeHTMLTextAreaElement
      : kind === "input"
        ? FakeHTMLInputElement
        : FakeHTMLElement;
  const el = new Cls();
  Object.assign(el, {
    tagName: kind === "div" ? "DIV" : kind.toUpperCase(),
    id: opts.id || "",
    textContent: "",
    events: [],
    attributes: [],
    children: [],
    isContentEditable: !!opts.contentEditable,
    scrollIntoView() {},
    focus() {},
    closest: () => null,
    getAttribute: () => null,
    matches: () => false,
    dispatchEvent(e) {
      el.events.push(e.type);
      return true;
    },
  });
  if (kind !== "div") el.__brand = kind;
  return el;
}

function fakeRoot(descendants, tracker) {
  const match = (el, sel) => {
    if (sel === "*") return true;
    if (sel.startsWith("#")) return el.id === sel.slice(1);
    // [attr="value"] — enough for the data-zc-ref lookup a snapshot ref becomes.
    const attr = /^\[([\w-]+)="(.*)"\]$/.exec(sel);
    if (attr) return el.getAttribute && el.getAttribute(attr[1]) === attr[2];
    return false;
  };
  return {
    __descendants: descendants,
    children: descendants,
    querySelector(sel) {
      if (tracker) tracker.push(this);
      return descendants.find((d) => match(d, sel)) || null;
    },
    querySelectorAll(sel) {
      if (tracker) tracker.push(this);
      return descendants.filter((d) => match(d, sel));
    },
  };
}

function shadowSandbox({ chromeDom = true, lightDescendants = [], roots = {} } = {}) {
  const queried = [];
  const body = fakeEl("body");
  const light = fakeRoot(lightDescendants, queried);

  const document = {
    title: "T",
    body,
    documentElement: { appendChild() {} },
    head: { appendChild() {} },
    createElement: () => ({ set src(v) {}, remove() {} }),
    querySelector: (s) => light.querySelector(s),
    querySelectorAll: (s) => light.querySelectorAll(s),
    // real content_script consults these before the piercing tier
    evaluate: () => ({ singleNodeValue: null }),
    createTreeWalker: () => ({ nextNode: () => null }),
  };

  const chrome = {
    runtime: {
      getURL: (p) => p,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
    storage: { local: { get: (_k, cb) => cb && cb({}) } },
  };
  if (chromeDom) {
    chrome.dom = {
      openOrClosedShadowRoot: (el) => el.__closedRoot || el.shadowRoot || null,
    };
  }

  const listeners = [];
  const sandbox = {
    console: { log() {}, error() {} },
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    Error,
    document,
    chrome,
    location: { href: "http://t/" },
    NodeFilter: { SHOW_ELEMENT: 1 },
    XPathResult: { FIRST_ORDERED_NODE_TYPE: 9 },
    HTMLElement: FakeHTMLElement,
    HTMLInputElement: FakeHTMLInputElement,
    HTMLTextAreaElement: FakeHTMLTextAreaElement,
    MouseEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    addEventListener() {},
  };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  vm.runInContext(
    fs.readFileSync(path.join(EXT, "content_script.js"), "utf8"),
    sandbox,
  );

  return {
    queried,
    // Returns a promise for the response, since actions may now await.
    send: (action, params) =>
      new Promise((resolve) => {
        listeners[0]({ source: "poltertab", action, params }, {}, resolve);
      }),
  };
}

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


// ─────────────── G. cross-frame element search ───────────────

// These tests verify the background.js frame-search logic. Since
// background.js runs in a service-worker context with chrome.* APIs that the
// vm sandbox cannot faithfully model at the message-routing level, group G
// tests against the REAL background.js by driving it through the same stubbed
// chrome environment that group C uses — plus a multi-frame model where each
// frame's content script is a simple function mapping (action, selector) to
// success/failure.

function frameSearchSandbox(cfg = {}) {
  // cfg.frames: [{frameId, elements: {selector: response}}]
  const frames = cfg.frames || [
    { frameId: 0, elements: {} },
    { frameId: 123, elements: {} },
  ];
  const sent = [];
  const navListeners = [];
  const sockets = [];

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    JSON,
    Date,
    Math,
    Promise,
    Error,
    Object,
    Array,
    WebSocket: class {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        sockets.push(this);
      }
      send(data) { sent.push(JSON.parse(data)); }
      close() {}
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: "test" }),
        sendMessage: () => Promise.resolve(),
        onMessage: { addListener() {} },
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} },
        lastError: null,
      },
      alarms: {
        get: (_n, cb) => cb && cb(null),
        create() {},
        clear() {},
        onAlarm: { addListener() {} },
      },
      storage: {
        local: {
          get: (keys, cb) => (cb ? cb({}) : Promise.resolve({})),
          set: (_o, cb) => (cb ? cb() : Promise.resolve()),
        },
        onChanged: { addListener() {} },
      },
      tabs: {
        get: async (id) => ({ id, url: "http://t/", title: "T", status: "complete" }),
        create: async (props) => ({ id: 99, url: props.url || "about:blank", title: "T" }),
        update: async (id, props) => ({ id, url: props.url || "http://t/", title: "T" }),
        query: async () => [{ id: 99, url: "http://t/", title: "T" }],
        remove: async () => {},
        group: async () => 1,
        sendMessage: async (tabId, msg, opts, cb) => {
          // Simulate per-frame content script responses
          if (typeof opts === "function") { cb = opts; opts = {}; }
          const frameId = (opts && opts.frameId) || 0;
          const frame = frames.find((f) => f.frameId === frameId);

          // noContentScript models the real shape of a detail page: a map or
          // chat iframe that the manifest never reached.
          if (!frame || frame.noContentScript) {
            // Frame not found - simulate "Receiving end does not exist"
            sandbox.chrome.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
            cb(undefined);
            sandbox.chrome.runtime.lastError = null;
            return;
          }

          const { action, params = {} } = msg;
          const sel = params.selector;

          // snapshot/scrape-without-selector: always returns something
          if (action === "snapshot") {
            const nodes = frame.snapshotNodes || [];
            cb({ success: true, data: { title: "T", url: "http://t/", count: nodes.length, nodes } });
            return;
          }
          if (action === "extract") {
            const rows = (frame.records || {})[params.record] || [];
            cb({
              success: true,
              data: {
                url: "http://t/",
                count: rows.length,
                records_found: rows.length,
                dropped: 0,
                fill_rates: {},
                warnings: rows.length
                  ? []
                  : [`record: no matches for "${params.record}"`],
                rows,
              },
            });
            return;
          }
          if (action === "scrape" && !sel) {
            cb({ success: true, data: frame.scrapeData || { title: "T", url: "http://t/", meta: {}, links: [], headings: [], bodyText: "" } });
            return;
          }

          // element-targeting actions
          if (sel && frame.elements[sel]) {
            cb({ success: true, data: frame.elements[sel] });
          } else if (sel && params._noWait) {
            // Fast probe — instant miss
            cb({ success: false, error: "Element not found: " + sel });
          } else if (sel) {
            // Retry pass — poll for up to 3s like the real content script
            const deadline = Date.now() + 3000;
            const poll = setInterval(() => {
              if (frame.elements[sel]) {
                clearInterval(poll);
                cb({ success: true, data: frame.elements[sel] });
              } else if (Date.now() >= deadline) {
                clearInterval(poll);
                cb({ success: false, error: "Element not found: " + sel });
              }
            }, 100);
          } else {
            cb({ success: true, data: { ok: true } });
          }
        },
        onRemoved: { addListener() {} },
        onUpdated: { addListener() {} },
      },
      tabGroups: {
        get: async () => ({ id: 1 }),
        query: async () => [],
        update: async () => {},
      },
      webNavigation: {
        getAllFrames: async ({ tabId }) => frames.map((f) => ({
          tabId,
          frameId: f.frameId,
          url: f.url || "http://t/",
          parentFrameId: f.frameId === 0 ? -1 : 0,
        })),
        onCompleted: {
          addListener: (fn) => navListeners.push(fn),
          removeListener() {},
        },
      },
      scripting: { executeScript: async () => [] },
    },
  };

  const vm = require("vm");
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.runInContext(
    fs.readFileSync(path.join(EXT, "background.js"), "utf8"),
    sandbox,
  );

  const ws = sockets[0];
  if (ws && ws.onopen) ws.onopen();

  // Fire a load event so waitForTabLoad succeeds
  for (const fn of navListeners) fn({ tabId: 99, frameId: 0 });

  return {
    command: (msg) =>
      new Promise((resolve) => {
        ws.onmessage({ data: JSON.stringify(msg) });
        // Poll for the reply
        const check = setInterval(() => {
          const reply = sent.find((m) => m.id === msg.id);
          if (reply) {
            clearInterval(check);
            resolve(reply);
          }
        }, 20);
        setTimeout(() => { clearInterval(check); resolve(null); }, 12000);
      }),
    sent,
  };
}

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

async function groupH() {
  console.log("\nH. update notice + version skew (real processes, fake extension)");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "poltertab-notice-"));
  // Claim the registry reported something far newer, fresh enough to be trusted
  // from cache so the test never touches the network.
  fs.writeFileSync(
    path.join(home, "update-check.json"),
    JSON.stringify({ checkedAt: Date.now(), latest: "99.0.0" }),
  );

  const srv = startServer({ home, env: { POLTERTAB_NO_UPDATE_CHECK: "" } });
  try {
    await waitFor(
      "server listening",
      () => srv.stderr.includes("WebSocket server listening"),
    );

    // An ancient but *parseable* version, unlike the shared fake extension's
    // "test" — skew can only be computed from real semver on both sides.
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const seen = [];
    await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
    });
    ws.send(JSON.stringify({ type: "extension_ready", version: "0.1.0" }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      seen.push(m);
      if (m.id && m.action) {
        ws.send(JSON.stringify({ id: m.id, success: true, data: { title: "T" } }));
      }
    });
    await sleep(500);

    await rpc(srv, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });

    let first;
    await test("H1 the first tool response carries the notice", async () => {
      first = textOf(
        await rpc(srv, "tools/call", { name: "browser_get_title", arguments: {} }),
      );
      assert.ok(/\[PolterTab\]/.test(first), `no notice in: ${first}`);
    });

    await test("H2 the notice names the skew and the available version", async () => {
      assert.ok(/0\.1\.0/.test(first), "skew not described");
      assert.ok(/older than this server/.test(first), "skew direction not stated");
      assert.ok(/99\.0\.0/.test(first), "available version not mentioned");
    });

    await test("H3 the tool's own payload survives alongside the notice", async () => {
      // Appending to content must not corrupt what the caller actually asked for.
      assert.ok(/"title"/.test(first), `payload lost: ${first}`);
    });

    await test("H4 the notice appears once per process, not on every call", async () => {
      const second = textOf(
        await rpc(srv, "tools/call", { name: "browser_get_title", arguments: {} }),
      );
      assert.ok(!/\[PolterTab\]/.test(second), `notice repeated: ${second}`);
      assert.ok(/"title"/.test(second), "second call lost its payload");
    });

    await test("H5 the server tells the extension its version", async () => {
      // Without this the popup has our version but nothing to compare it to.
      const hello = seen.find((m) => m.type === "server_version");
      assert.ok(hello, `never sent server_version: ${JSON.stringify(seen)}`);
      assert.ok(/^\d+\.\d+\.\d+/.test(hello.version), `odd version: ${hello.version}`);
    });

    await test("H6 skew is logged to stderr, never to the JSON-RPC stream", async () => {
      assert.ok(/VERSION SKEW/.test(srv.stderr), "skew not logged");
      for (const m of srv.messages) {
        assert.ok(
          !/VERSION SKEW/.test(m.line),
          `skew log leaked onto stdout: ${m.line}`,
        );
      }
    });

    await test("H7 the extension version is recorded for doctor to read", async () => {
      const state = JSON.parse(
        fs.readFileSync(path.join(home, "state.json"), "utf8"),
      );
      assert.strictEqual(state.extensionVersion, "0.1.0");
      assert.ok(state.seenAt > 0, "no timestamp recorded");
    });

    ws.close();
  } finally {
    srv.proc.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ────────── I. record-scoped extraction ──────────
//
// The bug class this group exists for is silent: a flat scrape of 90 agents
// where one had no phone number shifted every later phone up a row, and the
// result looked entirely plausible. Nothing here asserts "it worked" — each
// test asserts that a specific wrong answer is no longer produced.

// A DOM with real selector support: classes and attribute operators, matched
// over actual descendants, so "resolve this field inside that record" is a
// thing the harness can actually get wrong.
function recEl(tag, opts = {}) {
  const attrs = opts.attrs || {};
  const e = {
    tagName: tag.toUpperCase(),
    id: opts.id || "",
    __cls: opts.cls ? opts.cls.split(/\s+/) : [],
    __attrs: attrs,
    textContent: opts.text || "",
    innerText: opts.text || "",
    children: opts.children || [],
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    getAttribute(n) {
      return n in this.__attrs ? this.__attrs[n] : null;
    },
    matches: () => false,
    scrollIntoView() {},
    dispatchEvent: () => true,
  };
  // href/src are resolved properties on a real anchor; a raw attribute of
  // "/agent/x" is useless to the caller.
  if (attrs.href !== undefined) {
    e.href = /^[a-z]+:/i.test(attrs.href)
      ? attrs.href
      : `http://t${attrs.href.startsWith("/") ? "" : "/"}${attrs.href}`;
  }
  if (attrs.src !== undefined) e.src = attrs.src;

  const kids = () => e.children.flatMap((c) => [c, ...recDescendants(c)]);
  e.querySelector = (sel) => kids().find((d) => recMatch(d, sel)) || null;
  e.querySelectorAll = (sel) => kids().filter((d) => recMatch(d, sel));
  return e;
}

function recDescendants(e) {
  return (e.children || []).flatMap((c) => [c, ...recDescendants(c)]);
}

function recMatchOne(e, term) {
  const t = term.trim();
  if (!t) return false;
  if (t === "*") return true;
  const m = /^([a-z0-9]*)(#[\w-]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(t);
  if (!m) return false;
  const [, tag, hashId, classes, attrPart] = m;
  if (tag && e.tagName !== tag.toUpperCase()) return false;
  if (hashId && e.id !== hashId.slice(1)) return false;
  for (const c of classes.split(".").filter(Boolean)) {
    if (!e.__cls.includes(c)) return false;
  }
  for (const a of attrPart.match(/\[[^\]]+\]/g) || []) {
    const am = /^\[([\w-]+)(?:([~^$*]?=)['"]?([^\]'"]*)['"]?)?\]$/.exec(a);
    if (!am) return false;
    const [, name, op, val] = am;
    const actual = e.getAttribute(name);
    if (actual === null) return false;
    if (!op) continue;
    if (op === "=" && actual !== val) return false;
    if (op === "^=" && !actual.startsWith(val)) return false;
    if (op === "*=" && !actual.includes(val)) return false;
    if (op === "$=" && !actual.endsWith(val)) return false;
  }
  return true;
}

const recMatch = (e, sel) => sel.split(",").some((t) => recMatchOne(e, t));

function recordSandbox(topChildren, opts = {}) {
  const body = recEl("body", { children: topChildren });
  const all = () => recDescendants(body);

  const document = {
    title: opts.title || "T",
    body,
    documentElement: { appendChild() {} },
    head: { appendChild() {} },
    createElement: () => ({ set src(v) {}, remove() {} }),
    querySelector: (s) => all().find((d) => recMatch(d, s)) || null,
    querySelectorAll: (s) => all().filter((d) => recMatch(d, s)),
    evaluate: () => ({ singleNodeValue: null }),
    createTreeWalker: () => ({ nextNode: () => null }),
  };

  const listeners = [];
  const sandbox = {
    console: { log() {}, error() {} },
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    Error,
    JSON,
    Set,
    Object,
    Array,
    Number,
    parseInt,
    document,
    chrome: {
      runtime: {
        getURL: (p) => p,
        sendMessage: () => Promise.resolve(),
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
      storage: { local: { get: (_k, cb) => cb && cb({}) } },
    },
    location: { href: opts.url || "http://t/" },
    NodeFilter: { SHOW_ELEMENT: 1 },
    XPathResult: { FIRST_ORDERED_NODE_TYPE: 9 },
    HTMLElement: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    MouseEvent: class {
      constructor(t) {
        this.type = t;
      }
    },
    Event: class {
      constructor(t) {
        this.type = t;
      }
    },
    addEventListener() {},
  };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  vm.runInContext(
    fs.readFileSync(path.join(EXT, "content_script.js"), "utf8"),
    sandbox,
  );

  return {
    // Round-tripped through JSON on the way out, because that is what the real
    // chrome.runtime message boundary does — and because objects minted inside
    // the vm realm are not deepStrictEqual to plain ones out here.
    send: (action, params) =>
      new Promise((resolve) => {
        listeners[0]({ source: "poltertab", action, params }, {}, (r) =>
          resolve(JSON.parse(JSON.stringify(r))),
        );
      }),
  };
}

// One kw.com-shaped agent card. Socials deliberately live OUTSIDE the
// .agent-card-info box, exactly as they do on the real page.
function agentCard({ name, path: p, phone, email, socials = [] }) {
  const info = [];
  if (p) info.push(recEl("a", { cls: "agent-card-name", text: name, attrs: { href: p } }));
  if (phone)
    info.push(recEl("a", { text: phone, attrs: { href: `tel:${phone}` } }));
  if (email)
    info.push(recEl("a", { text: email, attrs: { href: `mailto:${email}` } }));

  return recEl("div", {
    cls: "agent-card",
    children: [
      recEl("div", { cls: "agent-card-info", children: info }),
      recEl("div", {
        cls: "agent-card-socials",
        children: socials.map((s) =>
          recEl("a", { cls: "agent-card-social-button", attrs: { href: s } }),
        ),
      }),
    ],
  });
}

const AGENT_FIELDS = {
  name: { sel: "a.agent-card-name", get: "text" },
  url: { sel: "a.agent-card-name", get: "href" },
  phone: { sel: "a[href^='tel:']", get: "href", strip: "tel:" },
  email: { sel: "a[href^='mailto:']", get: "href", strip: "mailto:" },
};

async function groupI() {
  console.log("\nI. record-scoped extraction");

  await test("I1 a record missing an optional field does NOT shift later records", async () => {
    const s = recordSandbox([
      agentCard({ name: "Ann", path: "/agent/ann", phone: "111" }),
      agentCard({ name: "Dani", path: "/agent/dani" }), // no phone — the shifter
      agentCard({ name: "Cal", path: "/agent/cal", phone: "333" }),
    ]);
    const res = await s.send("extract", {
      record: ".agent-card",
      fields: AGENT_FIELDS,
    });
    assert.strictEqual(res.success, true, res.error);
    const rows = res.data.rows;
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[0].phone, "111");
    assert.strictEqual(rows[1].phone, null, "missing field must be null");
    assert.strictEqual(
      rows[2].phone,
      "333",
      "phone shifted up — every later record is now mis-assigned",
    );
    assert.strictEqual(rows[1].name, "Dani", "name/phone came from different records");
  });

  await test("I2 a too-narrow record root is reported, not silently empty", async () => {
    const s = recordSandbox([
      agentCard({ name: "Ann", path: "/agent/ann", socials: ["http://fb/ann"] }),
      agentCard({ name: "Cal", path: "/agent/cal", socials: ["http://fb/cal"] }),
    ]);
    // .agent-card-info is the container that LOOKS like the card. Socials are
    // its sibling, so this scope cannot see them.
    const res = await s.send("extract", {
      record: ".agent-card-info",
      fields: {
        name: { sel: "a.agent-card-name", get: "text" },
        socials: { sel: "a.agent-card-social-button", get: "href", many: true },
      },
    });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(res.data.fill_rates.socials, 0);
    const warn = res.data.warnings.join(" ");
    assert.ok(
      /socials: 0\/2 within record scope, but 2 matches page-wide/.test(warn),
      `no loosening probe — an empty column reads as "these agents have no socials": ${warn}`,
    );
    assert.ok(/too narrow/.test(warn), warn);
  });

  await test("I3 a wrong selector is distinguished from a wrong boundary", async () => {
    const s = recordSandbox([agentCard({ name: "Ann", path: "/agent/ann" })]);
    const res = await s.send("extract", {
      record: ".agent-card",
      fields: {
        name: { sel: "a.agent-card-name", get: "text" },
        license: { sel: "span.nope", get: "text" },
      },
    });
    const warn = res.data.warnings.join(" ");
    assert.ok(/no matches for "span.nope" anywhere/.test(warn), warn);
    assert.ok(!/too narrow/.test(warn), `misdiagnosed as a boundary problem: ${warn}`);
  });

  await test("I4 anchor drops placeholder records and counts them", async () => {
    const s = recordSandbox([
      agentCard({ name: "Ann", path: "/agent/ann" }),
      agentCard({ name: "", path: null }), // phantom card, page 10 of kw.com
      agentCard({ name: "", path: null }),
      agentCard({ name: "Cal", path: "/agent/cal" }),
    ]);
    const res = await s.send("extract", {
      record: ".agent-card",
      fields: AGENT_FIELDS,
      anchor: "url",
    });
    assert.strictEqual(res.data.count, 2);
    assert.strictEqual(res.data.dropped, 2, "phantoms emitted as null rows");
    assert.strictEqual(res.data.records_found, 4);
    assert.deepStrictEqual(
      res.data.rows.map((r) => r.name),
      ["Ann", "Cal"],
    );
  });

  await test("I5 fill_rates count real values, not row slots", async () => {
    const s = recordSandbox([
      agentCard({ name: "Ann", path: "/agent/ann", phone: "111", email: "a@x" }),
      agentCard({ name: "Cal", path: "/agent/cal", email: "c@x" }),
    ]);
    const res = await s.send("extract", {
      record: ".agent-card",
      fields: AGENT_FIELDS,
    });
    assert.deepStrictEqual(res.data.fill_rates, {
      name: 2,
      url: 2,
      phone: 1,
      email: 2,
    });
  });

  await test("I6 get:'text' works where attribute:'textContent' returned nulls", async () => {
    const s = recordSandbox([agentCard({ name: "Ann", path: "/agent/ann" })]);
    const ex = await s.send("extract", {
      record: ".agent-card",
      fields: { name: { sel: "a.agent-card-name", get: "text" } },
    });
    assert.strictEqual(ex.data.rows[0].name, "Ann");

    // Same trap via scrape's attribute param, which is where it was found.
    const sc = await s.send("scrape", {
      selector: "a.agent-card-name",
      attribute: "textContent",
      multiple: true,
    });
    assert.deepStrictEqual(sc.data, ["Ann"], "attribute:textContent still nulls");
  });

  await test("I7 href comes back absolute and strip removes the scheme", async () => {
    const s = recordSandbox([
      agentCard({ name: "Ann", path: "/agent/ann", phone: "555-1234" }),
    ]);
    const res = await s.send("extract", {
      record: ".agent-card",
      fields: AGENT_FIELDS,
    });
    assert.strictEqual(res.data.rows[0].url, "http://t/agent/ann");
    assert.strictEqual(res.data.rows[0].phone, "555-1234");
  });

  await test("I8 many:true keeps each record's list to itself", async () => {
    const s = recordSandbox([
      agentCard({
        name: "Ann",
        path: "/agent/ann",
        socials: ["http://fb/ann", "http://li/ann"],
      }),
      agentCard({ name: "Cal", path: "/agent/cal", socials: ["http://fb/cal"] }),
    ]);
    const res = await s.send("extract", {
      record: ".agent-card",
      fields: {
        name: { sel: "a.agent-card-name", get: "text" },
        socials: { sel: "a.agent-card-social-button", get: "href", many: true },
      },
    });
    assert.deepStrictEqual(res.data.rows[0].socials, [
      "http://fb/ann",
      "http://li/ann",
    ]);
    assert.deepStrictEqual(res.data.rows[1].socials, ["http://fb/cal"]);
  });

  await test("I9 a field with no sel reads the record root itself", async () => {
    const s = recordSandbox([agentCard({ name: "Ann", path: "/agent/ann" })]);
    const res = await s.send("extract", {
      record: "a.agent-card-name",
      fields: { name: { get: "text" }, url: { get: "href" } },
    });
    assert.strictEqual(res.data.rows[0].name, "Ann");
    assert.strictEqual(res.data.rows[0].url, "http://t/agent/ann");
  });

  await test("I10 truncation is reported instead of silently cutting", async () => {
    const s = recordSandbox([
      recEl("div", {
        cls: "card",
        children: [recEl("p", { cls: "bio", text: "x".repeat(400) })],
      }),
    ]);
    const res = await s.send("extract", {
      record: ".card",
      fields: { bio: { sel: "p.bio", get: "text" } },
      max_text: 50,
    });
    assert.strictEqual(res.data.rows[0].bio.length, 50);
    assert.ok(
      /truncated at max_text=50: bio/.test(res.data.warnings.join(" ")),
      res.data.warnings.join(" "),
    );
  });

  await test("I11 a record selector matching nothing says so", async () => {
    const s = recordSandbox([agentCard({ name: "Ann", path: "/agent/ann" })]);
    const res = await s.send("extract", {
      record: ".listing-row",
      fields: { name: { sel: "a", get: "text" } },
    });
    assert.strictEqual(res.data.count, 0);
    assert.strictEqual(res.data.records_found, 0);
    assert.ok(/no matches for ".listing-row"/.test(res.data.warnings.join(" ")));
  });

  await test("I12 scrape fields:['meta','jsonld'] skips the 50KB body", async () => {
    const s = recordSandbox([
      recEl("meta", { attrs: { property: "og:title", content: "Ann | NJ" } }),
      recEl("script", {
        attrs: { type: "application/ld+json" },
        text: '{"@type":"RealEstateAgent","name":"Ann"}',
      }),
      recEl("script", {
        attrs: { type: "application/ld+json" },
        text: "{ not json",
      }),
      recEl("a", { attrs: { href: "/x" }, text: "x" }),
    ]);
    const res = await s.send("scrape", { fields: ["meta", "jsonld"] });
    assert.strictEqual(res.data.meta["og:title"], "Ann | NJ");
    assert.strictEqual(res.data.jsonld.length, 1, "malformed blob broke the scrape");
    assert.strictEqual(res.data.jsonld[0].name, "Ann");
    assert.ok(res.data.title, "title should always come along");
    assert.strictEqual(res.data.bodyText, undefined, "body text was not asked for");
    assert.strictEqual(res.data.links, undefined);
  });

  await test("I13 get_text flags a cut instead of hiding it", async () => {
    const s = recordSandbox([recEl("p", { id: "long", text: "y".repeat(300) })]);
    const cut = await s.send("get_text", { selector: "#long", max_text: 100 });
    assert.strictEqual(cut.data.truncated, true);
    assert.strictEqual(cut.data.full_length, 300);
    const whole = await s.send("get_text", { selector: "#long" });
    assert.strictEqual(whole.data.truncated, undefined);
  });
}

// ────────── J. the pagination loop ──────────
//
// The loop exists so the model stops being the for-loop. Every assertion here
// is about a halt condition: continuing past any of them yields a dataset that
// looks complete and is not.

// An extension that serves scripted pages. `pageRows(n)` returns the records
// for page n; returning null means "this page does not exist".
function scriptedExtension(pageRows) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const state = { ws, open: false, navigations: [], extracts: 0, page: 1 };
  ws.on("open", () => {
    state.open = true;
    ws.send(JSON.stringify({ type: "extension_ready", version: "test" }));
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (!m.id || !m.action) return;
    let data;
    // The server puts command params flat on the message, not under `params`.
    if (m.action === "navigate") {
      state.navigations.push(m.url);
      const hit = /[?&]page=(\d+)/.exec(m.url || "");
      state.page = hit ? Number(hit[1]) : 1;
      data = { tabId: TAB, url: m.url, title: "T", status: "ok" };
    } else if (m.action === "extract") {
      state.extracts++;
      const rows = pageRows(state.page) || [];
      const fill_rates = {};
      for (const f of Object.keys(rows[0] || {})) {
        fill_rates[f] = rows.filter((r) => r[f] !== null && r[f] !== "").length;
      }
      data = {
        url: `http://t/?page=${state.page}`,
        count: rows.length,
        records_found: rows.length,
        dropped: 0,
        fill_rates,
        warnings: [],
        rows,
      };
    } else {
      data = { ok: true, tabId: TAB };
    }
    ws.send(JSON.stringify({ id: m.id, success: true, data }));
  });
  return state;
}

// 12 records per page, keyed by a stable detail URL, like the real thing.
const page12 = (n) =>
  Array.from({ length: 12 }, (_, i) => ({
    name: `Agent ${n}-${i}`,
    url: `http://t/agent/${n}-${i}`,
    phone: i % 6 === 0 ? null : `${n}${i}`,
  }));

async function callExtractAll(srv, args) {
  const reply = await rpc(srv, "tools/call", {
    name: "browser_extract_all",
    arguments: {
      url_template: "http://t/agents?page={page}",
      record: ".agent-card",
      fields: { name: { sel: "a", get: "text" } },
      key: "url",
      ...args,
    },
  });
  return JSON.parse(textOf(reply));
}

async function groupJ() {
  console.log("\nJ. the pagination loop");

  await test("J1 walks pages to the limit in ONE tool call, deduped", async () => {
    const srv = startServer();
    try {
      await waitFor("listening", () => srv.stderr.includes("WebSocket server listening"));
      const ext = scriptedExtension(page12);
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const out = await callExtractAll(srv, { limit: 30 });
      assert.strictEqual(out.count, 30, JSON.stringify(out).slice(0, 400));
      assert.strictEqual(out.stopped_because, "limit_reached");
      assert.strictEqual(out.pages_fetched, 3, "should need exactly 3 pages of 12");
      assert.strictEqual(
        new Set(out.rows.map((r) => r.url)).size,
        30,
        "duplicate records in the output",
      );
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });

  await test("J2 a site that ignores ?page halts instead of returning page 1 forever", async () => {
    const srv = startServer();
    try {
      await waitFor("listening", () => srv.stderr.includes("WebSocket server listening"));
      // Every page returns page 1's records — the ?size=50 trap.
      const ext = scriptedExtension(() => page12(1));
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const out = await callExtractAll(srv, { limit: 100 });
      assert.strictEqual(out.stopped_because, "duplicate_page");
      assert.strictEqual(out.count, 12, "emitted repeats of the same page as new data");
      assert.ok(out.pages_fetched <= 3, `kept going: ${out.pages_fetched} pages`);
      assert.ok(
        /not advancing/.test(out.warnings.join(" ")),
        out.warnings.join(" "),
      );
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });

  await test("J3 an empty page ends the run and says so", async () => {
    const srv = startServer();
    try {
      await waitFor("listening", () => srv.stderr.includes("WebSocket server listening"));
      const ext = scriptedExtension((n) => (n <= 2 ? page12(n) : []));
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const out = await callExtractAll(srv, { limit: 500 });
      assert.strictEqual(out.stopped_because, "empty_page");
      assert.strictEqual(out.count, 24);
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });

  await test("J4 fill rates collapsing halts the run and keeps what was collected", async () => {
    const srv = startServer();
    try {
      await waitFor("listening", () => srv.stderr.includes("WebSocket server listening"));
      // Page 3 is a different layout: the name column stops being populated.
      const ext = scriptedExtension((n) =>
        n < 3
          ? page12(n)
          : page12(n).map((r) => ({ ...r, name: null })),
      );
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const out = await callExtractAll(srv, { limit: 500 });
      assert.strictEqual(out.stopped_because, "fill_rate_deviation");
      assert.strictEqual(out.count, 24, "should keep pages 1-2 rather than lose them");
      assert.ok(/name 0% vs baseline 100%/.test(out.warnings.join(" ")), out.warnings.join(" "));
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });

  await test("J5 max_pages is a hard guard", async () => {
    const srv = startServer();
    try {
      await waitFor("listening", () => srv.stderr.includes("WebSocket server listening"));
      const ext = scriptedExtension(page12);
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const out = await callExtractAll(srv, { limit: 1000, max_pages: 2 });
      assert.strictEqual(out.stopped_because, "max_pages");
      assert.strictEqual(out.pages_fetched, 2);
      assert.strictEqual(out.count, 24);
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });

  await test("J6 output_file writes a real CSV and returns only a summary", async () => {
    const srv = startServer();
    try {
      await waitFor("listening", () => srv.stderr.includes("WebSocket server listening"));
      const ext = scriptedExtension((n) =>
        n === 1
          ? [
              { name: 'Ann "The Closer", Lee', url: "http://t/a", phone: "1" },
              { name: "Cal\nBrown", url: "http://t/c", phone: null },
            ]
          : [],
      );
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const out = await callExtractAll(srv, { limit: 50, output_file: "agents.csv" });

      assert.ok(out.file, "no file path returned");
      assert.strictEqual(out.rows, undefined, "raw rows came back inline anyway");
      assert.strictEqual(out.sample.length, 2);
      assert.deepStrictEqual(out.fields, ["name", "url", "phone"]);

      const csv = fs.readFileSync(out.file, "utf8");
      assert.ok(csv.startsWith("name,url,phone\n"), csv);
      // A quote inside a quoted field must be doubled and a comma must not
      // split the row — the difference between a file that imports and one that
      // imports wrongly. A field holding a newline legitimately spans two
      // lines, so this is asserted against the whole text, not line by line.
      assert.ok(csv.includes('"Ann ""The Closer"", Lee",http://t/a,1'), csv);
      assert.ok(csv.includes('"Cal\nBrown",http://t/c,'), csv);
      assert.ok(!/null/.test(csv), "a null was written as the text 'null'");
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });

  await test("J7 url_template without {page} is rejected up front", async () => {
    const srv = startServer();
    try {
      await waitFor("listening", () => srv.stderr.includes("WebSocket server listening"));
      const ext = scriptedExtension(page12);
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const reply = await rpc(srv, "tools/call", {
        name: "browser_extract_all",
        arguments: {
          url_template: "http://t/agents",
          record: ".agent-card",
          fields: { name: { sel: "a", get: "text" } },
        },
      });
      assert.ok(reply.result.isError, "silently scraped page 1 N times");
      assert.ok(/\{page\}/.test(textOf(reply)), textOf(reply));
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });
}

// ────────── K. benchmark-run regressions ──────────
//
// Four bugs the first live benchmark run turned up. Three are fixed here; each
// test names the wrong behaviour it replaces.

function memoryHome(files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "poltertab-mem-"));
  const dir = path.join(home, "navigation_memory");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    // Anything with a slash is deliberately outside the memory dir.
    const target = name.includes("/")
      ? path.join(home, name.replace("../", ""))
      : path.join(dir, name);
    fs.writeFileSync(target, JSON.stringify(contents));
  }
  return home;
}

async function withServer(home, fn) {
  const srv = startServer({ home });
  try {
    await waitFor("listening", () =>
      srv.stderr.includes("WebSocket server listening"),
    );
    await initialize(srv);
    return await fn(srv);
  } finally {
    srv.proc.kill();
  }
}

const getMemory = (srv, hostname) =>
  rpc(srv, "tools/call", {
    name: "browser_get_site_memory",
    arguments: { hostname },
  });

async function groupK() {
  console.log("\nK. benchmark-run regressions");

  const note = (obstacle) => [{ obstacle, solution: "s", timestamp: 1 }];

  await test("K1 www.<host> finds notes saved under the bare host", async () => {
    // The bug: kw.com.json existed and a lookup for www.kw.com returned [] —
    // silently, so T1's own documented first step found nothing.
    const home = memoryHome({ "kw.com.json": note("12 agents per page") });
    await withServer(home, async (srv) => {
      const text = textOf(await getMemory(srv, "www.kw.com"));
      assert.ok(/12 agents per page/.test(text), `returned: ${text}`);
    });
  });

  await test("K2 the bare host finds notes saved under www.<host>", async () => {
    // The store already holds both spellings, so the fallback runs both ways.
    const home = memoryHome({ "www.linkedin.com.json": note("voyager graphql") });
    await withServer(home, async (srv) => {
      const text = textOf(await getMemory(srv, "linkedin.com"));
      assert.ok(/voyager graphql/.test(text), `returned: ${text}`);
    });
  });

  await test("K3 a full URL is accepted where a hostname is expected", async () => {
    const home = memoryHome({ "kw.com.json": note("paginate with ?page=N") });
    await withServer(home, async (srv) => {
      const text = textOf(await getMemory(srv, "https://www.kw.com/agents?page=3"));
      assert.ok(/paginate with \?page=N/.test(text), `returned: ${text}`);
    });
  });

  await test("K4 a hostname cannot read outside the memory directory", async () => {
    // The host was interpolated straight into a path, and it comes from a model.
    const home = memoryHome({
      "kw.com.json": note("fine"),
      "../secret.json": note("PRIVATE-MARKER"),
    });
    await withServer(home, async (srv) => {
      const reply = await getMemory(srv, "../secret");
      const text = textOf(reply);
      assert.ok(
        !/PRIVATE-MARKER/.test(text),
        `escaped the memory dir: ${text.slice(0, 120)}`,
      );
    });
  });

  await test("K5 a note saved under one spelling is found under the other", async () => {
    const home = memoryHome({});
    await withServer(home, async (srv) => {
      await rpc(srv, "tools/call", {
        name: "browser_save_site_memory",
        arguments: {
          hostname: "www.kw.com",
          obstacle: "socials sit outside .agent-card-info",
          solution: "use .agent-card as the record root",
        },
      });
      const text = textOf(await getMemory(srv, "kw.com"));
      assert.ok(/socials sit outside/.test(text), `returned: ${text}`);
      // One file per site, not one per spelling. (A fresh home also receives
      // the legacy-migration copies, so this checks the pair, not the listing.)
      const dir = path.join(home, "navigation_memory");
      assert.ok(fs.existsSync(path.join(dir, "kw.com.json")));
      assert.ok(
        !fs.existsSync(path.join(dir, "www.kw.com.json")),
        "saved a second file for the www spelling",
      );
    });
  });

  await test("K6 output_file confines an absolute path and says it did", async () => {
    const home = memoryHome({});
    await withServer(home, async (srv) => {
      const ext = fakeExtension();
      await waitFor("ext open", () => ext.open);
      const reply = await rpc(srv, "tools/call", {
        name: "browser_get_network_state",
        arguments: { output_file: "/Users/somebody/Desktop/agents.json" },
      });
      const text = textOf(reply);
      // Silently writing somewhere else is how a caller ends up looking for a
      // file that was never going to be there.
      assert.ok(
        /downloads/.test(text),
        `no indication of where it actually went: ${text}`,
      );
      assert.ok(
        !fs.existsSync("/Users/somebody/Desktop/agents.json"),
        "wrote outside the downloads dir",
      );
      ext.ws.close();
    });
  });

  await test("K7 extract_all reports fill as counts, and the baseline as ratios", async () => {
    // The inconsistency: extract returned counts under fill_rates while
    // extract_all returned fractions under a near-identical name.
    const srv = startServer();
    try {
      await waitFor("listening", () =>
        srv.stderr.includes("WebSocket server listening"),
      );
      const ext = scriptedExtension((n) => (n <= 2 ? page12(n) : []));
      await waitFor("ext open", () => ext.open);
      await initialize(srv);

      const out = await callExtractAll(srv, {
        limit: 500,
        fields: {
          name: { sel: "a.name", get: "text" },
          url: { sel: "a.name", get: "href" },
          phone: { sel: "a[href^='tel:']", get: "href" },
        },
      });

      assert.strictEqual(out.count, 24);
      // 24 rows, every one with a name and url; phone is null on 2 per page.
      assert.strictEqual(out.fill_rates.name, 24, JSON.stringify(out.fill_rates));
      assert.strictEqual(out.fill_rates.url, 24);
      assert.strictEqual(out.fill_rates.phone, 20);
      assert.strictEqual(
        out.baseline_fill_rates,
        undefined,
        "the ambiguously-named key is still there",
      );
      // Ratios stay fractions, since they are compared across pages of
      // differing size.
      assert.ok(
        out.baseline_fill_ratios.phone > 0.8 && out.baseline_fill_ratios.phone < 0.9,
        JSON.stringify(out.baseline_fill_ratios),
      );
      assert.strictEqual(out.baseline_fill_ratios.name, 1);
      ext.ws.close();
    } finally {
      srv.proc.kill();
    }
  });
}

// ───────── L. bridge handshake origin check ─────────

// Connect and report how the handshake ended, without caring which of the two
// failure shapes `ws` produces for a rejected upgrade (it can surface either an
// "unexpected-response" event or a plain error depending on timing).
function handshake(origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://localhost:${PORT}`,
      origin ? { origin } : undefined,
    );
    const done = (v) => {
      try {
        ws.close();
      } catch (_) {
        /* already dead */
      }
      resolve(v);
    };
    ws.on("open", () => done({ accepted: true }));
    ws.on("unexpected-response", (_req, res) => done({ accepted: false, status: res.statusCode }));
    ws.on("error", (err) => done({ accepted: false, error: err.message }));
    setTimeout(() => done({ accepted: false, error: "timeout" }), 5000);
  });
}

async function groupL() {
  console.log("\nL. bridge handshake origin check");

  const srv = startServer();
  try {
    await waitFor("listening", () =>
      srv.stderr.includes("WebSocket server listening"),
    );

    await test("L1 a page origin is refused before it can impersonate the extension", async () => {
      // The drive-by: any site the user visits may open ws:// to loopback. If
      // it gets in, the nodeId-less branch installs it as `extensionSocket`,
      // dropping the real extension and taking over every later command.
      const r = await handshake("https://evil.example");
      assert.strictEqual(r.accepted, false, "a page origin completed the handshake");
      assert.ok(
        r.status === 403 || /403|unexpected server response/i.test(r.error || ""),
        `expected a 403 refusal, got ${JSON.stringify(r)}`,
      );
    });

    await test("L2 the refusal is logged, not silent", () => {
      assert.ok(
        srv.stderr.includes("Refused WebSocket handshake from origin https://evil.example"),
        "a rejected handshake must be distinguishable from an extension that never connected",
      );
    });

    await test("L3 the extension's own origin is accepted", async () => {
      const r = await handshake("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
      assert.strictEqual(r.accepted, true, JSON.stringify(r));
    });

    await test("L4 a Secondary node (no Origin header) is accepted", async () => {
      // Node's ws client sends no Origin. This is the path every Secondary MCP
      // server takes, so refusing it would break multi-agent mode outright.
      const r = await handshake(null);
      assert.strictEqual(r.accepted, true, JSON.stringify(r));
    });

    await test("L5 a real extension still drives a command end to end", async () => {
      // The check sits on the handshake, so prove the accepted path is not just
      // open but functional.
      await initialize(srv);
      const ext = fakeExtension();
      await waitFor("extension connected", () => ext.open);
      await waitFor("server saw it", () => srv.stderr.includes("Chrome extension connected"));
      const reply = await rpc(srv, "tools/call", {
        name: "browser_get_url",
        arguments: {},
      });
      assert.ok(textOf(reply).includes("http://t/"), textOf(reply));
      ext.ws.close();
    });
  } finally {
    srv.proc.kill();
    await sleep(200);
  }
}

// ───────────────────────────── runner ─────────────────────────────

(async () => {
  console.log("PolterTab regression suite");
  await groupA();
  await groupB();
  await groupC();
  await groupD();
  await groupE();
  await groupF();
  await groupG();
  await groupH();
  await groupI();
  await groupJ();
  await groupK();
  await groupL();

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    console.log(`failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  process.exit(0);
})();
