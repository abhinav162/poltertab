// PolterTab Content Script — DOM extractor + action executor
// Injected into every page to handle snapshot/scrape/click/fill/scroll/hover/get_text commands.

(() => {
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

    return null;
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
        ? Array.from(document.querySelectorAll(selector))
        : [document.querySelector(selector)].filter(Boolean);

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

  function click(params) {
    const el = resolveElement(params.selector);
    if (!el) throw new Error(`Element not found: ${params.selector}`);

    el.scrollIntoView({ behavior: "smooth", block: "center" });

    // Dispatch full click sequence
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    return { clicked: params.selector, tag: el.tagName.toLowerCase() };
  }

  function fill(params) {
    const el = resolveElement(params.selector);
    if (!el) throw new Error(`Element not found: ${params.selector}`);

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus();

    // Clear existing value
    const nativeInputValueSetter =
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
        ?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, params.value);
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

  function scroll(params) {
    const { direction = "down", amount = 500, selector } = params;

    const target = selector ? resolveElement(selector) : window;
    if (selector && !target) throw new Error(`Element not found: ${selector}`);

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

  function hover(params) {
    const el = resolveElement(params.selector);
    if (!el) throw new Error(`Element not found: ${params.selector}`);

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

    return { hovered: params.selector, tag: el.tagName.toLowerCase() };
  }

  function getText(params) {
    const el = resolveElement(params.selector);
    if (!el) throw new Error(`Element not found: ${params.selector}`);
    return { text: el.textContent.trim().slice(0, 10000) };
  }

  function getTitle() {
    return { title: document.title, url: location.href };
  }

  // Message handler — receives commands from background.js
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.source !== "poltertab") return false;

    const { action, params = {} } = message;

    try {
      let result;
      switch (action) {
        case "update_patterns":
          window.postMessage(
            { type: "ZC_UPDATE_PATTERNS", patterns: params.patterns },
            "*",
          );
          sendResponse({ success: true });
          return true;
        case "snapshot":
          result = snapshot(params);
          break;
        case "scrape":
          result = scrape(params);
          break;
        case "click":
          result = click(params);
          break;
        case "fill":
          result = fill(params);
          break;
        case "scroll":
          result = scroll(params);
          break;
        case "hover":
          result = hover(params);
          break;
        case "get_text":
          result = getText(params);
          break;
        case "get_title":
          result = getTitle();
          break;
        default:
          sendResponse({
            success: false,
            error: `Unknown content action: ${action}`,
          });
          return true;
      }
      sendResponse({ success: true, data: result });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }

    return true; // keep sendResponse channel open
  });
})();
