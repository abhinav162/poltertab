// PolterTab Background Service Worker — WebSocket client + command router
// Connects to bridge-server at ws://localhost:7822 and routes commands to content scripts or Chrome APIs.
//
// MV3 service workers get suspended after ~30s of inactivity.
// We use chrome.alarms (which persist across suspensions) to ensure reconnection
// whenever the bridge server restarts.

importScripts("bg/frames.js");

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
  // After activating a tab, let Chrome finish painting it before capturing.
  const TAB_FOCUS_SETTLE_MS = 300;

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

  // "example.com" -> "https://example.com"; a url that already names its
  // scheme is left alone. tab_new also accepts about: urls (about:blank is its
  // default), which nothing else does.
  function normalizeUrl(url, { allowAbout = false } = {}) {
    if (url.startsWith("http")) return url;
    if (allowAbout && url.startsWith("about:")) return url;
    return `https://${url}`;
  }

  // --- Session Manager ---

  // The session manager takes everything it needs from outside, so it can
  // live in its own file without reaching back into this one. waitForTabLoad
  // in particular depends on the webNavigation.onCompleted listener, which
  // has to stay registered here at the top level of the worker.
  const makeSessionManager = ({ waitForTabLoad, normalizeUrl, ERR }) => {
    const STORAGE_KEY = "zc_sessions";
    const TAB_STATE_KEY = "zc_tab_state";
    // How long an agent's empty tab pointer outlives its last use.
    const POINTER_TTL_MS = 24 * 60 * 60 * 1000;

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

      // The tab the user is looking at. Three callers reach for it as a fallback
      // and each phrased the query itself; null rather than undefined so the
      // "none" case is explicit.
      async activeTab() {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        return tab || null;
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
      // Carries the same [tab_not_found] code tab_close returns for the same
      // condition: an agent branching on the code used to miss every tool but
      // that one.
      async requireTab(tabId) {
        const tab = await this.tabAlive(tabId);
        if (!tab) {
          throw new Error(
            `[${ERR.TAB_NOT_FOUND}] Tab ${tabId} is closed or does not exist. Call browser_tab_list to see the open tabs.`,
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

      // Everything not opened by PolterTab belongs to the user — including tabs
      // adopted via session_create({tabId}). Both close paths (session_close and
      // tab_close) refuse one without force; they differ only in how the tab came
      // to be tracked, which the caller passes as `how`.
      requireClosePermission(tabId, liveTab, params, how) {
        if (!liveTab || params.force || this.owned.has(tabId)) return;
        throw new Error(
          `[${ERR.NEEDS_USER_PERMISSION}] Tab ${tabId} ("${liveTab.title ?? ""}", ${liveTab.url ?? ""}) was not opened by PolterTab. ${how} Ask the user for permission to close it, then retry with force: true.`,
        );
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
          const targetUrl = normalizeUrl(url);
          const since = Date.now();
          tab = await chrome.tabs.create({ url: targetUrl });
          this.owned.add(tab.id);
          tab = await waitForTabLoad(tab.id, since);
        } else {
          const activeTab = await this.activeTab();
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

        const activeTab = await this.activeTab();
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
          this.requireClosePermission(
            session.tabId,
            liveTab,
            params,
            "This tab was adopted by a session.",
          );
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

      describeTab(tab, cur) {
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
          ? normalizeUrl(params.url, { allowAbout: true })
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
        const described = this.describeTab(tab, cur);
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
          .map((t) => this.describeTab(t, cur));
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
        return this.describeTab(tab, cur);
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
        if (tabId == null && !name) {
          tabId = cur.tabId;
          if (tabId == null) {
            throw new Error("browser_tab_close needs a tabId or a session (this agent has no current tab)");
          }
        }
        if (!name) name = this.sessionNameFor(tabId);

        const liveTab = tabId != null ? await this.tabAlive(tabId) : null;
        if (liveTab) {
          this.requireClosePermission(
            tabId,
            liveTab,
            params,
            "This tab was opened by the user.",
          );
          this.forgetTab(tabId);
          await chrome.tabs.remove(tabId);
        } else if (tabId != null && !name) {
          // An explicit tabId that Chrome does not have. We cannot tell if it was
          // never valid or if it was already closed, so we surface both the same way.
          throw new Error(
            `[${ERR.TAB_NOT_FOUND}] Tab ${tabId} not found — it may never have existed or may already be closed. Call browser_tab_list to see open tabs.`,
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

    return new SessionManager();
  };

  const sessionManager = makeSessionManager({
    waitForTabLoad,
    normalizeUrl,
    ERR,
  });

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

  // One screenshot at a time: captureVisibleTab captures the VISIBLE tab, so
  // concurrent agents activating different tabs interleave and each gets the
  // wrong pixels. The mutex also prevents stealing focus permanently — we
  // restore whichever tab was active before we switched.
  let screenshotLock = Promise.resolve();
  // Chrome allows MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND (2) captures per
  // second; back-to-back queued screenshots must be spaced or the second fails.
  const MIN_CAPTURE_GAP_MS = 550;
  let lastCaptureAt = 0;

  async function capturePaced() {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCaptureAt + MIN_CAPTURE_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCaptureAt = Date.now();
      try {
        // No `quality`: Chrome applies it to jpeg only, and carrying it here
        // read as though these captures were lossy.
        return await chrome.tabs.captureVisibleTab(null, { format: "png" });
      } catch (err) {
        if (attempt > 0 || !/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(err?.message || "")) throw err;
      }
    }
  }

  async function screenshot(params) {
    const targetTabId = await sessionManager.resolveOrFallback(params);

    const prev = screenshotLock;
    let release;
    screenshotLock = new Promise((r) => (release = r));
    await prev.catch(() => {});
    let activeTab;
    try {
      activeTab = await sessionManager.activeTab();
      await chrome.tabs.update(targetTabId, { active: true });
      await new Promise((r) => setTimeout(r, TAB_FOCUS_SETTLE_MS));
      const dataUrl = await capturePaced();
      return { screenshot: dataUrl, tabId: targetTabId };
    } finally {
      // Restore focus even when the capture throws, so a failed screenshot
      // never leaves the agent's tab in front of the user's.
      if (activeTab && activeTab.id !== targetTabId) {
        await chrome.tabs.update(activeTab.id, { active: true }).catch(() => {});
      }
      release();
    }
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

  // --- Content script forwarding ---

  const { forwardToContentScript } = self.PT.makeFrames({ sessionManager });

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
