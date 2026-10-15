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
  // Values are the ownResolve wrapper functions (used for identity-checked timers).
  const pendingChoosers = new Map(); // tabId -> ownResolve fn

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
      // Read lastError so Chrome does not log "Unchecked runtime.lastError" when
      // the tab closed before we detached.
      chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
    }
  }

  // Build a chooser-opened promise that is safe across retries.
  // The timeout checks own identity so a stale timer from a failed call
  // cannot delete a retry's resolver and cause it to time out too.
  function makeChooserPromise(tabId) {
    return new Promise((resolve, reject) => {
      const ownResolve = (eventParams) => {
        clearTimeout(tid);
        resolve(eventParams);
      };
      const tid = setTimeout(() => {
        if (pendingChoosers.get(tabId) === ownResolve) {
          pendingChoosers.delete(tabId);
          reject(new Error("File chooser did not open within 15s"));
        }
      }, 15000);
      pendingChoosers.set(tabId, ownResolve);
    });
  }

  // Option C: intercept the OS file picker via CDP.
  // The MCP server validates paths; background just routes and intercepts.
  async function uploadFilePicker(params) {
    const tabId = await sessionManager.resolveOrFallback(params);

    return withDebugger(tabId, async () => {
      // Page.enable ensures Page domain events (including fileChooserOpened)
      // are delivered. Puppeteer/Playwright always send this after attach.
      await cdp(tabId, "Page.enable", {});
      await cdp(tabId, "DOM.enable", {});

      // Try to locate the element in the top-level DOM to check whether it is
      // a direct <input type="file">. If so we skip the chooser intercept
      // entirely and inject files directly (no user-activation required,
      // no race with the OS picker). For buttons, labels, shadow-DOM and
      // iframe targets we fall through to the trusted-click + chooser path.
      let directNodeId = null;
      try {
        const doc = await cdp(tabId, "DOM.getDocument", { depth: 0 });
        const query = await cdp(tabId, "DOM.querySelector", {
          nodeId: doc.root.nodeId,
          selector: params.selector,
        });
        if (query.nodeId) {
          const { attributes } = await cdp(tabId, "DOM.getAttributes", {
            nodeId: query.nodeId,
          });
          // attributes is a flat [name, value, name, value, …] array.
          const attrMap = {};
          for (let i = 0; i + 1 < attributes.length; i += 2) {
            attrMap[attributes[i].toLowerCase()] = attributes[i + 1];
          }
          if (attrMap.type === "file") directNodeId = query.nodeId;
        }
      } catch (_) {
        // Selector not found at the top-level document (shadow DOM / iframe) —
        // fall through to the trusted-click + chooser-intercept path.
      }

      if (directNodeId !== null) {
        // Target is the file input itself: inject files without opening a picker.
        await cdp(tabId, "DOM.setFileInputFiles", {
          files: params.paths,
          nodeId: directNodeId,
        });
        return {
          uploaded: params.paths.length,
          files: params.paths.map((p) => p.split("/").pop()),
          tabId,
        };
      }

      // Not a direct file input (button, label, shadow DOM, iframe target):
      // enable the chooser intercept, then fire a *trusted* click over CDP
      // (Input.dispatchMouseEvent has user activation, unlike a content-script
      // synthetic event which Chrome blocks before the picker can open).
      await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });

      // Register the chooser resolver BEFORE the click so the event cannot
      // arrive and be missed between the click and the await.
      const chooserPromise = makeChooserPromise(tabId);

      // Resolve element center for the trusted click.
      // Primary: DOM.getBoxModel (top-level DOM, handles iframes by bounding rect).
      // Fallback: Runtime.evaluate to pierce shadow roots.
      let cx, cy;
      try {
        const doc = await cdp(tabId, "DOM.getDocument", { depth: 0 });
        const query = await cdp(tabId, "DOM.querySelector", {
          nodeId: doc.root.nodeId,
          selector: params.selector,
        });
        if (!query.nodeId) throw new Error("not found");
        const box = await cdp(tabId, "DOM.getBoxModel", { nodeId: query.nodeId });
        // border quad: [x0,y0, x1,y1, x2,y2, x3,y3] clockwise from top-left.
        const [x0, y0, x1, y1, x2, y2, x3, y3] = box.model.border;
        cx = (x0 + x1 + x2 + x3) / 4;
        cy = (y0 + y1 + y2 + y3) / 4;
      } catch (_) {
        // Shadow-DOM or iframe element not reachable from the main frame DOM:
        // evaluate in-page JS to obtain its viewport-relative center.
        // getBoundingClientRect() is already viewport-relative; no scroll adjustment needed.
        const sel = params.selector;
        const ev = await cdp(tabId, "Runtime.evaluate", {
          expression: `(function() {
            // 1. Main frame direct lookup
            var el = document.querySelector(${JSON.stringify(sel)});
            if (!el) {
              // 2. Open shadow roots (one level deep)
              var w = document.createTreeWalker(document.body, 1);
              var n;
              while ((n = w.nextNode())) {
                if (n.shadowRoot) {
                  var s = n.shadowRoot.querySelector(${JSON.stringify(sel)});
                  if (s) { el = s; break; }
                }
              }
            }
            if (!el) {
              // 3. Top-level same-origin iframes; cross-origin frames throw SecurityError — skip them.
              // The inner document's viewport starts at the iframe content box, not the border box.
              // Adjust by clientLeft/clientTop (border widths) and computed padding.
              var frames = document.querySelectorAll('iframe');
              var hasOopif = false;
              for (var i = 0; i < frames.length; i++) {
                try {
                  var fd = frames[i].contentDocument;
                  if (!fd) { hasOopif = true; continue; }
                  var fe = fd.querySelector(${JSON.stringify(sel)});
                  if (!fe) continue;
                  var f = frames[i];
                  var ir = f.getBoundingClientRect();
                  var cs = getComputedStyle(f);
                  // clientLeft/clientTop = border widths; add computed padding for the content-box start
                  var contentLeft = ir.left + f.clientLeft + parseFloat(cs.paddingLeft);
                  var contentTop  = ir.top  + f.clientTop  + parseFloat(cs.paddingTop);
                  var er = fe.getBoundingClientRect();
                  return { coords: [contentLeft + er.left + er.width / 2,
                                    contentTop  + er.top  + er.height / 2] };
                } catch (_) { hasOopif = true; }
              }
              return { notFound: true, hasOopif: hasOopif };
            }
            var r = el.getBoundingClientRect();
            return { coords: [r.left + r.width / 2, r.top + r.height / 2] };
          })()`,
          returnByValue: true,
        });
        const val = ev.result && ev.result.value;
        if (!val || val.notFound) {
          const oopifNote = val && val.hasOopif
            ? " Cross-origin (out-of-process) iframes are not supported; only same-origin iframes are searched."
            : "";
          throw new Error(`Element not found: "${params.selector}".${oopifNote}`);
        }
        [cx, cy] = val.coords;
      }

      // Trusted click — Input.dispatchMouseEvent earns user activation,
      // which is what Chrome requires before it will open a file picker.
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: cx,
        y: cy,
        button: "left",
        buttons: 1,
        clickCount: 1,
        pointerType: "mouse",
      });
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: cx,
        y: cy,
        button: "left",
        buttons: 0,
        clickCount: 1,
        pointerType: "mouse",
      });

      // Wait for Page.fileChooserOpened; it carries the backendNodeId of the
      // input that Chrome opened the picker for.
      const evt = await chooserPromise;

      // Answer the intercepted chooser by writing files directly to the input.
      await cdp(tabId, "DOM.setFileInputFiles", {
        files: params.paths,
        backendNodeId: evt.backendNodeId,
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
