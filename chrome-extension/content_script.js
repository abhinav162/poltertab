// PolterTab Content Script — DOM extractor + action executor
// Injected into every page to handle snapshot/scrape/click/fill/scroll/hover/get_text commands.

(() => {
  // How deep to follow nested shadow roots, and how long to wait for an
  // element that has not rendered yet. Raise ELEMENT_WAIT_MS for apps that
  // mount dialogs slowly.
  const MAX_SHADOW_DEPTH = 10;
  const ELEMENT_WAIT_MS = 3000;

  // background.js re-injects this file before every DOM command so tabs that
  // were already open when the extension loaded still get a content script
  // without the user reloading them. Re-execution must therefore be a no-op:
  // unguarded, each injection adds another chrome.runtime.onMessage listener
  // and another interceptor copy, so one command fires N clicks and every
  // intercepted response is captured N times over. The isolated world's
  // globals persist across injections but are wiped on real page loads, which
  // is exactly the lifetime we want.
  if (window.__polterTabInjected) return;
  window.__polterTabInjected = true;

  // --- Inject Interceptor into MAIN world ---
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("interceptor.js");
    script.onload = function () {
      this.remove(); // Clean up DOM after execution

      // Fetch initial patterns and send to MAIN world
      chrome.storage.local.get(["zc_intercept_patterns"], (res) => {
        if (res.zc_intercept_patterns) {
          window.postMessage(
            { type: "ZC_UPDATE_PATTERNS", patterns: res.zc_intercept_patterns },
            "*",
          );
        }
      });
    };
    (document.head || document.documentElement).appendChild(script);
  } catch (err) {
    console.error("[PolterTab] Failed to inject interceptor script:", err);
  }

  // --- Listen for intercepted data from MAIN world ---
  window.addEventListener("message", (event) => {
    // We only accept messages from ourselves
    if (event.source !== window) return;

    if (event.data && event.data.type === "ZC_NETWORK_DATA") {
      // Forward the intercepted data up to the background script
      chrome.runtime.sendMessage(event.data).catch(() => {
        // Ignore connection errors if background is suspended
      });
    }
  });

  function resolveElement(selector) {
    if (!selector) return null;

    // Try CSS selector first
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch (_) {
      // Not a valid CSS selector, fall through
    }

    // Try XPath
    try {
      const result = document.evaluate(
        selector,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      if (result.singleNodeValue) return result.singleNodeValue;
    } catch (_) {
      // Not valid XPath either
    }

    // Try text content match — find element containing exact text
    const walk = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
    );
    let node;
    while ((node = walk.nextNode())) {
      if (node.textContent.trim() === selector.trim()) return node;
    }

    // Same lookups again, this time piercing shadow roots. Deliberately last:
    // a page that resolves in the light DOM takes the exact path it always
    // did, and only a miss pays for the walk.
    return deepQuery(selector) || deepTextMatch(selector);
  }

  // chrome.dom.openOrClosedShadowRoot is an extension-only API that reaches
  // CLOSED roots, which page script cannot touch at all. The property fallback
  // still covers open roots where the API is unavailable.
  function shadowRootOf(el) {
    try {
      if (chrome.dom && chrome.dom.openOrClosedShadowRoot) {
        return chrome.dom.openOrClosedShadowRoot(el);
      }
    } catch (_) {
      // Not a shadow host, or the API refused the node.
    }
    return el.shadowRoot || null;
  }

  // The document, then every shadow root nested inside it.
  // ponytail: querySelectorAll("*") per root is O(nodes) per level. Fine as a
  // fallback that only runs on a light-DOM miss; the depth cap keeps a
  // pathological or self-referential component tree from hanging the page.
  function* shadowRoots(root, depth = 0) {
    yield root;
    if (depth >= MAX_SHADOW_DEPTH) return;
    for (const el of root.querySelectorAll("*")) {
      const sr = shadowRootOf(el);
      if (sr) yield* shadowRoots(sr, depth + 1);
    }
  }

  function deepQuery(selector, all = false) {
    const found = [];
    for (const root of shadowRoots(document)) {
      try {
        if (all) {
          found.push(...root.querySelectorAll(selector));
        } else {
          const el = root.querySelector(selector);
          if (el) return el;
        }
      } catch (_) {
        return all ? [] : null; // not valid CSS at all — nothing to find
      }
    }
    return all ? found : null;
  }

  function deepTextMatch(selector) {
    const target = selector.trim();
    for (const root of shadowRoots(document)) {
      for (const el of root.querySelectorAll("*")) {
        if (el.textContent.trim() === target) return el;
      }
    }
    return null;
  }

  // Modals and portals mount a moment after the click that triggers them, so a
  // miss is usually "too early" rather than "not there". Back off between
  // attempts so a genuinely absent element in a large app does not pay for the
  // full piercing walk thirty times over.
  //
  // When the background worker is searching across multiple frames, it passes
  // _noWait: true so each frame answers instantly. The retry is reserved for a
  // targeted second pass on the frame most likely to contain a late element
  // (frame 0, where portals mount into document.body).
  async function waitForElement(selector, noWait = false) {
    const el = resolveElement(selector);
    if (el) return el;
    if (noWait) throw new Error(`Element not found: ${selector}`);

    const deadline = Date.now() + ELEMENT_WAIT_MS;
    let delay = 100;
    for (;;) {
      await new Promise((r) => setTimeout(r, delay));
      const found = resolveElement(selector);
      if (found) return found;
      if (Date.now() >= deadline) {
        throw new Error(`Element not found: ${selector}`);
      }
      delay = Math.min(delay * 2, 800);
    }
  }

  function snapshot(params) {
    const {
      interactive_only = false,
      compact = true,
      max_depth = null,
      max_nodes = 400,
    } = params;
    const nodes = [];
    const root = document.body || document.documentElement;
    let counter = 0;

    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || 1) === 0
      )
        return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const isInteractive = (el) => {
      if (
        el.matches("a,button,input,select,textarea,summary,[role],*[tabindex]")
      )
        return true;
      return typeof el.onclick === "function";
    };

    const describe = (el, depth) => {
      const interactive = isInteractive(el);
      const text = (el.innerText || el.textContent || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 140);
      if (interactive_only && !interactive) return;
      if (compact && !interactive && !text) return;

      const ref = "@e" + ++counter;
      el.setAttribute("data-zc-ref", ref);
      const node = { ref, depth, tag: el.tagName.toLowerCase(), interactive };
      if (el.id) node.id = el.id;
      const role = el.getAttribute("role");
      if (role) node.role = role;
      if (text) node.text = text;
      if (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT"
      ) {
        if (el.type) node.type = el.type;
        if (el.placeholder) node.placeholder = el.placeholder;
        if (el.value) node.value = el.value.slice(0, 100);
      }
      if (el.tagName === "A" && el.href) node.href = el.href;
      nodes.push(node);
    };

    const walk = (el, depth) => {
      if (!(el instanceof Element)) return;
      if (max_depth !== null && depth > max_depth) return;
      if (nodes.length >= max_nodes) return;
      const tag = el.tagName.toLowerCase();
      if (
        tag === "script" ||
        tag === "style" ||
        tag === "noscript" ||
        tag === "svg"
      )
        return;
      if (isVisible(el)) describe(el, depth);
      for (const child of el.children) {
        walk(child, depth + 1);
        if (nodes.length >= max_nodes) return;
      }
      // Descend into the shadow tree as well, otherwise the agent cannot even
      // see the elements it is expected to produce selectors for.
      const shadow = shadowRootOf(el);
      if (shadow) {
        for (const child of shadow.children) {
          walk(child, depth + 1);
          if (nodes.length >= max_nodes) return;
        }
      }
    };

    if (root) walk(root, 0);

    return {
      title: document.title,
      url: location.href,
      count: nodes.length,
      nodes,
    };
  }

  function scrape(params) {
    const { selector, attribute, multiple } = params;

    if (selector) {
      const elements = multiple
        ? deepQuery(selector, true)
        : [deepQuery(selector)].filter(Boolean);

      return elements.map((el) => {
        if (attribute) return el.getAttribute(attribute);
        return {
          tag: el.tagName.toLowerCase(),
          text: el.textContent.trim().slice(0, 500),
          attributes: Object.fromEntries(
            Array.from(el.attributes).map((a) => [a.name, a.value]),
          ),
        };
      });
    }

    // Full page scrape — return structured data
    const title = document.title;
    const url = location.href;
    const meta = {};
    document.querySelectorAll("meta[name], meta[property]").forEach((m) => {
      const key = m.getAttribute("name") || m.getAttribute("property");
      meta[key] = m.getAttribute("content");
    });

    const links = Array.from(document.querySelectorAll("a[href]"))
      .slice(0, 200)
      .map((a) => ({ text: a.textContent.trim().slice(0, 200), href: a.href }));

    const headings = Array.from(
      document.querySelectorAll("h1, h2, h3, h4, h5, h6"),
    )
      .slice(0, 100)
      .map((h) => ({
        level: parseInt(h.tagName[1]),
        text: h.textContent.trim().slice(0, 500),
      }));

    const bodyText = document.body.innerText.slice(0, 50000);

    return { title, url, meta, links, headings, bodyText };
  }

  async function click(params) {
    const el = await waitForElement(params.selector, params._noWait);

    el.scrollIntoView({ behavior: "smooth", block: "center" });

    // Dispatch full click sequence
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    return { clicked: params.selector, tag: el.tagName.toLowerCase() };
  }

  async function fill(params) {
    const el = await waitForElement(params.selector, params._noWait);

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus();

    // The DOM's value setters are branded to their own interface: reading the
    // setter off HTMLInputElement and calling it on a <textarea> throws
    // "Illegal invocation". The old `input || textarea` chain always resolved
    // to input (its descriptor always exists), leaving the textarea branch
    // unreachable — so fill never worked on a textarea anywhere. Pick the
    // setter that matches the element in front of us.
    const valueProto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : null;
    const nativeInputValueSetter =
      valueProto && Object.getOwnPropertyDescriptor(valueProto, "value")?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, params.value);
    } else if (el.isContentEditable) {
      // Chat composers and rich editors are contenteditable, not form fields.
      el.textContent = params.value;
    } else {
      el.value = params.value;
    }

    // Trigger framework-compatible events
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    if (params.submit) {
      const form = el.closest("form");
      if (form) form.submit();
    }

    return { filled: params.selector, value: params.value };
  }

  async function scroll(params) {
    const { direction = "down", amount = 500, selector } = params;

    const target = selector ? await waitForElement(selector, params._noWait) : window;

    const scrollOpts = { behavior: "smooth" };
    switch (direction) {
      case "down":
        scrollOpts.top = amount;
        break;
      case "up":
        scrollOpts.top = -amount;
        break;
      case "left":
        scrollOpts.left = -amount;
        break;
      case "right":
        scrollOpts.left = amount;
        break;
      case "top":
        if (target === window) {
          window.scrollTo({ top: 0, behavior: "smooth" });
          return { scrolled: "top" };
        }
        target.scrollTop = 0;
        return { scrolled: "top" };
      case "bottom":
        if (target === window) {
          window.scrollTo({
            top: document.body.scrollHeight,
            behavior: "smooth",
          });
          return { scrolled: "bottom" };
        }
        target.scrollTop = target.scrollHeight;
        return { scrolled: "bottom" };
      default:
        throw new Error(`Unknown scroll direction: ${direction}`);
    }

    if (target === window) {
      window.scrollBy(scrollOpts);
    } else {
      target.scrollBy(scrollOpts);
    }

    return {
      scrolled: direction,
      amount,
      scrollY: window.scrollY,
      scrollHeight: document.body.scrollHeight,
    };
  }

  async function hover(params) {
    const el = await waitForElement(params.selector, params._noWait);

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

    return { hovered: params.selector, tag: el.tagName.toLowerCase() };
  }

  async function getText(params) {
    const el = await waitForElement(params.selector, params._noWait);
    return { text: el.textContent.trim().slice(0, 10000) };
  }

  function getTitle() {
    return { title: document.title, url: location.href };
  }

  // Message handler — receives commands from background.js
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.source !== "poltertab") return false;

    const { action, params = {} } = message;

    if (action === "update_patterns") {
      window.postMessage(
        { type: "ZC_UPDATE_PATTERNS", patterns: params.patterns },
        "*",
      );
      sendResponse({ success: true });
      return true;
    }

    const handlers = {
      snapshot,
      scrape,
      click,
      fill,
      scroll,
      hover,
      get_text: getText,
      get_title: getTitle,
    };

    const handler = handlers[action];
    if (!handler) {
      sendResponse({
        success: false,
        error: `Unknown content action: ${action}`,
      });
      return true;
    }

    // Actions can now await a late-rendering element, so the reply is always
    // asynchronous. Returning true keeps the sendResponse channel open.
    Promise.resolve()
      .then(() => handler(params))
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  });
})();
