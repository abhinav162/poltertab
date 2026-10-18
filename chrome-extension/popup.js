document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("conn-status");
  const listEl = document.getElementById("session-list");
  const refreshBtn = document.getElementById("refreshBtn");
  const optionsBtn = document.getElementById("optionsBtn");
  const versionEl = document.getElementById("versions");
  const warnEl = document.getElementById("skew-warning");

  const SVGNS = "http://www.w3.org/2000/svg";
  // Per-agent ghost tint. The name picks one of six hues deterministically, so
  // an agent keeps its color across refreshes. The shades themselves live in
  // the stylesheet (.agent-ghost.tint-N) with a light- and dark-mode value each,
  // so every tint clears AA contrast on the card in both themes.
  const TINT_COUNT = 6;
  function tintIndex(id) {
    const s = String(id || "");
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 37) + s.charCodeAt(i)) >>> 0;
    return h % TINT_COUNT;
  }

  // Build a ghost SVG. kind: "agent" (eyes knock out to card bg) | "big" (paper eyes).
  function makeGhost(kind, { size = 56, color, float = false, sleepy = false } = {}) {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 64 64");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "ghost" + (float ? " float" : ""));
    if (color) svg.style.color = color;
    const body = document.createElementNS(SVGNS, "path");
    body.setAttribute("d", "M32 11c-9.1 0-15.5 6.9-15.5 15.6V46c0 1.9 2.3 2.7 3.6 1.3l2.7-2.9 2.9 3.1c.8.8 2 .8 2.7 0l3-3.3 3 3.3c.8.8 2 .8 2.7 0l2.9-3.1 2.7 2.9c1.3 1.4 3.6.6 3.6-1.3V26.6C47.5 17.9 41.1 11 32 11Z");
    body.setAttribute("fill", "currentColor");
    svg.appendChild(body);
    // Agent eyes knock out to the card via the .eye CSS rule (var() is only valid
    // in a CSS property, never in an SVG fill attribute). Other ghosts use a
    // literal paper fill.
    const paperEye = "#FAF9F6";
    if (sleepy) {
      const lids = document.createElementNS(SVGNS, "path");
      lids.setAttribute("d", "M23 26.5q3.5 3 7 0M34 26.5q3.5 3 7 0");
      lids.setAttribute("fill", "none");
      lids.setAttribute("stroke", paperEye);
      lids.setAttribute("stroke-width", "2.2");
      lids.setAttribute("stroke-linecap", "round");
      svg.appendChild(lids);
    } else {
      for (const cx of [26.5, 37.5]) {
        const eye = document.createElementNS(SVGNS, "circle");
        eye.setAttribute("cx", cx);
        eye.setAttribute("cy", "26");
        eye.setAttribute("r", "2.8");
        if (kind === "agent") eye.setAttribute("class", "eye");
        else eye.setAttribute("fill", paperEye);
        svg.appendChild(eye);
      }
    }
    return svg;
  }

  function emptyState({ text, ghost }) {
    const div = document.createElement("div");
    div.className = "empty-state" + (ghost && ghost.sleepy ? " sleepy" : "");
    if (ghost) div.appendChild(makeGhost("big", ghost));
    div.appendChild(document.createTextNode(text));
    return div;
  }

  // Only major.minor matters. A patch-level gap is the normal state of things
  // for a minute after an upgrade, and warning about it teaches people to
  // ignore the warning.
  function isSkewed(a, b) {
    if (!a || !b) return false;
    const key = (v) => String(v).split(".").slice(0, 2).join(".");
    return key(a) !== key(b);
  }

  // Cached pair code from background; updated via state_update broadcasts.
  let cachedPairCode = null;

  function updateUI(state) {
    if (state.pairCode !== undefined) cachedPairCode = state.pairCode;
    // Status
    statusEl.textContent = state.connected ? "Connected" : "Disconnected";
    statusEl.className =
      "status " + (state.connected ? "connected" : "disconnected");

    // Version line. An unpacked extension never auto-updates, so a stale one
    // can sit here for months looking perfectly healthy. Body type, no mono.
    if (versionEl) {
      const mine = state.version || "?";
      const theirs = state.serverVersion;
      const skewed = isSkewed(mine, theirs);
      versionEl.textContent = theirs
        ? `Extension ${mine}, server ${theirs}`
        : `Extension ${mine}`;
      versionEl.className = "versions" + (skewed ? " skew" : "");
      versionEl.title = skewed
        ? "Version mismatch. Commands may fail; reload the extension from the latest release."
        : "";
      if (warnEl) {
        warnEl.hidden = !skewed;
        warnEl.textContent = skewed
          ? `Version mismatch: extension ${mine} vs server ${theirs}. Update the older half.`
          : "";
      }
    }

    // List
    listEl.textContent = "";
    const sessions = state.sessions || [];

    if (sessions.length === 0) {
      listEl.appendChild(
        state.connected
          ? emptyState({
              text: "No agents yet. Point an MCP client at the server and it floats in here.",
              ghost: { color: "var(--ecto)", float: true, size: 60 },
            })
          : emptyState({
              text: "Not connected. Start the server, then check the port in Settings.",
              ghost: { sleepy: true, size: 60 },
            })
      );
      return;
    }

    sessions.forEach((session) => {
      const li = document.createElement("li");
      li.className = "session-item";

      const agentGhost = makeGhost("agent", { size: 26 });
      agentGhost.classList.add("agent-ghost", "tint-" + tintIndex(session.id));
      li.appendChild(agentGhost);

      const text = document.createElement("span");
      text.className = "session-text";

      const nameSpan = document.createElement("span");
      nameSpan.className = "session-name";
      nameSpan.textContent = session.id || "Unknown Agent";
      // Live upload indicator (DAG-41 feeds session.uploading over the WS).
      if (session.uploading) {
        const badge = document.createElement("span");
        badge.className = "live";
        badge.textContent = "uploading…";
        nameSpan.appendChild(badge);
      }

      const metaSpan = document.createElement("span");
      metaSpan.className = "session-meta";
      metaSpan.textContent = `Node: ${session.nodeId || "N/A"}`;
      if (session.lastTabId) {
        metaSpan.textContent += ` | Tab: ${session.lastTabId}`;
      }

      text.appendChild(nameSpan);
      text.appendChild(metaSpan);
      li.appendChild(text);
      listEl.appendChild(li);
    });
  }

  function fetchStatus() {
    chrome.runtime.sendMessage({ type: "get_status" }, (response) => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = "Error";
        statusEl.className = "status disconnected";
        listEl.textContent = "";
        listEl.appendChild(
          emptyState({
            text: "Failed to reach the background script. Reload the extension from chrome://extensions.",
          })
        );
        return;
      }
      if (response) {
        updateUI(response);
      }
    });
  }

  refreshBtn.addEventListener("click", () => {
    // Force a fresh request to primary if connected
    chrome.runtime.sendMessage({ type: "force_refresh" }, (response) => {
      if (response) updateUI(response);
    });
  });

  optionsBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // Uploads summary row (DAG-41). One line + a "view" link to the options panel.
  // Reads the server allowlist over the WS; stays hidden if the server is
  // unreachable (the connection pill already shows that case).
  const uploadsRow = document.getElementById("uploads-summary");
  const uploadsText = document.getElementById("uploads-summary-text");
  if (uploadsRow) {
    uploadsRow.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }
  function loadUploadsSummary() {
    try {
      chrome.runtime.sendMessage({ type: "uploads_get_config" }, (reply) => {
        if (chrome.runtime.lastError || !reply) return; // leave hidden
        if (!uploadsRow || !uploadsText) return;
        if (reply.type === "uploads_not_paired") {
          uploadsText.textContent = cachedPairCode
            ? `Pair code: ${cachedPairCode}`
            : "Not paired — run poltertab uploads pair";
        } else if (reply.type === "uploads_config") {
          const n = (reply.allowlist || []).length;
          uploadsText.textContent =
            n === 0 ? "Uploads off" : `Uploads: ${n} folder${n === 1 ? "" : "s"} allowed`;
        } else {
          return; // error / offline → stay hidden
        }
        uploadsRow.hidden = false;
      });
    } catch (_) {
      /* leave hidden */
    }
  }

  // Initial fetch
  fetchStatus();
  loadUploadsSummary();

  // Listen for broadcast updates from background.js
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "state_update") {
      updateUI(msg.state);
    }
  });
});
