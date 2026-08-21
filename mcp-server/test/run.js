#!/usr/bin/env node
// PolterTab regression suite. Covers both halves of the project:
//   A  source invariants that are cheap to assert and easy to regress
//   B  content_script.js injection idempotence   (the N-clicks-per-command bug)
//   C  background.js navigation load race        (the 30s hang on fast pages)
//   D  mcp-server end-to-end over stdio          (output_file, stdout purity)
//   E  shadow DOM piercing + late-element retry  (the OCI-console class of bug)
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
  };
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
    status: "complete",
  });

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
          const t = { ...tab(id), url: props.url || "about:blank" };
          maybeFire(id);
          return t;
        },
        update: async (id, props) => {
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

  await test("C3 fast page via existing tab resolves too", async () => {
    const bg = backgroundSandbox();
    bg.cfg.activeTabs = [{ id: 7, url: "http://old/", title: "old" }];
    bg.cfg.fireOnCompleteFor = 7;
    bg.command({ id: "n3", action: "navigate", url: "http://fast.test/" });
    await waitFor("navigate reply", () => bg.replyFor("n3"), 5000);
    assert.strictEqual(bg.replyFor("n3").success, true);
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

function startServer() {
  const proc = spawn(process.execPath, [SERVER, "--port", String(PORT)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, POLTERTAB_HOME: HOME },
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
      assert.strictEqual(names.length, 21, `got ${names.length} tools`);
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
    getAttribute: () => null,
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
  const match = (el, sel) =>
    sel === "*" || (sel.startsWith("#") && el.id === sel.slice(1));
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

          if (!frame) {
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

  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed`);
  if (failures.length) {
    console.log(`failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  process.exit(0);
})();
