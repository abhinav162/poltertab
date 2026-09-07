// Shared test harness: the runner, and the fake DOM / fake extension / real
// process sandboxes every group builds its cases on.
//
// These sandboxes are the reusable asset of this suite — a fake DOM faithful
// enough to reproduce branded value setters and closed shadow roots, and a fake
// extension that speaks the real wire protocol. They spent their life inline in
// a 2,700-line file, which made them invisible to anyone writing a new group.
//
// No framework, deliberately: plain asserts, real processes.

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

const TOOLS = path.join(REPO, "mcp-server", "tools.js");

// The tool surface moved out of index.js. Read it from one place so a future
// move is a one-line change here rather than six greps that quietly find
// nothing — an empty tool list makes several of these assertions pass
// vacuously, so toolNames() refuses to return one.
function toolNames() {
  const names = [
    ...fs
      .readFileSync(TOOLS, "utf8")
      .matchAll(/name:\s*"browser_([a-z_]+)"/g),
  ].map((m) => m[1]);
  assert.ok(names.length >= 21, `only found ${names.length} tools`);
  return names;
}

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

// ────────────── B. content_script injection idempotence ──────────────

function contentScriptSandbox() {
  let clicks = 0;
  const appended = [];
  const messageListeners = [];
  const commandListeners = [];

  const el = {
    tagName: "BUTTON",
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({
      left: 0, top: 0, right: 20, bottom: 20, width: 20, height: 20,
    }),
    contains(n) {
      return n === el;
    },
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
    // the actionability gate hit-tests before it clicks
    elementFromPoint: () => el,
    body: { innerText: "" },
  };

  const sandbox = {
    console: { log() {}, error() {} },
    setTimeout,
    clearTimeout,
    document,
    getComputedStyle: computedStyleOf,
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

// ───────── E. shadow DOM piercing + late-element retry ─────────

// content_script's actionability gate asks three things before it acts — is the
// element visible, enabled, and the real target a click would land on. The fake
// DOM has to answer them or the gate is untestable. Each element gets a unique
// on-screen box; elementFromPoint maps a box's centre back to its element, or to
// whatever a test declared is covering it. Faithful enough to drive the gate
// without a layout engine.
let rectSeq = 0;
const hitRegistry = new Map(); // "cx,cy" -> element

function giveGeometry(el, opts) {
  el.disabled = !!opts.disabled;
  el.__coveredBy = opts.coveredBy || null;
  el.__style = {
    display: opts.hidden ? "none" : "block",
    visibility: "visible",
    opacity: "1",
  };
  const k = ++rectSeq;
  el.__rect = opts.hidden
    ? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    : { left: k * 50, top: 0, right: k * 50 + 20, bottom: 20, width: 20, height: 20 };
  el.getBoundingClientRect = () => el.__rect;
  el.contains = (n) => n === el;
  if (!opts.hidden) hitRegistry.set(`${el.__rect.left + 10},10`, el);
  return el;
}

function elementFromPoint(x, y) {
  const el = hitRegistry.get(`${x},${y}`);
  if (!el) return null;
  return el.__coveredBy || el;
}

const computedStyleOf = (el) =>
  el.__style || { display: "block", visibility: "visible", opacity: "1" };

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
  giveGeometry(el, opts);
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
    __attrs: { ...(opts.attrs || {}) },
    getAttribute: (k) => (k in el.__attrs ? el.__attrs[k] : null),
    matches: () => false,
    dispatchEvent(e) {
      el.events.push(e.type);
      return true;
    },
  });
  if (kind !== "div") el.__brand = kind;
  giveGeometry(el, opts);
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
    // the actionability gate hit-tests the element it is about to act on
    elementFromPoint,
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
    getComputedStyle: computedStyleOf,
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

// The counters `test` maintains, for the runner to report on.
const results = () => ({ pass, failures });

module.exports = {
  assert, fs, os, path, vm, spawn, WebSocket,
  results,
  REPO,
  EXT,
  SERVER,
  TOOLS,
  toolNames,
  PORT,
  TAB,
  HOME,
  DOWNLOADS,
  pass,
  failures,
  test,
  sleep,
  waitFor,
  contentScriptSandbox,
  backgroundSandbox,
  startServer,
  rpcId,
  rpc,
  findReply,
  initialize,
  fakeExtension,
  textOf,
  fakeEl,
  FakeHTMLElement,
  FakeHTMLInputElement,
  FakeHTMLTextAreaElement,
  fakeField,
  fakeRoot,
  shadowSandbox,
  frameSearchSandbox,
  recEl,
  recDescendants,
  recMatchOne,
  recMatch,
  recordSandbox,
  agentCard,
  AGENT_FIELDS,
  scriptedExtension,
  page12,
  callExtractAll,
  memoryHome,
  withServer,
  getMemory,
  handshake,
};
