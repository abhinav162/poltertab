// PolterTab — screenshot queue for the background service worker.
//
// Loaded by background.js with importScripts, so this runs in the worker's
// global scope: it exports one factory and registers no listeners.

self.PT = self.PT || {};

self.PT.makeScreenshot = ({ sessionManager }) => {
  // After activating a tab, let Chrome finish painting it before capturing.
  const TAB_FOCUS_SETTLE_MS = 300;

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

  return { screenshot };
};
