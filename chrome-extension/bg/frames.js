// PolterTab — frame fan-out for the background service worker.
//
// Loaded by background.js with importScripts, so this runs in the worker's
// global scope: it exports one factory and registers no listeners. Every
// chrome.* listener stays in background.js, where MV3 guarantees the entry
// file's top level runs on the restart that replays the event.

self.PT = self.PT || {};

self.PT.makeFrames = ({ sessionManager }) => {
  // One frame's answer. Bounded well under the navigation timeout because
  // frames are probed in parallel and one dead frame must not stall the batch.
  const FRAME_TIMEOUT_MS = 10000;
  // executeScript can resolve before the content script's listener is live, so
  // the first message into a fresh frame can lose the race. One short retry.
  const FRAME_RETRY_MS = 150;

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

    // Inject into the TOP FRAME only as a safety net for tabs that were open
    // before the extension loaded. Child frames get their content script from
    // the manifest's content_scripts declaration (matches: <all_urls>,
    // run_at: document_start) — re-injecting into all frames via executeScript
    // is expensive (~1s per frame) and unnecessary since the manifest already
    // covers every frame that loaded after the extension was active.
    async function injectTopFrame(tabId) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
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
          const tab = await sessionManager.tabAlive(tabId);
          if (tab && tab.discarded) {
            throw new Error(
              `Tab ${tabId} was discarded by Chrome to save memory, so its page is not loaded. Reload it with browser_navigate({ tabId: ${tabId}, url }) or show it with browser_tab_switch({ tabId: ${tabId}, focus: true }), then retry.`,
            );
          }
          throw new Error(
            "Cannot interact with this page (restricted Chrome page)",
          );
        }
      }
    }

    // Every frame to probe, top frame first, then children.
    async function enumerateFrames(tabId) {
      try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId });
        if (frames && frames.length > 1) {
          return [0, ...frames.map((f) => f.frameId).filter((id) => id !== 0)];
        }
      } catch (_) {
        // webNavigation may fail on restricted pages; fall back to top only.
      }
      return [0];
    }

    // Merge one snapshot per frame into a single page snapshot.
    function mergeSnapshots(results, frameIds, tabId) {
      // No frame answered (a crashed renderer, a page mid-teardown): that
      // used to come back as a successful empty page, which reads exactly
      // like a blank one. Frames that failed while others answered are
      // still skipped, so a partial snapshot stays a snapshot.
      if (!results.some((r) => r && r.success)) {
        const top = results[0];
        throw new Error(
          `Could not snapshot tab ${tabId}: no frame answered (${(top && top.error) || "no response"}). The page may have crashed or still be loading; reload it with browser_navigate.`,
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

    // Element-targeting actions: fast-probe, parallel child frames.
    // Strategy:
    //   1. Try frame 0 instantly (_noWait) — top frame is the most common hit.
    //   2. On miss, probe ALL child frames in parallel (_noWait). Take the
    //      first success. This turns N sequential round-trips into one batch.
    //   3. If still nothing, retry frame 0 WITH the wait — a portal or modal
    //      may be mounting right now in the top document.
    // Cost: element in top frame = 1 round-trip. In any iframe = 2 round-trips.
    // Late modal = 2 round-trips + 3 s wait. Versus the old sequential path
    // that took ~1 s × N frames before even finding the element.
    async function searchFramesForElement(targetTabId, frameIds, action, params) {
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

    async function forwardToContentScript(action, params) {
      const targetTabId = await sessionManager.resolveOrFallback(params);
      await injectTopFrame(targetTabId);
      const frameIds = await enumerateFrames(targetTabId);

      // Aggregate actions: ask every frame, merge what comes back.
      if (isAggregateAction(action, params)) {
        const results = await Promise.all(
          frameIds.map((fid) => sendToFrame(targetTabId, fid, action, params)),
        );
        if (action === "snapshot") {
          return mergeSnapshots(results, frameIds, targetTabId);
        }
        // Full-page scrape without selector: return from the first frame that
        // has body text (top frame preferred).
        for (const r of results) {
          if (r && r.success && r.data) return r.data;
        }
        throw new Error("No frame returned page data");
      }

      return searchFramesForElement(targetTabId, frameIds, action, params);
    }

  return { forwardToContentScript };
};
