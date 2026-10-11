// PolterTab — session + tab state for the background service worker.
//
// The named-session registry, each agent's current-tab pointer, and the
// tab_* tool handlers. Loaded by background.js with importScripts, so this
// runs in the worker's global scope: it exports one factory and registers no
// listeners. waitForTabLoad is passed in rather than imported because it
// depends on the webNavigation.onCompleted listener, which has to stay
// registered at the top level of background.js.

self.PT = self.PT || {};

// The session manager takes everything it needs from outside, so it can
// live in its own file without reaching back into this one. waitForTabLoad
// in particular depends on the webNavigation.onCompleted listener, which
// has to stay registered here at the top level of the worker.
self.PT.makeSessionManager = ({ waitForTabLoad, normalizeUrl, ERR }) => {
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
