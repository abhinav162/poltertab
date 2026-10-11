// PolterTab Background Service Worker — WebSocket client + command router
// Connects to bridge-server at ws://localhost:7822 and routes commands to content scripts or Chrome APIs.
//
// MV3 service workers get suspended after ~30s of inactivity.
// We use chrome.alarms (which persist across suspensions) to ensure reconnection
// whenever the bridge server restarts.

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
  // One frame's answer. Bounded well under NAV_TIMEOUT_MS because frames are
  // probed in parallel and one dead frame must not stall the batch.
  const FRAME_TIMEOUT_MS = 10000;
  // executeScript can resolve before the content script's listener is live, so
  // the first message into a fresh frame can lose the race. One short retry.
  const FRAME_RETRY_MS = 150;

  // MV3 suspends a service worker after ~30s idle. The keepalive fires inside
  // that window while connected; the reconnect poll runs when it is not.
  const KEEPALIVE_MINUTES = 0.33; // ~20s
  const RECONNECT_MINUTES = 0.08; // ~5s

  let WS_PORT = DEFAULT_WS_PORT;
  let WS_URL = `ws://localhost:${WS_PORT}`;
  const RECONNECT_ALARM = "poltertab-reconnect";
  const KEEPALIVE_ALARM = "poltertab-keepalive";
  const STORAGE_KEY = "zc_sessions";
  const TAB_STATE_KEY = "zc_tab_state";
  // How long an agent's empty tab pointer outlives its last use.
  const POINTER_TTL_MS = 24 * 60 * 60 * 1000;

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
      this.groupId = null;
      this.loaded = false;
      // Which tab each connected agent is working in. One extension serves the
      // Primary MCP server and every Secondary proxied through it, and this
      // used to be a single global activeSession + lastNavigatedTabId: a
      // Secondary's call moved the Primary's pointer, so the Primary's next
      // untargeted click landed in someone else's tab. Keyed by params._client,
      // which the bridge stamps on every command ("primary" when absent).
      this.current = {};
      // Tabs PolterTab opened itself. browser_tab_close only closes these (or a
      // session's tab) unless forced, because every other tab is the user's.
      this.owned = new Set();
    }

    load() {
      if (this.loaded) return Promise.resolve();
      // Memoize to a single promise so concurrent callers at worker wake share
      // one load instead of each entering the body independently. Without this,
      // a second caller sees this.loaded === false, enters the body, and its
      // storage reads can overwrite in-memory mutations made by the first caller
      // before the first caller had a chance to persist.
      if (!this._loadPromise) {
        this._loadPromise = (async () => {
          try {
            const result = await chrome.storage.local.get(STORAGE_KEY);
            if (result[STORAGE_KEY]) {
              this.sessions = result[STORAGE_KEY];
            }
          } catch (err) {
            console.error("[PolterTab] Failed to load sessions:", err.message);
          }
          // The pointers live in session storage, not local: they have to survive
          // an MV3 worker suspension (losing them sent the next untargeted call to
          // whatever tab the user had focused), but tab ids are only valid for one
          // browser run, so they must NOT survive a restart into a reused id.
          try {
            const area = chrome.storage.session;
            const saved = area && (await area.get(TAB_STATE_KEY))[TAB_STATE_KEY];
            if (saved) {
              this.current = saved.current || {};
              this.owned = new Set(saved.owned || []);
            }
          } catch (err) {
            console.error("[PolterTab] Failed to load tab state:", err.message);
          }
          this.loaded = true;
        })();
      }
      return this._loadPromise;
    }

    // A restarted Secondary comes back under a new nodeId, so its old pointer
    // would sit in session storage for the rest of the browser run. Drop
    // pointers nobody has used for a day that no longer hold a tab; one still
    // on a live tab is kept, so an idle agent never loses where it was.
    prunePointers() {
      const cutoff = Date.now() - POINTER_TTL_MS;
      for (const [client, cur] of Object.entries(this.current)) {
        if (client === "primary" || cur.tabId != null) continue;
        if ((cur.seenAt || 0) < cutoff) delete this.current[client];
      }
    }

    async persist() {
      this.prunePointers();
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: this.sessions });
        const area = chrome.storage.session;
        if (area) {
          await area.set({
            [TAB_STATE_KEY]: { current: this.current, owned: [...this.owned] },
          });
        }
      } catch (err) {
        console.error("[PolterTab] Failed to persist sessions:", err.message);
      }
    }

    // --- Per-agent current-tab pointer ---

    pointer(params) {
      const client = (params && params._client) || "primary";
      if (!this.current[client]) {
        this.current[client] = { session: null, tabId: null, goneTabId: null };
      }
      this.current[client].seenAt = Date.now();
      return this.current[client];
    }

    point(cur, tabId, session = null) {
      cur.tabId = tabId;
      cur.session = session || this.sessionNameFor(tabId);
      cur.goneTabId = null;
    }

    sessionNameFor(tabId) {
      for (const [name, s] of Object.entries(this.sessions)) {
        if (s.tabId === tabId) return name;
      }
      return null;
    }

    async tabAlive(tabId) {
      if (tabId == null) return null;
      try {
        return await chrome.tabs.get(tabId);
      } catch {
        return null;
      }
    }

    // An explicit tabId used to go straight to chrome.* and come back as
    // Chrome's own "No tab with id: 123", which says nothing about what to do.
    async requireTab(tabId) {
      const tab = await this.tabAlive(tabId);
      if (!tab) {
        throw new Error(
          `Tab ${tabId} is closed or does not exist. Call browser_tab_list to see the open tabs.`,
        );
      }
      return tab;
    }

    // A closed tab is remembered as closed rather than forgotten, so the next
    // untargeted call can say so instead of quietly acting on another tab.
    forgetTab(tabId) {
      let changed = this.owned.delete(tabId);
      for (const cur of Object.values(this.current)) {
        if (cur.tabId === tabId) {
          cur.goneTabId = tabId;
          cur.tabId = null;
          cur.session = null;
          changed = true;
        }
      }
      return changed;
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

    async create(name, url, params = {}) {
      await this.load();
      if (!name) throw new Error("session_create requires a 'name' parameter");

      let tab;
      if (params.tabId != null) {
        // Adopt a tab that is already open (one browser_tab_list showed).
        tab = await this.requireTab(params.tabId);
      } else if (url) {
        const targetUrl = url.startsWith("http") ? url : `https://${url}`;
        const since = Date.now();
        tab = await chrome.tabs.create({ url: targetUrl });
        this.owned.add(tab.id);
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
      this.point(this.pointer(params), tab.id, name);
      await this.persist();

      return { name, tabId: tab.id, url: tab.url, title: tab.title };
    }

    async switch(name, params = {}) {
      await this.load();
      const session = this.sessions[name];
      if (!session) throw new Error(`Session "${name}" not found`);

      // Validate tab still exists
      const tab = await this.tabAlive(session.tabId);
      if (tab) {
        session.url = tab.url;
        session.title = tab.title;
      } else {
        session.tabId = null;
        // Auto-recover if tab is stale
        await this.recoverSession(name);
      }

      session.lastUsedAt = Date.now();
      this.point(this.pointer(params), session.tabId, name);
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
      this.owned.add(tab.id);
      const updated = await waitForTabLoad(tab.id, since);

      await this.addTabToGroup(updated.id);

      session.tabId = updated.id;
      session.url = updated.url;
      session.title = updated.title;
      session.lastUsedAt = Date.now();
      await this.persist();

      return session;
    }

    // Which tab a command acts on. Returns null when nothing is targeted yet;
    // `navigating` callers take null as "open a new tab", everyone else falls
    // back to the user's focused tab (resolveOrFallback).
    async resolve(params, { navigating = false } = {}) {
      await this.load();
      const cur = this.pointer(params);

      // 1. Explicit tabId — acts on that tab without moving the pointer, so a
      //    one-off read of another tab does not change where the agent "is".
      if (params.tabId != null) {
        await this.requireTab(params.tabId);
        return params.tabId;
      }

      // 2. Explicit session — look up, recover if closed, and make it current.
      if (params.session) {
        const session = this.sessions[params.session];
        if (session) {
          if (!(await this.tabAlive(session.tabId))) {
            session.tabId = null;
            await this.recoverSession(params.session);
          }
          session.lastUsedAt = Date.now();
          this.point(cur, session.tabId, params.session);
          await this.persist();
          return session.tabId;
        }
        // An unknown session used to fall through to whatever tab was active,
        // so browser_navigate({session:"b"}) navigated session a's tab and
        // bound b to it too — two "sessions", one tab. navigate now opens b
        // its own tab; anything else has no page to act on.
        if (navigating) return null;
        throw new Error(
          `Session "${params.session}" does not exist. Open it with browser_navigate({ session, url }) or browser_tab_new({ session }), or see browser_session_list.`,
        );
      }

      // 3. This agent's current tab.
      if (cur.tabId != null) {
        if (await this.tabAlive(cur.tabId)) return cur.tabId;
        this.forgetTab(cur.tabId);
      }

      // 4. Its current tab was closed: say so rather than acting on another.
      if (cur.goneTabId != null && !navigating) {
        throw new Error(
          `The tab this agent was working in (tab ${cur.goneTabId}) was closed. Pick another with browser_tab_list and browser_tab_switch, or open one with browser_navigate or browser_tab_new.`,
        );
      }

      // 5. Nothing targeted yet — the caller decides.
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

    async list(params = {}) {
      await this.load();
      const entries = [];

      for (const [name, session] of Object.entries(this.sessions)) {
        let status = "alive";
        if (session.tabId === null) {
          status = session.url ? "recoverable" : "expired";
        } else if (!(await this.tabAlive(session.tabId))) {
          session.lastTabId = session.tabId;
          session.tabId = null;
          status = session.url ? "recoverable" : "expired";
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
      return { sessions: entries, active: this.pointer(params).session };
    }

    async close(name, params = {}) {
      await this.load();
      const session = this.sessions[name];
      if (!session) throw new Error(`Session "${name}" not found`);

      if (session.tabId !== null) {
        const liveTab = await this.tabAlive(session.tabId);
        if (liveTab && !params.force && !this.owned.has(session.tabId)) {
          throw new Error(
            `[needs_user_permission] Tab ${session.tabId} ("${liveTab.title ?? ""}", ${liveTab.url ?? ""}) was not opened by PolterTab. This tab was adopted by a session. Ask the user for permission to close it, then retry with force: true.`,
          );
        }
        this.forgetTab(session.tabId);
        try {
          await chrome.tabs.remove(session.tabId);
        } catch {
          // Tab may already be closed
        }
      }

      delete this.sessions[name];
      await this.persist();

      return { closed: name };
    }

    async context(params = {}) {
      await this.load();
      const cur = this.pointer(params);
      const tab = await this.tabAlive(cur.tabId);
      if (cur.tabId != null && !tab) this.forgetTab(cur.tabId);
      if (tab && cur.session && this.sessions[cur.session]) {
        this.sessions[cur.session].url = tab.url;
        this.sessions[cur.session].title = tab.title;
      }

      return {
        active: tab ? cur.session : null,
        tabId: tab ? tab.id : null,
        url: tab ? tab.url : null,
        title: tab ? tab.title : null,
        closedTabId: cur.goneTabId,
        sessions: Object.keys(this.sessions),
      };
    }

    // --- Tab tools ---

    describe(tab, cur) {
      return {
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        session: this.sessionNameFor(tab.id),
        current: tab.id === cur.tabId,
        ownedByPolterTab: this.owned.has(tab.id),
        windowId: tab.windowId,
        focused: !!tab.active,
      };
    }

    async tabNew(params = {}) {
      await this.load();
      const name = params.session || params.name || null;
      if (name && this.sessions[name] && (await this.tabAlive(this.sessions[name].tabId))) {
        throw new Error(
          `Session "${name}" already has a tab (${this.sessions[name].tabId}). Use browser_tab_switch({ session: "${name}" }) to go back to it.`,
        );
      }
      // The session's tab is gone: say so, rather than rebinding the name to a
      // fresh tab without a word about the page that was lost.
      const replacedClosedTab =
        name && this.sessions[name]
          ? (this.sessions[name].tabId ?? this.sessions[name].lastTabId ?? null)
          : undefined;

      const url = params.url
        ? params.url.startsWith("http") || params.url.startsWith("about:")
          ? params.url
          : `https://${params.url}`
        : "about:blank";
      const since = Date.now();
      let tab = await chrome.tabs.create({ url, active: !params.background });
      this.owned.add(tab.id);
      if (params.url) tab = await waitForTabLoad(tab.id, since);
      await this.addTabToGroup(tab.id);

      if (name) {
        this.sessions[name] = {
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        };
      }
      const cur = this.pointer(params);
      this.point(cur, tab.id, name);
      await this.persist();
      const described = this.describe(tab, cur);
      if (replacedClosedTab !== undefined) {
        described.replacedClosedTab = replacedClosedTab;
        described.hint = `Session "${name}" had a tab (${replacedClosedTab}) that was closed; it now points at this new tab.`;
      }
      return described;
    }

    async tabList(params = {}) {
      await this.load();
      const cur = this.pointer(params);
      const tracked = new Set(this.owned);
      for (const s of Object.values(this.sessions)) {
        if (s.tabId != null) tracked.add(s.tabId);
      }
      if (cur.tabId != null) tracked.add(cur.tabId);

      const open = await chrome.tabs.query({});
      const openIds = new Set(open.map((t) => t.id));
      // Prune what Chrome no longer has, so the list never offers a dead id.
      for (const id of [...this.owned]) if (!openIds.has(id)) this.owned.delete(id);

      const tabs = open
        .filter((t) => params.all || tracked.has(t.id))
        .map((t) => this.describe(t, cur));
      await this.persist();
      return {
        current: openIds.has(cur.tabId) ? cur.tabId : null,
        closedTabId: cur.goneTabId,
        count: tabs.length,
        tabs,
      };
    }

    async tabSwitch(params = {}) {
      await this.load();
      if (params.session) {
        const r = await this.switch(params.session, params);
        if (params.focus) await chrome.tabs.update(r.tabId, { active: true });
        return { ...r, session: params.session, current: true };
      }
      if (params.tabId == null) {
        throw new Error("browser_tab_switch needs a tabId or a session");
      }
      const tab = await this.requireTab(params.tabId);
      const cur = this.pointer(params);
      this.point(cur, tab.id);
      if (params.focus) await chrome.tabs.update(tab.id, { active: true });
      await this.persist();
      return this.describe(tab, cur);
    }

    async tabClose(params = {}) {
      await this.load();
      const cur = this.pointer(params);
      let tabId = params.tabId;
      let name = params.session || null;
      if (name) {
        if (!this.sessions[name]) throw new Error(`Session "${name}" not found`);
        tabId = this.sessions[name].tabId;
      }
      if (tabId == null && !name) tabId = cur.tabId;
      if (tabId == null && !name) {
        throw new Error("browser_tab_close needs a tabId or a session (this agent has no current tab)");
      }
      if (!name) name = this.sessionNameFor(tabId);

      const liveTab = tabId != null ? await this.tabAlive(tabId) : null;
      if (liveTab) {
        // Everything not opened by PolterTab belongs to the user — including tabs
        // adopted via session_create({tabId}). Require explicit permission.
        if (!params.force && !this.owned.has(tabId)) {
          throw new Error(
            `[needs_user_permission] Tab ${tabId} ("${liveTab.title ?? ""}", ${liveTab.url ?? ""}) was not opened by PolterTab. This tab was opened by the user. Ask the user for permission to close it, then retry with force: true.`,
          );
        }
        this.forgetTab(tabId);
        await chrome.tabs.remove(tabId);
      } else if (tabId != null && !name) {
        // An explicit tabId that Chrome does not have. We cannot tell if it was
        // never valid or if it was already closed, so we surface both the same way.
        throw new Error(
          `[tab_not_found] Tab ${tabId} not found — it may never have existed or may already be closed. Call browser_tab_list to see open tabs.`,
        );
      } else if (tabId != null) {
        // Session's tab was already closed by Chrome before we arrived; clean up
        // the internal record so the session can be safely deleted below.
        this.forgetTab(tabId);
      }
      if (name) delete this.sessions[name];
      await this.persist();
      return {
        closed: tabId ?? null,
        session: name,
        current: cur.tabId,
        hint:
          cur.tabId == null
            ? "No current tab now. Untargeted calls will error until you browser_tab_switch or browser_navigate."
            : undefined,
      };
    }

    handleTabRemoved(closedTabId) {
      // The user closes their own tabs all the time; only write when the tab
      // was one PolterTab was tracking.
      let changed = this.forgetTab(closedTabId);
      for (const session of Object.values(this.sessions)) {
        if (session.tabId === closedTabId) {
          session.lastTabId = closedTabId;
          session.tabId = null;
          changed = true;
        }
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

  // The action word is the contract between four places: the MCP tool name, the
  // server's dispatch, this table, and content_script's own handler map. Nothing
  // used to check that they agreed, so a typo here surfaced as
  // "Unknown action: scrap" on a user's machine, mid-scrape. A table rather than
  // a switch so the suite can read the routes back and assert against the
  // server's tool list.
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
  };

  async function handleCommand(action, params) {
    const route = ROUTES[action];
    if (!route) throw new Error(`Unknown action: ${action}`);
    return route(params);
  }

  // --- Background-handled commands ---

  async function navigate(params) {
    const { url } = params;
    if (!url) throw new Error("navigate requires a 'url' parameter");

    const targetUrl = url.startsWith("http") ? url : `https://${url}`;

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

  // One screenshot at a time: captureVisibleTab captures the VISIBLE tab, so
  // concurrent agents activating different tabs interleave and each gets the
  // wrong pixels. The mutex also prevents stealing focus permanently — we
  // restore whichever tab was active before we switched.
  let screenshotLock = Promise.resolve();

  async function screenshot(params) {
    const targetTabId = await sessionManager.resolveOrFallback(params);

    const prev = screenshotLock;
    let release;
    screenshotLock = new Promise((r) => (release = r));
    await prev.catch(() => {});
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.update(targetTabId, { active: true });
      await new Promise((r) => setTimeout(r, 300));
      const dataUrl = await chrome.tabs.captureVisibleTab(null, {
        format: "png",
        quality: 90,
      });
      if (activeTab && activeTab.id !== targetTabId) {
        chrome.tabs.update(activeTab.id, { active: true }).catch(() => {});
      }
      return { screenshot: dataUrl, tabId: targetTabId };
    } finally {
      release();
    }
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
      // "not actionable" = the element IS here but is hidden/disabled/covered.
      // That must count as a miss too: frame 0 is probed with _noWait, so the
      // gate gets a zero timeout and fails on the first check. Treating it as a
      // hard error threw before step 3's waited retry could run, which is the
      // pass that exists to let a clearing overlay settle — the gate's polling
      // was unreachable in production. A frame that is genuinely covered still
      // ends up reporting this same message once every pass has missed.
      if (/not found|not actionable|Receiving end|No response/i.test(err))
        return true;
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
    await new Promise((r) => setTimeout(r, FRAME_RETRY_MS));
    return postToFrame(tabId, frameId, action, params);
  }

  function postToFrame(tabId, frameId, action, params) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: `Content script timeout (frame ${frameId})` });
      }, FRAME_TIMEOUT_MS);

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
        // A discarded tab fails the same way, but calling it a restricted
        // page sends the agent looking for the wrong fix.
        const tab = await sessionManager.tabAlive(targetTabId);
        if (tab && tab.discarded) {
          throw new Error(
            `Tab ${targetTabId} was discarded by Chrome to save memory, so its page is not loaded. Reload it with browser_navigate({ tabId: ${targetTabId}, url }) or show it with browser_tab_switch({ tabId: ${targetTabId}, focus: true }), then retry.`,
          );
        }
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
        // No frame answered (a crashed renderer, a page mid-teardown): that
        // used to come back as a successful empty page, which reads exactly
        // like a blank one. Frames that failed while others answered are
        // still skipped, so a partial snapshot stays a snapshot.
        if (!results.some((r) => r && r.success)) {
          const top = results[0];
          throw new Error(
            `Could not snapshot tab ${targetTabId}: no frame answered (${(top && top.error) || "no response"}). The page may have crashed or still be loading; reload it with browser_navigate.`,
          );
        }
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
