// PolterTab Background Service Worker — WebSocket client + command router
// Connects to bridge-server at ws://localhost:7822 and routes commands to content scripts or Chrome APIs.
//
// MV3 service workers get suspended after ~30s of inactivity. A dropped
// connection is redialled at once and then on a back-off (bg/reconnect.js)
// while the worker is awake; chrome.alarms (which persist across suspensions)
// are the backstop that reconnects a worker suspended mid-schedule.

importScripts(
  "bg/tab-state.js",
  "bg/frames.js",
  "bg/screenshot.js",
  "bg/reconnect.js",
  "bg/upload.js",
);

(() => {
  // Mirrors mcp-server/config.js. It cannot be required from here — this runs
  // in Chrome, there is no build step, and MV3 forbids remote code — so the two
  // copies are kept in sync by hand. Read the timeout budget in that file
  // before changing any of the waits below: each layer's budget must exceed the
  // sum of what it waits on, or a slow-but-successful load surfaces to the
  // agent as a timeout it can only answer by guessing whether to retry.
  const DEFAULT_WS_PORT = 7822;

  // Navigation: the server allows 35s for the whole command, so this plus the
  // settle below has to leave room for the reply to get back.
  const NAV_TIMEOUT_MS = 30000;
  // Let the document's own scripts run before we act on it.
  const NAV_SETTLE_MS = 500;
  // How often waitForTabLoad re-checks the load epoch while waiting.
  const LOAD_POLL_MS = 100;

  // MV3 suspends a service worker after ~30s idle. The keepalive fires inside
  // that window while connected; the reconnect poll runs when it is not.
  const KEEPALIVE_MINUTES = 0.33; // ~20s
  const RECONNECT_MINUTES = 0.08; // ~5s

  let WS_PORT = DEFAULT_WS_PORT;
  let WS_URL = `ws://localhost:${WS_PORT}`;
  const RECONNECT_ALARM = "poltertab-reconnect";
  const KEEPALIVE_ALARM = "poltertab-keepalive";

  // The error codes the tool contract names. They reach the agent as a
  // bracketed prefix on the message; tools.js documents each one by name, and
  // group-a A15 fails if a code thrown here is not documented there, or if a
  // new one is hand-written into a message instead of declared here.
  const ERR = {
    NEEDS_USER_PERMISSION: "needs_user_permission",
    TAB_NOT_FOUND: "tab_not_found",
  };

  let ws = null;
  let isConnected = false;
  let activeSessions = [];
  // Learned from the server's reply to extension_ready; cleared on disconnect
  // so the popup never shows a stale comparison against a server that is gone.
  let serverVersion = null;
  // The most recent pair code pushed by the server. Cleared on disconnect or
  // when uploads_paired arrives. Never written to storage or sent to web pages.
  let currentPairCode = null;

  // Pending upload-config/log requests from the options page. Maps _replyId → sendResponse.
  const pendingUploadsReplies = new Map();

  // "example.com" -> "https://example.com"; a url that already names its
  // scheme is left alone. tab_new also accepts about: urls (about:blank is its
  // default), which nothing else does.
  function normalizeUrl(url, { allowAbout = false } = {}) {
    if (url.startsWith("http")) return url;
    if (allowAbout && url.startsWith("about:")) return url;
    return `https://${url}`;
  }

  // --- Session Manager ---

  const sessionManager = self.PT.makeSessionManager({
    waitForTabLoad,
    normalizeUrl,
    ERR,
  });

  // Built here, above ROUTES, because ROUTES names `screenshot` directly: a
  // const declared further down would still be in its temporal dead zone when
  // the table is evaluated.
  const { forwardToContentScript } = self.PT.makeFrames({ sessionManager });
  const { screenshot } = self.PT.makeScreenshot({ sessionManager });
  const upload = self.PT.makeUpload({ sessionManager, forwardToContentScript });
  const { uploadFile } = upload;
  const reconnect = self.PT.makeReconnect({ connect });

  // --- WebSocket connection management ---

  function connect() {
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    let sock;
    try {
      sock = new WebSocket(WS_URL);
    } catch (err) {
      console.error("[PolterTab] WebSocket creation failed:", err.message);
      ensureReconnectAlarm();
      reconnect.disconnected();
      return;
    }
    ws = sock;

    sock.onopen = () => {
      console.log("[PolterTab] Connected to bridge server");
      isConnected = true;
      reconnect.connected();
      // Stop reconnect polling — we're connected
      chrome.alarms.clear(RECONNECT_ALARM);
      // Start keep-alive to prevent service worker suspension while connected
      chrome.alarms.create(KEEPALIVE_ALARM, {
        periodInMinutes: KEEPALIVE_MINUTES,
      });
      send({
        type: "extension_ready",
        version: chrome.runtime.getManifest().version,
      });
      send({ type: "request_full_state" });
      broadcastState();
    };

    sock.onmessage = async (event) => {
      reconnect.up();
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        send({ success: false, error: "Invalid JSON from bridge server" });
        return;
      }

      if (msg.type === "state_update") {
        activeSessions = msg.sessions || [];
        broadcastState();
        return;
      }

      // The server answers our extension_ready with its own version. Without
      // this the popup can show our version but has nothing to compare it to.
      if (msg.type === "server_version") {
        serverVersion = msg.version || null;
        broadcastState();
        return;
      }

      // pair_code — server pushes a 4-character code to unpaired extensions.
      // Store it for the popup/options page; never log or persist it.
      if (msg.type === "pair_code") {
        currentPairCode = msg.code || null;
        broadcastState();
        return;
      }

      // uploads_paired — pairing succeeded; clear the code and let pages re-render.
      if (msg.type === "uploads_paired") {
        currentPairCode = null;
        broadcastState();
        // Let any open options page know it should reload its config.
        chrome.runtime.sendMessage({ type: "uploads_paired_notice" }).catch(() => {});
        return;
      }

      // Relay uploads config/log responses back to the options page.
      if (
        msg.type === "uploads_config" ||
        msg.type === "uploads_config_result" ||
        msg.type === "uploads_log" ||
        msg.type === "uploads_not_paired" ||
        msg.type === "uploads_error"
      ) {
        const replyFn = msg._replyId ? pendingUploadsReplies.get(msg._replyId) : null;
        if (replyFn) {
          pendingUploadsReplies.delete(msg._replyId);
          // not_paired and error are failures; the options page branches on
          // msg.type regardless, but keep ok honest for anything that only
          // checks it. config_result carries its own ok, which ...msg preserves.
          const ok = msg.type !== "uploads_error" && msg.type !== "uploads_not_paired";
          // Include the current pair code so the options page can show it
          // without a second round-trip.
          replyFn({ ok, pairCode: currentPairCode, ...msg });
        }
        return;
      }

      const { id, action, ...params } = msg;
      try {
        const result = await handleCommand(action, params);
        send({ id, success: true, data: result });
      } catch (err) {
        send({ id, success: false, error: err.message });
      }
    };

    sock.onerror = (err) => {
      console.error(
        "[PolterTab] WebSocket error:",
        err.message || "connection error",
      );
    };

    sock.onclose = () => {
      // connect() replaces a socket that is already CLOSING, so this close can
      // arrive after a newer socket took over. Acting on it would orphan that
      // one and dial a second beside it.
      if (ws !== sock) return;
      console.log("[PolterTab] Disconnected from bridge server");
      ws = null;
      isConnected = false;
      activeSessions = [];
      serverVersion = null;
      currentPairCode = null;
      broadcastState();
      // Stop keep-alive; redial now and on a back-off, with the alarm as the
      // backstop if the worker is suspended before that succeeds.
      chrome.alarms.clear(KEEPALIVE_ALARM);
      ensureReconnectAlarm();
      reconnect.disconnected();
    };
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function broadcastState() {
    chrome.runtime
      .sendMessage({
        type: "state_update",
        state: {
          connected: isConnected,
          sessions: activeSessions,
          version: chrome.runtime.getManifest().version,
          serverVersion,
          pairCode: currentPairCode,
        },
      })
      .catch(() => {});
  }

  // Alarm-based reconnection: survives service worker suspension
  function ensureReconnectAlarm() {
    chrome.alarms.get(RECONNECT_ALARM, (alarm) => {
      if (!alarm) {
        // Poll every 5s to reconnect
        chrome.alarms.create(RECONNECT_ALARM, {
          delayInMinutes: RECONNECT_MINUTES,
          periodInMinutes: RECONNECT_MINUTES,
        });
      }
    });
  }

  // --- Alarm listener (wakes the service worker) ---
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RECONNECT_ALARM) {
      connect();
    }
    if (alarm.name === KEEPALIVE_ALARM) {
      // Send ping to keep connection alive + prevent worker suspension
      if (ws && ws.readyState === WebSocket.OPEN) {
        send({ type: "ping" });
      } else {
        // Connection lost — switch to reconnect mode
        chrome.alarms.clear(KEEPALIVE_ALARM);
        ensureReconnectAlarm();
      }
    }
  });

  // --- Background Message Listener ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "get_status") {
      if (!isConnected) {
        connect();
      }
      sendResponse({ connected: isConnected, sessions: activeSessions, pairCode: currentPairCode });
      return true;
    }

    if (message.type === "force_refresh") {
      if (isConnected) {
        send({ type: "request_full_state" });
      } else {
        connect();
      }
      sendResponse({ connected: isConnected, sessions: activeSessions });
      return true;
    }

    // Relay uploads config/log requests from options page → bridge server.
    if (
      message.type === "uploads_get_config" ||
      message.type === "uploads_set_config" ||
      message.type === "uploads_get_log"
    ) {
      // Only relay from this extension's own pages (options, popup) — never from
      // a web page. The url-prefix check is the airtight test: a content
      // script's sender.url is the web page's URL, so it fails the prefix; only
      // our own pages pass. We must NOT also require !sender.tab — options_page
      // opens the options page in a full tab, so its sender.tab is set and that
      // clause would drop every request the panel sends.
      if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL(""))) {
        return;
      }
      if (!isConnected) {
        sendResponse({ ok: false, error: "Not connected to bridge server." });
        return true;
      }
      const replyId = Date.now().toString(36) + Math.random().toString(36).slice(2);
      pendingUploadsReplies.set(replyId, sendResponse);
      // Drop the pending reply if the server never answers, so a dangling
      // sendResponse doesn't leak until the worker suspends. The options page
      // gives up at 6 s; clean up a little after that.
      setTimeout(() => {
        if (pendingUploadsReplies.has(replyId)) {
          pendingUploadsReplies.delete(replyId);
          try { sendResponse({ ok: false, error: "Timed out waiting for the server." }); } catch (_) {}
        }
      }, 8000);
      send({ type: message.type, _replyId: replyId, ...message.data });
      return true;
    }

    // Intercepted Network Data from MAIN world (via content script)
    if (message && message.type === "ZC_NETWORK_DATA") {
      const tabId = sender.tab
        ? sender.tab.id
        : sessionManager.pointer({}).tabId;
      if (tabId) {
        send({
          type: "network_data",
          tabId: tabId,
          url: message.url,
          body: message.body,
        });
      }
      return;
    }
  });

  // --- Tab lifecycle listeners ---

  chrome.tabs.onRemoved.addListener((closedTabId) => {
    // Load first. On a freshly woken worker the pointers are still empty, so
    // acting on them finds nothing to forget and persists nothing — and the
    // stale pointer is read back from session storage afterwards. tab_list
    // then reports neither a current tab nor the closed one, which is the one
    // case the agent most needs told.
    sessionManager
      .load()
      .then(() => sessionManager.handleTabRemoved(closedTabId));
    send({ type: "tab_closed", tabId: closedTabId });
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    sessionManager.handleTabUpdated(tabId, changeInfo);
  });

  // tabId -> timestamp of the last completed top-frame load. Registered once,
  // at worker start, so no navigation's completion event can be missed.
  const tabLoadEpoch = new Map();
  chrome.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId === 0) tabLoadEpoch.set(details.tabId, Date.now());
  });
  chrome.tabs.onRemoved.addListener((closedTabId) => {
    tabLoadEpoch.delete(closedTabId);
  });

  // --- Command routing ---

  // The action word is the contract between four places: the MCP tool name, the
  // server's dispatch, this table, and content_script's own handler map. Nothing
  // used to check that they agreed, so a typo here surfaced as
  // "Unknown action: scrap" on a user's machine, mid-scrape. A table rather than
  // a switch so the suite can read the routes back and assert against the
  // server's tool list.
  //
  // So the repetition below is LOAD-BEARING, not something to tidy up. group-a
  // A10 and A11 parse the route NAMES out of this object literal's source text,
  // and A12 counts the literal forwardToContentScript("…") calls. Generating
  // these entries from an array would still run, and would silently switch off
  // the check that four files spell each action the same way.
  const ROUTES = {
    // Background-handled: these need chrome.* APIs the page cannot reach.
    navigate,
    screenshot,
    get_title: getTitle,
    get_url: getUrl,

    // Forwarded into the page, across every frame.
    click: (p) => forwardToContentScript("click", p),
    fill: (p) => forwardToContentScript("fill", p),
    snapshot: (p) => forwardToContentScript("snapshot", p),
    scrape: (p) => forwardToContentScript("scrape", p),
    extract: (p) => forwardToContentScript("extract", p),
    scroll: (p) => forwardToContentScript("scroll", p),
    hover: (p) => forwardToContentScript("hover", p),
    get_text: (p) => forwardToContentScript("get_text", p),
    update_patterns: (p) => forwardToContentScript("update_patterns", p),

    // Stored globally so new tabs inherit them, then pushed to every open tab.
    set_intercept_patterns: async (params) => {
      await chrome.storage.local.set({
        zc_intercept_patterns: params.patterns,
      });
      const allTabs = await chrome.tabs.query({});
      allTabs.forEach((t) =>
        chrome.tabs
          .sendMessage(t.id, {
            source: "poltertab",
            action: "update_patterns",
            params,
          })
          .catch(() => {}),
      );
      return { success: true, patterns: params.patterns };
    },

    // Session management (accepts "name" or "session" as the identifier).
    session_create: (p) => sessionManager.create(p.name || p.session, p.url, p),
    session_switch: (p) => sessionManager.switch(p.name || p.session, p),
    session_list: (p) => sessionManager.list(p),
    session_close: (p) => sessionManager.close(p.name || p.session, p),
    session_context: (p) => sessionManager.context(p),

    // Tabs, for one agent driving several at once. Each agent has its own
    // current tab; untargeted calls go there, `tabId`/`session` override it.
    tab_new: (p) => sessionManager.tabNew(p),
    tab_list: (p) => sessionManager.tabList(p),
    tab_switch: (p) => sessionManager.tabSwitch(p),
    tab_close: (p) => sessionManager.tabClose(p),

    // File upload: picker (CDP intercept) or drop (DataTransfer injection).
    upload_file: async (p) => {
      chrome.action.setBadgeText({ text: "↑" });
      chrome.action.setBadgeBackgroundColor({ color: "#666" });
      try {
        return await uploadFile(p);
      } finally {
        chrome.action.setBadgeText({ text: "" });
      }
    },
  };

  const SELF_NAV_ACTIONS = new Set([
    "navigate", "tab_new", "click", "fill", "snapshot", "scrape", "extract",
  ]);

  async function handleCommand(action, params) {
    // Self-navigation guard: refuse commands targeting extension pages.
    if (SELF_NAV_ACTIONS.has(action)) {
      // For actions that carry an explicit URL target, check it case-insensitively.
      const urlParam = (params && (params.url || params.target)) || "";
      if (typeof urlParam === "string" && urlParam) {
        let isSelfNav = false;
        try { isSelfNav = new URL(urlParam).protocol.toLowerCase() === "chrome-extension:"; } catch (_) {}
        if (isSelfNav) {
          throw new Error("[self_navigation_refused] Agent commands cannot target extension pages.");
        }
      } else {
        // For actions that act on the current tab (no URL param), resolve the
        // acting tab and refuse if it is an extension page.
        const tabId = sessionManager.pointer(params || {}).tabId;
        if (tabId) {
          try {
            const tab = await chrome.tabs.get(tabId);
            if (tab && tab.url) {
              let proto = "";
              try { proto = new URL(tab.url).protocol.toLowerCase(); } catch (_) {}
              if (proto === "chrome-extension:") {
                throw new Error("[self_navigation_refused] Agent commands cannot target extension pages.");
              }
            }
          } catch (err) {
            if (err.message && err.message.includes("self_navigation_refused")) throw err;
            // Tab gone or inaccessible — not a self-nav violation.
          }
        }
      }
    }
    const route = ROUTES[action];
    if (!route) throw new Error(`Unknown action: ${action}`);
    return route(params);
  }

  // --- Background-handled commands ---

  async function navigate(params) {
    const { url } = params;
    if (!url) throw new Error("navigate requires a 'url' parameter");

    const targetUrl = normalizeUrl(url);

    // Resolve tab via session manager
    const resolvedTabId = await sessionManager.resolve(params, {
      navigating: true,
    });

    let tab;
    const since = Date.now();
    if (resolvedTabId) {
      tab = await chrome.tabs.update(resolvedTabId, { url: targetUrl });
    } else {
      // Nothing resolved means nothing has been navigated yet by this agent
      // (or its tab was closed, or `session` names a new one). This runs
      // against the user's real browser, so the old behaviour here —
      // commandeering whatever tab they happened to be looking at — navigated
      // them away from their own work. Open our own tab instead; it becomes
      // the agent's current tab, so a paginating loop still reuses one tab
      // rather than opening hundreds.
      tab = await chrome.tabs.create({ url: targetUrl });
      sessionManager.owned.add(tab.id);
    }
    tab = await waitForTabLoad(tab.id, since);

    // If a session param was provided, create/update the named session for this tab
    if (params.session) {
      const existing = sessionManager.sessions[params.session];
      if (existing) {
        existing.tabId = tab.id;
        existing.url = tab.url;
        existing.title = tab.title;
        existing.lastUsedAt = Date.now();
      } else {
        sessionManager.sessions[params.session] = {
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        };
        await sessionManager.addTabToGroup(tab.id);
      }
    }

    // The tab just navigated is where this agent now is — what "omit tabId to
    // use the last tab navigated" promises. An explicit tabId is a one-off, as
    // on every other tool, and leaves the pointer where it was.
    if (params.tabId == null) {
      sessionManager.point(
        sessionManager.pointer(params),
        tab.id,
        params.session || null,
      );
    }
    await sessionManager.persist();

    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      status: tab._loadTimedOut ? "timeout_but_loaded" : "ok",
    };
  }

  // Resolves once the tab reports a top-frame load that finished at or after
  // `since` (captured BEFORE the navigation is issued). The old version
  // attached a fresh onCompleted listener after chrome.tabs.create/update had
  // already begun loading, so a fast page — localhost, cached, small static —
  // completed before the listener existed and the command hung for the full
  // 30s. The persistent listener above cannot miss an event, and comparing
  // against `since` ignores loads that predate this navigation without any
  // brittle URL matching (so redirects still work).
  // ponytail: tabLoadEpoch is in-memory, so an MV3 service-worker suspension
  // mid-navigation falls back to the timeout. Persist to session storage if
  // that ever shows up in practice.
  async function waitForTabLoad(tabId, since, timeoutMs = NAV_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const loadedAt = tabLoadEpoch.get(tabId);
      if (loadedAt !== undefined && loadedAt >= since) {
        // Let the document's own scripts settle before we act on it.
        await new Promise((r) => setTimeout(r, NAV_SETTLE_MS));
        return chrome.tabs.get(tabId);
      }
      try {
        await chrome.tabs.get(tabId);
      } catch {
        throw new Error("Tab was closed during navigation");
      }
      await new Promise((r) => setTimeout(r, LOAD_POLL_MS));
    }

    // The deadline passed without an onCompleted we could match, which is not
    // the same thing as a page that failed to load. The epoch is in-memory, so
    // an MV3 worker suspension mid-navigation loses it; an SPA soft-navigation
    // never fires onCompleted at all. Both cases used to throw "Navigation
    // timed out" over a fully loaded page — an error the caller can only answer
    // by guessing whether to retry.
    //
    // Ask the tab what it actually did, and report that instead.
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error("Tab was closed during navigation");
    }
    if (tab.status === "complete") {
      return { ...tab, _loadTimedOut: true };
    }
    throw new Error(
      `Navigation timed out after ${Math.round(timeoutMs / 1000)}s (tab status: ${tab.status})`,
    );
  }

  // The tab a command resolves to, fetched. Both readers below want the same
  // two fields and differ only in which one they lead with.
  async function resolveAndGet(params) {
    return chrome.tabs.get(await sessionManager.resolveOrFallback(params));
  }

  async function getTitle(params) {
    const tab = await resolveAndGet(params);
    return { title: tab.title, url: tab.url, tabId: tab.id };
  }

  async function getUrl(params) {
    const tab = await resolveAndGet(params);
    return { url: tab.url, title: tab.title, tabId: tab.id };
  }

  // File upload: route CDP events to the upload module (A16 — listeners live here).
  // Guard for test environments where chrome.debugger may not be stubbed.
  if (chrome.debugger && chrome.debugger.onEvent) {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      upload._handleDebuggerEvent(source, method, params);
    });
  }

  // --- Startup ---
  function init() {
    chrome.storage.local.get(["wsPort"], (result) => {
      if (result.wsPort) {
        WS_PORT = result.wsPort;
        WS_URL = `ws://localhost:${WS_PORT}`;
      }
      connect();
    });
  }

  init();

  // Re-connect on service worker wake-up events
  chrome.runtime.onStartup.addListener(init);
  chrome.runtime.onInstalled.addListener(init);

  // Hot-swap connection if port changes in options
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.wsPort) {
      WS_PORT = changes.wsPort.newValue;
      WS_URL = `ws://localhost:${WS_PORT}`;

      if (ws) {
        ws.onclose = null; // Disable auto-reconnect temporarily
        ws.close();
        ws = null;
      }
      chrome.alarms.clear(KEEPALIVE_ALARM);
      chrome.alarms.clear(RECONNECT_ALARM);
      reconnect.reset();
      connect();
    }
  });
})();
