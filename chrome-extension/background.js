// ZeroClaw Background Service Worker — WebSocket client + command router
// Connects to bridge-server at ws://localhost:7822 and routes commands to content scripts or Chrome APIs.
//
// MV3 service workers get suspended after ~30s of inactivity.
// We use chrome.alarms (which persist across suspensions) to ensure reconnection
// whenever the bridge server restarts.

(() => {
  "use strict";

  const WS_URL = "ws://localhost:7822";
  const RECONNECT_ALARM = "zeroclaw-reconnect";
  const KEEPALIVE_ALARM = "zeroclaw-keepalive";

  let ws = null;

  // --- WebSocket connection management ---

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
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
      // Stop reconnect polling — we're connected
      chrome.alarms.clear(RECONNECT_ALARM);
      // Start keep-alive to prevent service worker suspension while connected
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~24s
      send({ type: "extension_ready", version: chrome.runtime.getManifest().version });
    };

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        send({ success: false, error: "Invalid JSON from bridge server" });
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
      console.error("[ZeroClaw] WebSocket error:", err.message || "connection error");
    };

    ws.onclose = () => {
      console.log("[ZeroClaw] Disconnected from bridge server");
      ws = null;
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

  // Alarm-based reconnection: survives service worker suspension
  function ensureReconnectAlarm() {
    chrome.alarms.get(RECONNECT_ALARM, (alarm) => {
      if (!alarm) {
        // Poll every 5s to reconnect
        chrome.alarms.create(RECONNECT_ALARM, {
          delayInMinutes: 0.08,       // first attempt in ~5s
          periodInMinutes: 0.08,      // then every ~5s
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
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  // --- Background-handled commands ---

  async function navigate(params) {
    const { url, tabId } = params;
    if (!url) throw new Error("navigate requires a 'url' parameter");

    const targetUrl = url.startsWith("http") ? url : `https://${url}`;

    if (tabId) {
      const tab = await chrome.tabs.update(tabId, { url: targetUrl });
      await waitForTabLoad(tab.id);
      return { tabId: tab.id, url: tab.url, title: tab.title };
    }

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      const tab = await chrome.tabs.update(activeTab.id, { url: targetUrl });
      await waitForTabLoad(tab.id);
      const updated = await chrome.tabs.get(tab.id);
      return { tabId: updated.id, url: updated.url, title: updated.title };
    }

    const tab = await chrome.tabs.create({ url: targetUrl });
    await waitForTabLoad(tab.id);
    const updated = await chrome.tabs.get(tab.id);
    return { tabId: updated.id, url: updated.url, title: updated.title };
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
    const { tabId } = params;
    let targetTabId = tabId;

    if (!targetTabId) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) throw new Error("No active tab found");
      targetTabId = activeTab.id;
    }

    await chrome.tabs.update(targetTabId, { active: true });
    await new Promise((r) => setTimeout(r, 300));

    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: "png",
      quality: 90,
    });

    return { screenshot: dataUrl, tabId: targetTabId };
  }

  async function getTitle(params) {
    const { tabId } = params;

    if (tabId) {
      const tab = await chrome.tabs.get(tabId);
      return { title: tab.title, url: tab.url, tabId: tab.id };
    }

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) throw new Error("No active tab found");
    return { title: activeTab.title, url: activeTab.url, tabId: activeTab.id };
  }

  // --- Content script forwarding ---

  async function forwardToContentScript(action, params) {
    let targetTabId = params.tabId;

    if (!targetTabId) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) throw new Error("No active tab found");
      targetTabId = activeTab.id;
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        files: ["content_script.js"],
      });
    } catch {
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
            reject(new Error(chrome.runtime.lastError.message));
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
        }
      );
    });
  }

  // --- Startup ---
  connect();

  // Re-connect on service worker wake-up events
  chrome.runtime.onStartup.addListener(connect);
  chrome.runtime.onInstalled.addListener(connect);
})();
