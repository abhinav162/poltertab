// ZeroClaw Background Service Worker — WebSocket client + command router
// Connects to bridge-server at ws://localhost:7822 and routes commands to content scripts or Chrome APIs.
//
// MV3 service workers get suspended after ~30s of inactivity.
// We use chrome.alarms (which persist across suspensions) to ensure reconnection
// whenever the bridge server restarts.

(() => {
  let WS_PORT = 7822;
  let WS_URL = `ws://localhost:${WS_PORT}`;
  const RECONNECT_ALARM = "zeroclaw-reconnect";
  const KEEPALIVE_ALARM = "zeroclaw-keepalive";
  const STORAGE_KEY = "zc_sessions";

  let ws = null;
  let isConnected = false;
  let activeSessions = [];

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
        console.error("[ZeroClaw] Failed to load sessions:", err.message);
      }
      this.loaded = true;
    }

    async persist() {
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: this.sessions });
      } catch (err) {
        console.error("[ZeroClaw] Failed to persist sessions:", err.message);
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
        const groups = await chrome.tabGroups.query({ title: "ZeroClaw" });
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
            title: "ZeroClaw",
            color: "blue",
            collapsed: false,
          });
          this.groupId = newGroupId;
        }
      } catch (err) {
        console.warn("[ZeroClaw] Failed to add tab to group:", err.message);
      }
    }

    async create(name, url) {
      await this.load();
      if (!name) throw new Error("session_create requires a 'name' parameter");

      let tab;
      if (url) {
        const targetUrl = url.startsWith("http") ? url : `https://${url}`;
        tab = await chrome.tabs.create({ url: targetUrl });
        await waitForTabLoad(tab.id);
        tab = await chrome.tabs.get(tab.id);
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

      const tab = await chrome.tabs.create({ url: session.url });
      await waitForTabLoad(tab.id);
      const updated = await chrome.tabs.get(tab.id);

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
      console.error("[ZeroClaw] WebSocket creation failed:", err.message);
      ensureReconnectAlarm();
      return;
    }

    ws.onopen = () => {
      console.log("[ZeroClaw] Connected to bridge server");
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
        "[ZeroClaw] WebSocket error:",
        err.message || "connection error",
      );
    };

    ws.onclose = () => {
      console.log("[ZeroClaw] Disconnected from bridge server");
      ws = null;
      isConnected = false;
      activeSessions = [];
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
    chrome.runtime.sendMessage({ type: "state_update", state: { connected: isConnected, sessions: activeSessions } }).catch(() => {});
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
              source: "zeroclaw",
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
    if (resolvedTabId) {
      tab = await chrome.tabs.update(resolvedTabId, { url: targetUrl });
      await waitForTabLoad(tab.id);
      tab = await chrome.tabs.get(tab.id);
    } else {
      // No session context — use active tab or create new
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (activeTab) {
        tab = await chrome.tabs.update(activeTab.id, { url: targetUrl });
        await waitForTabLoad(tab.id);
        tab = await chrome.tabs.get(tab.id);
      } else {
        tab = await chrome.tabs.create({ url: targetUrl });
        await waitForTabLoad(tab.id);
        tab = await chrome.tabs.get(tab.id);
      }
    }

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

    return { tabId: tab.id, url: tab.url, title: tab.title };
  }

  function waitForTabLoad(tabId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.webNavigation.onCompleted.removeListener(listener);
        reject(new Error("Navigation timed out after 30s"));
      }, timeoutMs);

      function listener(details) {
        if (details.tabId === tabId && details.frameId === 0) {
          clearTimeout(timer);
          chrome.webNavigation.onCompleted.removeListener(listener);
          setTimeout(resolve, 500);
        }
      }

      chrome.webNavigation.onCompleted.addListener(listener);
    });
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

  async function forwardToContentScript(action, params) {
    const targetTabId = await sessionManager.resolveOrFallback(params);

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
      // Content script may already be injected or page doesn't allow injection
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Content script timeout for action: ${action}`));
      }, 15000);

      chrome.tabs.sendMessage(
        targetTabId,
        { source: "zeroclaw", action, params },
        (response) => {
          clearTimeout(timeout);

          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message;
            if (
              msg.includes("Receiving end does not exist") ||
              msg.includes("Cannot access")
            ) {
              reject(
                new Error(
                  "Cannot interact with this page (restricted Chrome page or script failed)",
                ),
              );
            } else {
              reject(new Error(msg));
            }
            return;
          }

          if (!response) {
            reject(new Error("No response from content script"));
            return;
          }

          if (response.success) {
            resolve(response.data);
          } else {
            reject(new Error(response.error || "Content script error"));
          }
        },
      );
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
      connect();
    }
  });
})();
