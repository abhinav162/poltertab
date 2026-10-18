// Load current setting
chrome.storage.local.get(["wsPort"], (result) => {
  document.getElementById("wsPort").value = result.wsPort || 7822;
});

// Save setting
document.getElementById("saveBtn").addEventListener("click", () => {
  const port = parseInt(document.getElementById("wsPort").value, 10);
  if (Number.isNaN(port) || port < 1024 || port > 65535) {
    alert("Please enter a valid port between 1024 and 65535");
    return;
  }

  chrome.storage.local.set({ wsPort: port }, () => {
    const status = document.getElementById("status");
    status.textContent = "Options saved.";
    setTimeout(() => {
      status.textContent = "";
    }, 2000);
  });
});

// ---- Upload permissions panel (DAG-41) -------------------------------------
// All data is the server's ~/.poltertab/config.json and uploads.log.jsonl,
// fetched over the existing WebSocket via the background worker. The panel never
// keeps an editable cached copy: if the server is unreachable it says so and
// points at the CLI. Edits ride the WS and are validated server-side.
(() => {
  const body = document.getElementById("uploads-body");
  if (!body) return;

  // Promise wrapper over chrome.runtime.sendMessage. Resolves to the reply, or
  // null when the background/server never answers (lastError or a timeout) so
  // the caller can fall back to the offline state instead of hanging.
  function ask(type, data) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), 6000);
      try {
        chrome.runtime.sendMessage({ type, data }, (reply) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) return finish(null);
          finish(reply || null);
        });
      } catch (_) {
        clearTimeout(timer);
        finish(null);
      }
    });
  }

  // --- small DOM helpers (textContent only — server strings are never HTML) ---
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function baseName(p) {
    const s = String(p || "").replace(/[\\/]+$/, "");
    const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function renderOffline() {
    body.textContent = "";
    const p = el("p", "u-notice u-offline");
    p.append(
      "Can't reach the PolterTab server, so folders can't be shown or changed here. Start the server, then reopen this page — or manage folders in a terminal with ",
    );
    p.append(el("code", null, "poltertab uploads"));
    p.append(".");
    body.appendChild(p);
  }

  function renderNotPaired(pairCode) {
    body.textContent = "";
    let extId = "";
    try { extId = chrome.runtime.id || ""; } catch (_) {}

    if (pairCode) {
      // Show the code prominently; extension ID in a collapsed details block.
      const p = el("p", "u-notice");
      p.append("Enter this code in the terminal where you ran ");
      p.append(el("code", null, "poltertab uploads pair"));
      p.append(":");
      body.appendChild(p);

      const codeEl = el("div", "u-pair-code", pairCode);
      body.appendChild(codeEl);

      const details = document.createElement("details");
      details.className = "u-id-details";
      const summary = document.createElement("summary");
      summary.textContent = "Extension ID";
      details.appendChild(summary);
      details.appendChild(el("span", "u-id", extId || "(unknown)"));
      body.appendChild(details);
    } else {
      // No code yet — server hasn't pushed one (may not be running).
      const p = el("p", "u-notice");
      p.append("Start poltertab in a terminal, then run ");
      p.append(el("code", null, "poltertab uploads pair"));
      p.append(". A pairing code will appear here once the extension connects.");
      body.appendChild(p);

      if (extId) {
        const details = document.createElement("details");
        details.className = "u-id-details";
        const summary = document.createElement("summary");
        summary.textContent = "Extension ID";
        details.appendChild(summary);
        details.appendChild(el("span", "u-id", extId));
        body.appendChild(details);
      }
    }
  }

  function renderError(message) {
    body.textContent = "";
    const p = el("p", "u-notice");
    p.append("Uploads couldn't be loaded: ");
    p.append(el("code", null, String(message || "unknown error")));
    body.appendChild(p);
  }

  // Capture a half-typed add-folder path (and any inline error) before a
  // re-render, so the focus-triggered refresh doesn't wipe what the user was
  // typing while they tabbed away to copy a path.
  function captureDraft() {
    const i = document.getElementById("uploads-add-path");
    if (!i) return null;
    const e = document.getElementById("uploads-add-error");
    return { value: i.value || "", error: e ? e.textContent : "" };
  }

  function renderConfig(allowlist, alwaysBlocked, draft, trustedExtensionIds) {
    body.textContent = "";

    // Paired extension id (SHOULD 4 — show which id holds config access).
    if (trustedExtensionIds && trustedExtensionIds.length > 0) {
      const paired = el("p", "u-sub", "Paired extension");
      body.appendChild(paired);
      trustedExtensionIds.forEach((id) => {
        body.appendChild(el("div", "u-id", id));
      });
    }

    // Allowed folders
    body.appendChild(el("p", "u-sub", "Allowed folders"));
    if (!allowlist || allowlist.length === 0) {
      body.appendChild(
        el("div", "u-empty", "Uploads are off. Add a folder to let agents upload files from it."),
      );
    } else {
      const ul = el("ul", "u-list");
      allowlist.forEach((dir) => {
        const li = el("li", "u-row");
        li.appendChild(el("span", "u-path", dir));
        const btn = el("button", "u-remove", "Remove");
        btn.type = "button";
        btn.addEventListener("click", (e) => {
          if (!e.isTrusted) return; // god review: trusted user input only
          removeFolder(dir, btn);
        });
        li.appendChild(btn);
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }

    // Add folder
    const add = el("div", "u-add");
    const input = document.createElement("input");
    input.type = "text";
    input.id = "uploads-add-path";
    input.placeholder = "~/Documents or /Users/you/Projects";
    input.setAttribute("aria-label", "Folder to allow");
    input.autocomplete = "off";
    input.spellcheck = false;
    const addBtn = el("button", null, "Add folder");
    addBtn.type = "button";
    addBtn.id = "uploads-add-btn";
    add.appendChild(input);
    add.appendChild(addBtn);
    body.appendChild(add);

    const err = el("div", "u-error");
    err.id = "uploads-add-error";
    err.setAttribute("role", "alert");
    body.appendChild(err);

    if (draft) {
      input.value = draft.value;
      err.textContent = draft.error || "";
    }

    addBtn.addEventListener("click", (e) => {
      if (!e.isTrusted) return; // god review: trusted user input only
      submitAdd(input, err, addBtn);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (!e.isTrusted) return;
        submitAdd(input, err, addBtn);
      }
    });

    // Never allowed (display only)
    body.appendChild(el("p", "u-sub", "Never allowed"));
    const note = el("p", "hint", "These are always blocked and can't be added, anywhere.");
    body.appendChild(note);
    const blocked = el("ul", "u-blocked");
    (alwaysBlocked || []).forEach((p) => blocked.appendChild(el("li", null, p)));
    blocked.appendChild(el("li", null, "Home dotfiles (files in your home folder starting with a dot)"));
    body.appendChild(blocked);

    // Recent uploads
    body.appendChild(el("p", "u-sub", "Recent uploads"));
    const logHost = el("div");
    logHost.id = "uploads-log-host";
    logHost.appendChild(el("p", "hint", "Loading…"));
    body.appendChild(logHost);
    loadLog(logHost);
  }

  function renderLog(host, entries) {
    host.textContent = "";
    if (!entries || entries.length === 0) {
      host.appendChild(el("p", "hint", "No uploads yet."));
      return;
    }
    const ul = el("ul", "u-log");
    entries.slice().reverse().forEach((entry) => {
      const li = el("li");
      let t = "";
      try {
        t = new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } catch (_) { t = ""; }
      li.appendChild(el("span", "u-time", t));

      const paths = Array.isArray(entry.paths) ? entry.paths : (entry.paths ? [entry.paths] : []);
      let name = paths.length ? baseName(paths[0]) : "(file)";
      if (paths.length > 1) name += ` +${paths.length - 1}`;
      li.appendChild(el("span", "u-file", name));

      const outcome = String(entry.outcome || "");
      const allowed = outcome === "ok";
      const badge = el("span", "u-badge " + (allowed ? "ok" : "denied"), allowed ? "allowed" : "denied");
      li.appendChild(badge);
      ul.appendChild(li);
    });
    host.appendChild(ul);
  }

  async function loadLog(host) {
    const reply = await ask("uploads_get_log", { n: 20 });
    if (!reply || reply.type !== "uploads_log") {
      host.textContent = "";
      host.appendChild(el("p", "hint", "Activity log unavailable."));
      return;
    }
    renderLog(host, reply.entries);
  }

  async function submitAdd(input, err, addBtn) {
    const dir = input.value.trim();
    err.textContent = "";
    if (!dir) {
      err.textContent = "Type a folder path first.";
      return;
    }
    addBtn.disabled = true;
    const reply = await ask("uploads_set_config", { action: "add", dir });
    addBtn.disabled = false;
    if (!reply) { err.textContent = "Couldn't reach the server. Try again."; return; }
    if (reply.type === "uploads_not_paired") { renderNotPaired(reply.pairCode); return; }
    if (reply.type === "uploads_error") { err.textContent = reply.error || "Server error."; return; }
    if (reply.ok) { input.value = ""; load(); return; }
    // Validation rejection echoed inline (always-blocked, not a directory, …)
    err.textContent = reply.error || "That folder couldn't be added.";
  }

  async function removeFolder(dir, btn) {
    const err = document.getElementById("uploads-add-error");
    btn.disabled = true;
    const reply = await ask("uploads_set_config", { action: "remove", dir });
    if (!reply) {
      btn.disabled = false;
      if (err) err.textContent = "Couldn't reach the server. Try again.";
      return;
    }
    if (reply.type === "uploads_not_paired") { renderNotPaired(reply.pairCode); return; }
    if (reply.type === "uploads_error" || (reply.ok === false && reply.error)) {
      btn.disabled = false;
      if (err) err.textContent = reply.error || "Server error.";
      return;
    }
    load();
  }

  async function load() {
    const draft = captureDraft();
    const reply = await ask("uploads_get_config");
    if (!reply) return renderOffline();
    if (reply.type === "uploads_not_paired") return renderNotPaired(reply.pairCode);
    if (reply.type === "uploads_error") return renderError(reply.error);
    if (reply.type === "uploads_config") return renderConfig(reply.allowlist, reply.alwaysBlocked, draft, reply.trustedExtensionIds);
    if (reply.ok === false) return renderOffline(); // "Not connected to bridge server."
    renderError("unexpected response");
  }

  load();
  // Reflect a CLI edit made while this page is open.
  window.addEventListener("focus", () => load());
  // Flip live when the extension is paired (background.js broadcasts this).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "uploads_paired_notice") load();
    if (msg.type === "state_update" && msg.state && msg.state.pairCode !== undefined) {
      // Refresh the not-paired UI only when we're actually showing it (not the
      // config view or the offline notice — both also have .u-notice).
      const offlineEl = document.querySelector(".u-offline");
      const configEl = document.querySelector(".u-sub");
      if (!offlineEl && !configEl) renderNotPaired(msg.state.pairCode);
    }
  });
})();
