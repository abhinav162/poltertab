// PolterTab — file-upload handler for the background service worker.
//
// Loaded by background.js with importScripts; runs in the worker's global
// scope. Exports one factory via self.PT.makeUpload.
//
// The chrome.debugger.onEvent listener is NOT registered here (A16 requires
// all chrome.* listeners to live in background.js). background.js calls
// upload._handleDebuggerEvent so this module can resolve its per-call promises.

self.PT = self.PT || {};

self.PT.makeUpload = ({ sessionManager, forwardToContentScript }) => {
  // Per-call picker promise resolver, keyed by tabId.
  // Populated by uploadFilePicker, resolved by _handleDebuggerEvent.
  const pendingChoosers = new Map(); // tabId -> resolve fn

  // Called by background.js from its top-level chrome.debugger.onEvent listener.
  function _handleDebuggerEvent(source, method, params) {
    if (method !== "Page.fileChooserOpened") return;
    const resolve = pendingChoosers.get(source.tabId);
    if (!resolve) return;
    pendingChoosers.delete(source.tabId);
    resolve(params);
  }

  // CDP helper: sendCommand wrapped in a promise.
  function cdp(tabId, method, params = {}) {
    return new Promise((res, rej) =>
      chrome.debugger.sendCommand({ tabId }, method, params, (result) =>
        chrome.runtime.lastError
          ? rej(new Error(chrome.runtime.lastError.message))
          : res(result),
      ),
    );
  }

  // Attach the debugger, run the async body, then always detach.
  // Per-call attach is intentional (human decision, 2026-10-15): the yellow
  // debugging banner lasts only for the duration of the picker intercept.
  async function withDebugger(tabId, body) {
    await new Promise((res, rej) =>
      chrome.debugger.attach({ tabId }, "1.3", () =>
        chrome.runtime.lastError
          ? rej(new Error(chrome.runtime.lastError.message))
          : res(),
      ),
    );
    try {
      return await body();
    } finally {
      pendingChoosers.delete(tabId);
      chrome.debugger.detach({ tabId }, () => {});
    }
  }

  // Option C: intercept the OS file picker via CDP.
  // The MCP server validates paths; background just routes and intercepts.
  async function uploadFilePicker(params) {
    const tabId = await sessionManager.resolveOrFallback(params);

    return withDebugger(tabId, async () => {
      // Enable intercept before clicking so no picker can slip through.
      await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });

      // The click and the CDP event race: we must register before firing the
      // click, or the event can arrive and be missed.
      const chooserPromise = new Promise((resolve, reject) => {
        const tid = setTimeout(() => {
          if (pendingChoosers.has(tabId)) {
            pendingChoosers.delete(tabId);
            reject(new Error("File chooser did not open within 15s"));
          }
        }, 15000);
        pendingChoosers.set(tabId, (eventParams) => {
          clearTimeout(tid);
          resolve(eventParams);
        });
      });

      // Click whatever upload trigger the agent named — button, label, or the
      // input itself. An error here is real (element not found, not actionable).
      await forwardToContentScript("click", { selector: params.selector, tabId });

      await chooserPromise;

      await cdp(tabId, "Page.handleFileChooserOpen", {
        action: "accept",
        files: params.paths,
      });

      return {
        uploaded: params.paths.length,
        files: params.paths.map((p) => p.split("/").pop()),
        tabId,
      };
    });
  }

  // Option B: DataTransfer injection (drop zones). Bytes arrive as base64 in
  // params.files[]. Forwarded to the content script which creates File objects.
  function uploadFileDrop(params) {
    return forwardToContentScript("upload_file", params);
  }

  async function uploadFile(params) {
    const method = params.method || "picker";
    if (method === "drop") return uploadFileDrop(params);
    if (method === "picker") return uploadFilePicker(params);
    throw new Error(`Unknown upload method: "${method}". Use "picker" or "drop".`);
  }

  return { uploadFile, _handleDebuggerEvent };
};
