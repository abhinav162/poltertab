// PolterTab Background Service Worker — WebSocket client + command router
// Connects to bridge-server at ws://localhost:7822 and routes commands to content scripts or Chrome APIs.
//
// MV3 service workers get suspended after ~30s of inactivity.
// We use chrome.alarms (which persist across suspensions) to ensure reconnection
// whenever the bridge server restarts.

(() => {
  let WS_PORT = 7822;
  let WS_URL = `ws://localhost:${WS_PORT}`;
  const RECONNECT_ALARM = "poltertab-reconnect";
  const KEEPALIVE_ALARM = "poltertab-keepalive";
  const STORAGE_KEY = "zc_sessions";

  let ws = null;
  let isConnected = false;
  let activeSessions = [];
  // Learned from the server's reply to extension_ready; cleared on disconnect
  // so the popup never shows a stale comparison against a server that is gone.
  let serverVersion = null;

  // --- Session Manager ---

  class SessionManager {
    constructor() {
      this.sessions = {};
      this.activeSession = null;
      this.groupId = null;
      this.loaded = false;
      // Implicit tab tracking: remembers the last tab we navigated,
      // so subsequent commands target it even without explicit sessions.
      this.lastNavigatedTabId = null;
    }

    async load() {
      if (this.loaded) return;
      try {
        const result = await chrome.storage.local.get(STORAGE_KEY);
        if (result[STORAGE_KEY]) {
          this.sessions = result[STORAGE_KEY];
          // Mark all tabs as potentially stale (will be validated on use)
        }
      } catch (err) {
        console.error("[PolterTab] Failed to load sessions:", err.message);
      }
      this.loaded = true;
    }

    async persist() {
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: this.sessions });
      } catch (err) {
        console.error("[PolterTab] Failed to persist sessions:", err.message);
      }
    }

    async ensureTabGroup() {
      if (this.groupId !== null) {
        try {
          await chrome.tabGroups.get(this.groupId);
          return this.groupId;
        } catch {
          this.groupId = null;
        }
      }
      try {
        const groups = await chrome.tabGroups.query({ title: "PolterTab" });
        if (groups.length > 0) {
          this.groupId = groups[0].id;
          return this.groupId;
        }
      } catch {
        // tabGroups API may not be available
      }
      return null;
    }

    async addTabToGroup(tabId) {
      try {
        const existingGroupId = await this.ensureTabGroup();
        if (existingGroupId) {
          await chrome.tabs.group({ tabIds: tabId, groupId: existingGroupId });
        } else {
          const newGroupId = await chrome.tabs.group({ tabIds: tabId });
          await chrome.tabGroups.update(newGroupId, {
            title: "PolterTab",
            color: "blue",
            collapsed: false,
          });
          this.groupId = newGroupId;
        }
      } catch (err) {
        console.warn("[PolterTab] Failed to add tab to group:", err.message);
      }
    }

    async create(name, url) {
      await this.load();
      if (!name) throw new Error("session_create requires a 'name' parameter");

      let tab;
      if (url) {
        const targetUrl = url.startsWith("http") ? url : `https://${url}`;
        const since = Date.now();
        tab = await chrome.tabs.create({ url: targetUrl });
        tab = await waitForTabLoad(tab.id, since);
      } else {
        const [activeTab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!activeTab) throw new Error("No active tab to bind session to");
        tab = activeTab;
      }

      await this.addTabToGroup(tab.id);

      this.sessions[name] = {
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      };
      this.activeSession = name;
      await this.persist();

      return { name, tabId: tab.id, url: tab.url, title: tab.title };
    }

    async switch(name) {
      await this.load();
      const session = this.sessions[name];
      if (!session) throw new Error(`Session "${name}" not found`);

      // Validate tab still exists
      if (session.tabId !== null) {
        try {
          const tab = await chrome.tabs.get(session.tabId);
          session.url = tab.url;
          session.title = tab.title;
        } catch {
          session.tabId = null; // Tab no longer exists
        }
      }

      // Auto-recover if tab is stale
      if (session.tabId === null) {
        await this.recoverSession(name);
      }

      session.lastUsedAt = Date.now();
      this.activeSession = name;
      await this.persist();

      return {
        name,
        tabId: session.tabId,
        url: session.url,
        title: session.title,
      };
    }

    async recoverSession(name) {
      const session = this.sessions[name];
      if (!session || !session.url)
        throw new Error(`Session "${name}" has no URL to recover`);

      const since = Date.now();
      const tab = await chrome.tabs.create({ url: session.url });
      const updated = await waitForTabLoad(tab.id, since);

      await this.addTabToGroup(updated.id);

      session.tabId = updated.id;
      session.url = updated.url;
      session.title = updated.title;
      session.lastUsedAt = Date.now();
      await this.persist();

      return session;
    }

    async resolve(params) {
      await this.load();

      // 1. Explicit tabId — escape hatch
      if (params.tabId) return params.tabId;

      // 2. Explicit session param — look up and set active
      if (params.session) {
        const session = this.sessions[params.session];
        if (session) {
          if (session.tabId !== null) {
            try {
              await chrome.tabs.get(session.tabId);
              this.activeSession = params.session;
              session.lastUsedAt = Date.now();
              await this.persist();
              return session.tabId;
            } catch {
              session.tabId = null;
            }
          }
          // Auto-recover
          await this.recoverSession(params.session);
          this.activeSession = params.session;
          return session.tabId;
        }
        // Session doesn't exist yet — fall through
      }

      // 3. Active session
      if (this.activeSession) {
        const session = this.sessions[this.activeSession];
        if (session && session.tabId !== null) {
          try {
            await chrome.tabs.get(session.tabId);
            session.lastUsedAt = Date.now();
            return session.tabId;
          } catch {
            session.tabId = null;
            this.activeSession = null;
          }
        } else {
          this.activeSession = null;
        }
      }

      // 4. Implicit tab tracking — last tab we navigated to
      if (this.lastNavigatedTabId !== null) {
        try {
          await chrome.tabs.get(this.lastNavigatedTabId);
          return this.lastNavigatedTabId;
        } catch {
          this.lastNavigatedTabId = null;
        }
      }

      // 5. Legacy fallback — active Chrome tab
      return null;
    }

    async resolveOrFallback(params) {
      const resolved = await this.resolve(params);
      if (resolved) return resolved;

      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!activeTab) throw new Error("No active tab found");
      return activeTab.id;
    }

    async list() {
      await this.load();
      const entries = [];

      for (const [name, session] of Object.entries(this.sessions)) {
        let status = "alive";
        if (session.tabId === null) {
          status = session.url ? "recoverable" : "expired";
        } else {
          try {
            await chrome.tabs.get(session.tabId);
          } catch {
            session.tabId = null;
            status = session.url ? "recoverable" : "expired";
          }
        }
        entries.push({
          name,
          tabId: session.tabId,
          url: session.url,
          title: session.title,
          status,
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
        });
      }

      await this.persist();
      return { sessions: entries, active: this.activeSession };
    }

    async close(name) {
      await this.load();
      const session = this.sessions[name];
      if (!session) throw new Error(`Session "${name}" not found`);

      if (session.tabId !== null) {
        try {
          await chrome.tabs.remove(session.tabId);
        } catch {
          // Tab may already be closed
        }
      }

      delete this.sessions[name];
      if (this.activeSession === name) {
        this.activeSession = null;
      }
      await this.persist();

      return { closed: name };
    }

    async context() {
      await this.load();
      let tabInfo = null;

      if (this.activeSession) {
        const session = this.sessions[this.activeSession];
        if (session && session.tabId !== null) {
          try {
            const tab = await chrome.tabs.get(session.tabId);
            tabInfo = { tabId: tab.id, url: tab.url, title: tab.title };
            session.url = tab.url;
            session.title = tab.title;
          } catch {
            session.tabId = null;
            this.activeSession = null;
          }
        } else {
          this.activeSession = null;
        }
      }

      const sessionNames = Object.keys(this.sessions);
      return {
        active: this.activeSession,
        tabId: tabInfo?.tabId ?? null,
        url: tabInfo?.url ?? null,
        title: tabInfo?.title ?? null,
        sessions: sessionNames,
      };
    }

    handleTabRemoved(closedTabId) {
      if (this.lastNavigatedTabId === closedTabId) {
        this.lastNavigatedTabId = null;
      }
      let changed = false;
      for (const [name, session] of Object.entries(this.sessions)) {
        if (session.tabId === closedTabId) {
          session.tabId = null;
          changed = true;
        }
      }
      if (
        this.activeSession &&
        this.sessions[this.activeSession]?.tabId === null
      ) {
        this.activeSession = null;
      }
      if (changed) this.persist();
    }

    handleTabUpdated(tabId, changeInfo) {
      let changed = false;
      for (const [name, session] of Object.entries(this.sessions)) {
        if (session.tabId === tabId) {
          if (changeInfo.url) {
            session.url = changeInfo.url;
            changed = true;
          }
          if (changeInfo.title) {
            session.title = changeInfo.title;
            changed = true;
          }
        }
      }
      if (changed) this.persist();
    }
  }

  const sessionManager = new SessionManager();

  // --- WebSocket connection management ---

  function connect() {
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      console.error("[PolterTab] WebSocket creation failed:", err.message);
      ensureReconnectAlarm();
      return;
    }

    ws.onopen = () => {
      console.log("[PolterTab] Connected to bridge server");
      isConnected = true;
      // Stop reconnect polling — we're connected
      chrome.alarms.clear(RECONNECT_ALARM);
      // Start keep-alive to prevent service worker suspension while connected
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.33 }); // ~20s
      send({
        type: "extension_ready",
        version: chrome.runtime.getManifest().version,
      });
      send({ type: "request_full_state" });
      broadcastState();
    };

    ws.onmessage = async (event) => {
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

      const { id, action, ...params } = msg;
      try {
        const result = await handleCommand(action, params);
        send({ id, success: true, data: result });
      } catch (err) {
        send({ id, success: false, error: err.message });
      }
    };

    ws.onerror = (err) => {
      console.error(
        "[PolterTab] WebSocket error:",
        err.message || "connection error",
      );
    };

    ws.onclose = () => {
      console.log("[PolterTab] Disconnected from bridge server");
      ws = null;
      isConnected = false;
      activeSessions = [];
      serverVersion = null;
      broadcastState();
      // Stop keep-alive, start reconnect polling
      chrome.alarms.clear(KEEPALIVE_ALARM);
      ensureReconnectAlarm();
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
          delayInMinutes: 0.08, // first attempt in ~5s
          periodInMinutes: 0.08, // then every ~5s
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
      sendResponse({ connected: isConnected, sessions: activeSessions });
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

    // Intercepted Network Data from MAIN world (via content script)
    if (message && message.type === "ZC_NETWORK_DATA") {
      const tabId = sender.tab
        ? sender.tab.id
        : sessionManager.lastNavigatedTabId;
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
    sessionManager.handleTabRemoved(closedTabId);
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

  async function handleCommand(action, params) {
    switch (action) {
      case "navigate":
        return navigate(params);
      case "screenshot":
        return screenshot(params);
      case "get_title":
        return getTitle(params);
      case "click":
      case "fill":
      case "snapshot":
      case "scrape":
      case "extract":
      case "scroll":
      case "hover":
      case "get_text":
        return forwardToContentScript(action, params);
      case "update_patterns":
        return forwardToContentScript(action, params);
      case "set_intercept_patterns": {
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
      }
      // Background-handled: get_url
      case "get_url":
        return getUrl(params);
      // Session management actions (accept "name" or "session" as the session identifier)
      case "session_create":
        return sessionManager.create(params.name || params.session, params.url);
      case "session_switch":
        return sessionManager.switch(params.name || params.session);
      case "session_list":
        return sessionManager.list();
      case "session_close":
        return sessionManager.close(params.name || params.session);
      case "session_context":
        return sessionManager.context();
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  // --- Background-handled commands ---

  async function navigate(params) {
    const { url } = params;
    if (!url) throw new Error("navigate requires a 'url' parameter");

    const targetUrl = url.startsWith("http") ? url : `https://${url}`;

    // Resolve tab via session manager
    const resolvedTabId = await sessionManager.resolve(params);

    let tab;
    const since = Date.now();
    if (resolvedTabId) {
      tab = await chrome.tabs.update(resolvedTabId, { url: targetUrl });
    } else {
      // Nothing resolved means nothing has been navigated yet this session.
      // This runs against the user's real browser, so the old behaviour here —
      // commandeering whatever tab they happened to be looking at — navigated
      // them away from their own work. Open our own tab instead; resolve()
      // returns it via lastNavigatedTabId from the next call onward, so a
      // paginating loop still reuses one tab rather than opening hundreds.
      tab = await chrome.tabs.create({ url: targetUrl });
    }
    tab = await waitForTabLoad(tab.id, since);

    // Always track the last navigated tab for implicit fallback
    sessionManager.lastNavigatedTabId = tab.id;

    // If a session param was provided, create/update the named session for this tab
    if (params.session) {
      await sessionManager.load();
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
      sessionManager.activeSession = params.session;
      await sessionManager.persist();
    }

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
  async function waitForTabLoad(tabId, since, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const loadedAt = tabLoadEpoch.get(tabId);
      if (loadedAt !== undefined && loadedAt >= since) {
        // Let the document's own scripts settle before we act on it.
        await new Promise((r) => setTimeout(r, 500));
        return chrome.tabs.get(tabId);
      }
      try {
        await chrome.tabs.get(tabId);
      } catch {
        throw new Error("Tab was closed during navigation");
      }
      await new Promise((r) => setTimeout(r, 100));
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

  async function screenshot(params) {
    const targetTabId = await sessionManager.resolveOrFallback(params);

    await chrome.tabs.update(targetTabId, { active: true });
    await new Promise((r) => setTimeout(r, 300));

    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: "png",
      quality: 90,
    });

    return { screenshot: dataUrl, tabId: targetTabId };
  }

  async function getTitle(params) {
    const targetTabId = await sessionManager.resolveOrFallback(params);
    const tab = await chrome.tabs.get(targetTabId);
    return { title: tab.title, url: tab.url, tabId: tab.id };
  }

  async function getUrl(params) {
    const targetTabId = await sessionManager.resolveOrFallback(params);
    const tab = await chrome.tabs.get(targetTabId);
    return { url: tab.url, title: tab.title, tabId: tab.id };
  }

  // --- Content script forwarding ---

  // Actions whose results should be merged across all frames rather than
  // stopping at the first success. snapshot aggregates nodes; a full-page
  // scrape (no selector) aggregates structured page data.
  function isAggregateAction(action, params) {
    if (action === "snapshot") return true;
    if (action === "scrape" && !params.selector) return true;
    return false;
  }

  // An element-targeting action "misses" a frame when the content script
  // reports the element is absent. These misses should advance the search to
  // the next frame rather than surfacing immediately to the caller.
  function isElementMiss(action, params, response) {
    if (!response) return true;
    if (!response.success) {
      const err = response.error || "";
      // "not found" = element absent; "Receiving end" = no content script in
      // that frame (loaded before extension, or opaque-origin sandbox).
      if (/not found|Receiving end|No response/i.test(err)) return true;
    }
    // scrape with a selector returns [] when the element doesn't exist in that
    // frame — the content script considers it a success (no throw), but for
    // frame search purposes it's a miss.
    if (
      action === "scrape" &&
      params.selector &&
      response.success &&
      Array.isArray(response.data) &&
      response.data.length === 0
    ) {
      return true;
    }
    // Same for extract: a frame with no matching record root succeeded at
    // finding nothing, and the records may well be in the next frame.
    if (
      action === "extract" &&
      response.success &&
      response.data &&
      response.data.records_found === 0
    ) {
      return true;
    }
    return false;
  }

  // executeScript resolving does not guarantee the content script's
  // onMessage listener is registered yet, so the first message into a
  // freshly-injected frame can lose a race and come back "Receiving end does
  // not exist" — a transient that succeeded on a bare retry, unchanged. Absorb
  // it here, once, rather than leaving every caller to guess whether a retry
  // is legitimate.
  async function sendToFrame(tabId, frameId, action, params) {
    const first = await postToFrame(tabId, frameId, action, params);
    if (first && first.success) return first;
    if (!/Receiving end|Could not establish connection/i.test(first?.error || "")) {
      return first;
    }
    await new Promise((r) => setTimeout(r, 150));
    return postToFrame(tabId, frameId, action, params);
  }

  function postToFrame(tabId, frameId, action, params) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: `Content script timeout (frame ${frameId})` });
      }, 10000);

      chrome.tabs.sendMessage(
        tabId,
        { source: "poltertab", action, params },
        { frameId },
        (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            resolve({
              success: false,
              error: chrome.runtime.lastError.message,
            });
          } else {
            resolve(response || { success: false, error: "No response" });
          }
        },
      );
    });
  }

  async function forwardToContentScript(action, params) {
    const targetTabId = await sessionManager.resolveOrFallback(params);

    // Inject into the TOP FRAME only as a safety net for tabs that were open
    // before the extension loaded. Child frames get their content script from
    // the manifest's content_scripts declaration (matches: <all_urls>,
    // run_at: document_start) — re-injecting into all frames via executeScript
    // is expensive (~1s per frame) and unnecessary since the manifest already
    // covers every frame that loaded after the extension was active.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        files: ["content_script.js"],
      });
    } catch (err) {
      if (
        err.message &&
        (err.message.includes("Cannot access") ||
          err.message.includes("restricted"))
      ) {
        throw new Error(
          "Cannot interact with this page (restricted Chrome page)",
        );
      }
    }

    // Enumerate frames: top frame first, then children.
    let frameIds = [0];
    try {
      const frames = await chrome.webNavigation.getAllFrames({
        tabId: targetTabId,
      });
      if (frames && frames.length > 1) {
        frameIds = [
          0,
          ...frames.map((f) => f.frameId).filter((id) => id !== 0),
        ];
      }
    } catch (_) {
      // webNavigation may fail on restricted pages; fall back to top only.
    }

    // --- Aggregate actions: merge results across all frames ---
    if (isAggregateAction(action, params)) {
      const results = await Promise.all(
        frameIds.map((fid) => sendToFrame(targetTabId, fid, action, params)),
      );

      if (action === "snapshot") {
        const merged = { title: "", url: "", count: 0, nodes: [] };
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (!r || !r.success) continue;
          const d = r.data;
          if (i === 0) {
            merged.title = d.title || "";
            merged.url = d.url || "";
          }
          const fid = frameIds[i];
          for (const node of d.nodes || []) {
            merged.nodes.push(fid === 0 ? node : { ...node, frameId: fid });
          }
        }
        merged.count = merged.nodes.length;
        return merged;
      }

      // Full-page scrape without selector: return from the first frame that
      // has body text (top frame preferred).
      for (const r of results) {
        if (r && r.success && r.data) return r.data;
      }
      throw new Error("No frame returned page data");
    }

    // --- Element-targeting actions: fast-probe, parallel child frames ---
    // Strategy:
    //   1. Try frame 0 instantly (_noWait) — top frame is the most common hit.
    //   2. On miss, probe ALL child frames in parallel (_noWait). Take the
    //      first success. This turns N sequential round-trips into one batch.
    //   3. If still nothing, retry frame 0 WITH the wait — a portal or modal
    //      may be mounting right now in the top document.
    // Cost: element in top frame = 1 round-trip. In any iframe = 2 round-trips.
    // Late modal = 2 round-trips + 3 s wait. Versus the old sequential path
    // that took ~1 s × N frames before even finding the element.
    const probeParams = { ...params, _noWait: true };

    // A successful extract that found no records is an answer, not a miss to
    // escalate — it carries the fill rates and the page-wide probe that explain
    // *why* it came back empty. Frame search still advances past it in case a
    // later frame holds the records, but if none do, the caller gets this
    // payload instead of an error borrowed from an iframe that never had a
    // content script. That borrowed error is what "Receiving end does not
    // exist" on a detail page actually was, and it read as the content script
    // failing to attach when the real answer was "that selector matches
    // nothing here, and here is what does".
    let emptyAnswer = null;
    const keepEmptyAnswer = (r) => {
      if (!emptyAnswer && action === "extract" && r && r.success && r.data) {
        emptyAnswer = r.data;
      }
    };

    // Step 1: top frame first (cheap, most common hit)
    const topResponse = await sendToFrame(targetTabId, 0, action, probeParams);
    if (topResponse && topResponse.success && !isElementMiss(action, params, topResponse)) {
      return topResponse.data;
    }
    keepEmptyAnswer(topResponse);
    // isElementMiss already decides what counts as "keep searching" — including
    // a frame with no content script. Second-guessing it with a narrower test
    // here meant a frame-0 injection race threw immediately instead of falling
    // through to the waited retry that exists to absorb it.
    if (topResponse && !topResponse.success && !isElementMiss(action, params, topResponse)) {
      throw new Error(topResponse.error || "Content script error");
    }

    // Step 2: parallel probe of all child frames
    const childFrameIds = frameIds.filter((fid) => fid !== 0);
    let lastError = (topResponse && topResponse.error) || "Element not found";

    if (childFrameIds.length > 0) {
      const childResults = await Promise.all(
        childFrameIds.map((fid) =>
          sendToFrame(targetTabId, fid, action, probeParams),
        ),
      );

      for (const response of childResults) {
        if (!response) continue;
        if (isElementMiss(action, params, response)) {
          keepEmptyAnswer(response);
          if (response.error) lastError = response.error;
          continue;
        }
        if (!response.success) {
          throw new Error(response.error || "Content script error");
        }
        return response.data;
      }
    }

    // Step 3: retry frame 0 with the wait — catches late-rendering modals
    const retryResponse = await sendToFrame(targetTabId, 0, action, params);
    if (retryResponse && retryResponse.success) {
      if (!isElementMiss(action, params, retryResponse)) {
        return retryResponse.data;
      }
      keepEmptyAnswer(retryResponse);
    }
    if (retryResponse && retryResponse.error) {
      lastError = retryResponse.error;
    }

    if (emptyAnswer) return emptyAnswer;
    throw new Error(lastError);
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
      connect();
    }
  });
})();
