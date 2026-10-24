// Y. Upload permissions — server-side config, log, WS gating, CLI, badge, guard
//
//   Y1  validateAllowlistEntry rejects ~/.ssh, /etc/foo, relative paths
//   Y2  validateAllowlistEntry accepts valid absolute path, ~/Documents, nonexistent dir
//   Y3  addAllowlistEntry writes entry, other keys preserved
//   Y4  addAllowlistEntry duplicate is idempotent
//   Y5  removeAllowlistEntry removes entry; config remains valid JSON
//   Y6  logUpload appends one correct JSON line
//   Y7  logUpload rotation drops old lines when file exceeds LOG_MAX_BYTES
//   Y8  getRecentLog(n) returns last n entries
//   Y9  WS uploads_get_config returns uploads_not_paired when no ID is paired
//   Y10 WS uploads_get_config succeeds from paired extension ID
//   Y11 WS uploads_get_config returns uploads_not_paired for untrusted ID
//   Y12 WS uploads_get_config returns uploads_not_paired for originless socket
//   Y13 poltertab uploads pair on non-TTY without --id exits 1
//   Y14 addTrustedExtensionId preserves unknown config keys
//   Y15 proxy_command to CHROME-EXTENSION:// URL returns self_navigation_refused
//   Y16 proxy_command to chrome-extension:// URL returns self_navigation_refused
//   Y17 Badge code present in background.js
//   Y18 CLI uploads subcommand present in poltertab.js
//   Y19 Disabled-upload error text points to CLI
//   Y20 logUpload called in index.js

const { REPO, assert, fs, path, test, WebSocket, startServer, waitFor, sleep } = require("./harness.js");
const { freePort, stop } = require("./group-s.js");
const os = require("os");
const crypto = require("crypto");

const UPLOAD_PATHS = path.join(REPO, "mcp-server", "upload-paths.js");
const UPLOADS_CONFIG = path.join(REPO, "mcp-server", "uploads-config.js");
const UPLOADS_LOG = path.join(REPO, "mcp-server", "uploads-log.js");
const BRIDGE = path.join(REPO, "mcp-server", "bridge.js");
const BG = path.join(REPO, "chrome-extension", "background.js");
const POLTERTAB_BIN = path.join(REPO, "bin", "poltertab.js");
const INDEX = path.join(REPO, "mcp-server", "index.js");

// Helpers to isolate file I/O tests in temp directories
function makeTmpHome() {
  const dir = path.join(os.tmpdir(), "poltertab-test-" + crypto.randomBytes(4).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function groupY() {
  console.log("\nY. upload permissions");

  // ── Y1: validateAllowlistEntry rejects bad inputs ────────────────────────
  await test("Y1 validateAllowlistEntry rejects ~/.ssh, /etc/foo, relative paths", () => {
    // We need to load with a fake homeDir so the test is hermetic.
    // Delete the cached module to allow fresh require (tests run in same process)
    delete require.cache[require.resolve(UPLOAD_PATHS)];
    const { validateAllowlistEntry } = require(UPLOAD_PATHS);

    const fakeHome = "/fake/home";

    const bad = [
      ["/fake/home/.ssh", "always-blocked"],
      ["/fake/home/.ssh/id_rsa", "always-blocked subdir"],
      ["/etc/foo", "always-blocked /etc"],
      ["relative/path", "relative path"],
      ["../other", "relative path"],
    ];
    for (const [dir, desc] of bad) {
      const r = validateAllowlistEntry(dir, fakeHome);
      assert.strictEqual(r.ok, false, `Expected rejection for ${desc}: ${dir}`);
    }
  });

  // ── Y2: validateAllowlistEntry accepts valid paths ───────────────────────
  await test("Y2 validateAllowlistEntry accepts valid absolute, ~/relative, nonexistent", () => {
    delete require.cache[require.resolve(UPLOAD_PATHS)];
    const { validateAllowlistEntry } = require(UPLOAD_PATHS);

    const fakeHome = "/fake/home";
    const good = [
      ["/fake/home/Documents", "absolute subdir of home"],
      ["~/Desktop", "~/relative (expanded to real home, which is fine)"],
      ["/nonexistent/future/dir", "nonexistent dir"],
    ];
    for (const [dir, desc] of good) {
      const r = validateAllowlistEntry(dir, fakeHome);
      assert.strictEqual(r.ok, true, `Expected acceptance for ${desc}: ${dir} — got: ${r.errorText}`);
    }
  });

  // ── Y3: addAllowlistEntry writes entry, other keys preserved ─────────────
  await test("Y3 addAllowlistEntry writes entry, other keys preserved", () => {
    const tmpHome = makeTmpHome();
    try {
      const configPath = path.join(tmpHome, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ some_other_key: 42 }), "utf8");

      // Load with custom POLTERTAB_HOME by temporarily pointing env (then restoring)
      // Since the module uses require("./config.js") which reads env at load time,
      // we monkey-patch by loading directly against the real module cache.
      // Easiest: set env, delete cache, require, restore.
      const origHome = process.env.POLTERTAB_HOME;
      process.env.POLTERTAB_HOME = tmpHome;
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "config.js"))];
      delete require.cache[require.resolve(UPLOADS_CONFIG)];
      const { addAllowlistEntry, getAllowlist } = require(UPLOADS_CONFIG);

      addAllowlistEntry("/some/dir");
      const list = getAllowlist();
      assert.deepStrictEqual(list, ["/some/dir"], "allowlist entry not saved");

      // Other keys must survive
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
      assert.strictEqual(raw.some_other_key, 42, "other key lost");

      process.env.POLTERTAB_HOME = origHome !== undefined ? origHome : "";
      if (origHome === undefined) delete process.env.POLTERTAB_HOME;
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "config.js"))];
      delete require.cache[require.resolve(UPLOADS_CONFIG)];
    } finally {
      cleanup(tmpHome);
    }
  });

  // ── Y4: addAllowlistEntry duplicate is idempotent ────────────────────────
  await test("Y4 addAllowlistEntry duplicate is idempotent", () => {
    const tmpHome = makeTmpHome();
    try {
      const origHome = process.env.POLTERTAB_HOME;
      process.env.POLTERTAB_HOME = tmpHome;
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "config.js"))];
      delete require.cache[require.resolve(UPLOADS_CONFIG)];
      const { addAllowlistEntry, getAllowlist } = require(UPLOADS_CONFIG);

      addAllowlistEntry("/some/dir");
      const added = addAllowlistEntry("/some/dir");
      assert.strictEqual(added, false, "second add should return false");
      const list = getAllowlist();
      assert.deepStrictEqual(list, ["/some/dir"], "should have exactly one entry");

      process.env.POLTERTAB_HOME = origHome !== undefined ? origHome : "";
      if (origHome === undefined) delete process.env.POLTERTAB_HOME;
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "config.js"))];
      delete require.cache[require.resolve(UPLOADS_CONFIG)];
    } finally {
      cleanup(tmpHome);
    }
  });

  // ── Y5: removeAllowlistEntry removes entry; config remains valid ─────────
  await test("Y5 removeAllowlistEntry removes entry, empty list is valid JSON", () => {
    const tmpHome = makeTmpHome();
    try {
      const origHome = process.env.POLTERTAB_HOME;
      process.env.POLTERTAB_HOME = tmpHome;
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "config.js"))];
      delete require.cache[require.resolve(UPLOADS_CONFIG)];
      const { addAllowlistEntry, removeAllowlistEntry, getAllowlist, CONFIG_PATH } = require(UPLOADS_CONFIG);

      addAllowlistEntry("/some/dir");
      const removed = removeAllowlistEntry("/some/dir");
      assert.strictEqual(removed, true, "remove should return true");
      const list = getAllowlist();
      assert.deepStrictEqual(list, [], "allowlist should be empty");

      // Config file must still parse as valid JSON
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      assert.ok(Array.isArray(raw.upload_allowed_paths), "upload_allowed_paths must be an array");

      process.env.POLTERTAB_HOME = origHome !== undefined ? origHome : "";
      if (origHome === undefined) delete process.env.POLTERTAB_HOME;
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "config.js"))];
      delete require.cache[require.resolve(UPLOADS_CONFIG)];
    } finally {
      cleanup(tmpHome);
    }
  });

  // ── Y6: logUpload appends one correct JSON line ──────────────────────────
  await test("Y6 logUpload appends one correct JSON line", () => {
    const tmpHome = makeTmpHome();
    try {
      const origHome = process.env.POLTERTAB_HOME;
      process.env.POLTERTAB_HOME = tmpHome;
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "config.js"))];
      delete require.cache[require.resolve(UPLOADS_LOG)];
      const { logUpload, LOG_PATH } = require(UPLOADS_LOG);

      logUpload({ paths: ["/some/file.txt"], method: "picker", outcome: "ok", origin: "https://example.com", session: "s1" });

      const lines = fs.readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean);
      assert.strictEqual(lines.length, 1, "should be exactly one log line");
      const entry = JSON.parse(lines[0]);
      assert.ok(entry.ts, "ts field missing");
      assert.deepStrictEqual(entry.paths, ["/some/file.txt"]);
      assert.strictEqual(entry.method, "picker");
      assert.strictEqual(entry.outcome, "ok");
      assert.strictEqual(entry.origin, "https://example.com");
      assert.strictEqual(entry.session, "s1");

      process.env.POLTERTAB_HOME = origHome !== undefined ? origHome : "";
      if (origHome === undefined) delete process.env.POLTERTAB_HOME;
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "config.js"))];
      delete require.cache[require.resolve(UPLOADS_LOG)];
    } finally {
      cleanup(tmpHome);
    }
  });

  // ── Y7: logUpload rotation drops old lines over LOG_MAX_BYTES ───────────
  await test("Y7 logUpload rotation: old lines dropped when file exceeds 1 MB", () => {
    const tmpHome = makeTmpHome();
    try {
      const origHome = process.env.POLTERTAB_HOME;
      process.env.POLTERTAB_HOME = tmpHome;
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "config.js"))];
      delete require.cache[require.resolve(UPLOADS_LOG)];
      const { logUpload, LOG_PATH, LOG_MAX_BYTES } = require(UPLOADS_LOG);

      // Write a big existing log that's just over 1 MB
      const bigLine = JSON.stringify({ ts: new Date().toISOString(), paths: ["/f"], method: "picker", outcome: "ok", origin: null, session: null, pad: "x".repeat(200) });
      const linesNeeded = Math.ceil((LOG_MAX_BYTES + 1) / (bigLine.length + 1));
      const bigContent = (bigLine + "\n").repeat(linesNeeded);
      fs.writeFileSync(LOG_PATH, bigContent, "utf8");

      // This should trigger rotation
      logUpload({ paths: ["/new/file.txt"], method: "drop", outcome: "ok", origin: null, session: null });

      const stat = fs.statSync(LOG_PATH);
      assert.ok(stat.size <= LOG_MAX_BYTES, `Log still over limit: ${stat.size} > ${LOG_MAX_BYTES}`);

      // The final entry must be our newly appended one
      const remaining = fs.readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean);
      const last = JSON.parse(remaining[remaining.length - 1]);
      assert.deepStrictEqual(last.paths, ["/new/file.txt"], "last entry should be the newly appended one");

      process.env.POLTERTAB_HOME = origHome !== undefined ? origHome : "";
      if (origHome === undefined) delete process.env.POLTERTAB_HOME;
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "config.js"))];
      delete require.cache[require.resolve(UPLOADS_LOG)];
    } finally {
      cleanup(tmpHome);
    }
  });

  // ── Y8: getRecentLog(n) returns last n entries ───────────────────────────
  await test("Y8 getRecentLog(n) returns last n entries", () => {
    const tmpHome = makeTmpHome();
    try {
      const origHome = process.env.POLTERTAB_HOME;
      process.env.POLTERTAB_HOME = tmpHome;
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "config.js"))];
      delete require.cache[require.resolve(UPLOADS_LOG)];
      const { logUpload, getRecentLog } = require(UPLOADS_LOG);

      for (let i = 0; i < 5; i++) {
        logUpload({ paths: [`/file${i}.txt`], method: "picker", outcome: "ok", origin: null, session: null });
      }
      const recent = getRecentLog(3);
      assert.strictEqual(recent.length, 3, "should return 3 entries");
      assert.deepStrictEqual(recent[recent.length - 1].paths, ["/file4.txt"], "last entry is the most recent");

      process.env.POLTERTAB_HOME = origHome !== undefined ? origHome : "";
      if (origHome === undefined) delete process.env.POLTERTAB_HOME;
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "config.js"))];
      delete require.cache[require.resolve(UPLOADS_LOG)];
    } finally {
      cleanup(tmpHome);
    }
  });

  // ── Y9: uploads_get_config returns uploads_not_paired when no ID is paired ─
  await test("Y9 uploads_get_config returns uploads_not_paired when no ID is paired", async () => {
    const port = await freePort();
    const home = makeTmpHome();
    // No config.json written — no paired IDs.
    const srv = startServer({ port, home });
    try {
      await waitFor("bridge up", () => srv.stderr.includes("WebSocket server listening"), 5000);

      const ext = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://anyid" });
      await new Promise((res) => ext.on("open", res));
      ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));
      // An unpaired extension gets no slot (no "Chrome extension connected"), but
      // uploads_get_config is still answered; just let the handshake settle.
      await sleep(400);

      let reply = null;
      ext.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.type === "uploads_not_paired" || m.type === "uploads_config") reply = m;
      });
      ext.send(JSON.stringify({ type: "uploads_get_config", _replyId: "r1" }));
      await waitFor("reply received", () => reply !== null, 3000);
      assert.strictEqual(reply.type, "uploads_not_paired", "unpaired server must return uploads_not_paired");
      assert.ok(reply.error && reply.error.includes("pair"), "error must mention 'pair'");
      ext.close();
    } finally {
      await stop(srv);
      cleanup(home);
    }
  });

  // ── Y10: uploads_get_config succeeds from paired extension ID ──────────────
  await test("Y10 uploads_get_config succeeds from paired extension ID", async () => {
    const port = await freePort();
    const home = makeTmpHome();
    // Pair "legit" as a trusted ID.
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ trusted_extension_ids: ["legit"] }));
    const srv = startServer({ port, home });
    try {
      await waitFor("bridge up", () => srv.stderr.includes("WebSocket server listening"), 5000);

      const ext = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://legit" });
      await new Promise((res) => ext.on("open", res));
      ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));
      await waitFor("ext ready", () => srv.stderr.includes("Chrome extension connected."), 3000);

      let reply = null;
      ext.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.type === "uploads_config" || m.type === "uploads_not_paired") reply = m;
      });
      ext.send(JSON.stringify({ type: "uploads_get_config", _replyId: "r2" }));
      await waitFor("uploads_config received", () => reply !== null, 3000);
      assert.strictEqual(reply.type, "uploads_config", "paired extension must receive uploads_config");
      ext.close();
    } finally {
      await stop(srv);
      cleanup(home);
    }
  });

  // ── Y11: uploads_get_config returns uploads_not_paired for untrusted ID ───
  await test("Y11 uploads_get_config returns uploads_not_paired for untrusted ID", async () => {
    const port = await freePort();
    const home = makeTmpHome();
    // Only "legit" is trusted; "attacker" is not.
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ trusted_extension_ids: ["legit"] }));
    const srv = startServer({ port, home });
    try {
      await waitFor("bridge up", () => srv.stderr.includes("WebSocket server listening"), 5000);

      const attacker = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://attacker" });
      let reply = null;
      await new Promise((res) => attacker.on("open", res));
      attacker.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.type === "uploads_not_paired" || m.type === "uploads_config" || m.type === "uploads_error") reply = m;
      });
      attacker.send(JSON.stringify({ type: "uploads_get_config", _replyId: "atk" }));
      await waitFor("attacker refused", () => reply !== null, 3000);
      assert.ok(
        reply.type === "uploads_not_paired" || reply.type === "uploads_error",
        "untrusted ID must get uploads_not_paired or uploads_error, got: " + reply.type,
      );
      assert.notStrictEqual(reply.type, "uploads_config", "untrusted ID must not receive uploads_config");
      attacker.close();
    } finally {
      await stop(srv);
      cleanup(home);
    }
  });

  // ── Y12: uploads_get_config returns uploads_not_paired for originless socket
  await test("Y12 uploads_get_config returns uploads_not_paired for originless socket", async () => {
    const port = await freePort();
    const home = makeTmpHome();
    // Pair an ID so we are past the "no pairing" gate and test origin check.
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ trusted_extension_ids: ["legit"] }));
    const srv = startServer({ port, home });
    try {
      await waitFor("bridge up", () => srv.stderr.includes("WebSocket server listening"), 5000);

      const noOrigin = new WebSocket(`ws://localhost:${port}`);
      let reply = null;
      await new Promise((res) => noOrigin.on("open", res));
      noOrigin.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.type === "uploads_not_paired" || m.type === "uploads_config" || m.type === "uploads_error") reply = m;
      });
      noOrigin.send(JSON.stringify({ type: "uploads_get_config", _replyId: "no" }));
      await waitFor("no-origin reply", () => reply !== null, 3000);
      assert.ok(
        reply.type === "uploads_not_paired" || reply.type === "uploads_error",
        "originless socket must get uploads_not_paired or uploads_error",
      );
      assert.notStrictEqual(reply.type, "uploads_config", "originless must not receive uploads_config");
      noOrigin.close();
    } finally {
      await stop(srv);
      cleanup(home);
    }
  });

  // ── Y13: poltertab uploads pair on non-TTY without --id exits 1 ───────────
  await test("Y13 poltertab uploads pair on non-TTY without --id exits 1", async () => {
    const { spawnSync } = require("child_process");
    const node = process.execPath;
    const bin = path.join(REPO, "bin", "poltertab.js");
    // Run with no TTY (pipe stdin). Without --id it must exit 1.
    const result = spawnSync(node, [bin, "uploads", "pair"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    assert.notStrictEqual(result.status, 0, "non-TTY pair without --id must exit non-zero");
    const combined = (result.stderr || Buffer.alloc(0)).toString() + (result.stdout || Buffer.alloc(0)).toString();
    assert.ok(
      combined.includes("interactive terminal") || combined.includes("--id"),
      "error must mention interactive terminal or --id flag",
    );
  });

  // ── Y14: addTrustedExtensionId preserves unknown config keys ─────────────
  await test("Y14 addTrustedExtensionId preserves unknown config keys", () => {
    const tmpHome = makeTmpHome();
    try {
      process.env.POLTERTAB_HOME = tmpHome;
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "config.js"))];
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "uploads-config.js"))];
      const { addTrustedExtensionId, getTrustedExtensionIds } = require(UPLOADS_CONFIG);

      // Write a config with unknown keys that must be preserved.
      const cfgPath = path.join(tmpHome, "config.json");
      fs.writeFileSync(cfgPath, JSON.stringify({ ws_port: 9999, some_other_key: "value" }));

      addTrustedExtensionId("abcdefghijklmnopqrstuvwxyzabcdef");

      const written = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      assert.strictEqual(written.ws_port, 9999, "ws_port must be preserved");
      assert.strictEqual(written.some_other_key, "value", "some_other_key must be preserved");
      assert.deepStrictEqual(
        written.trusted_extension_ids,
        ["abcdefghijklmnopqrstuvwxyzabcdef"],
        "trusted_extension_ids must contain the new ID",
      );

      const ids = getTrustedExtensionIds();
      assert.ok(ids.includes("abcdefghijklmnopqrstuvwxyzabcdef"), "getTrustedExtensionIds must return the new ID");

      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "config.js"))];
      delete require.cache[require.resolve(path.join(REPO, "mcp-server", "uploads-config.js"))];
    } finally {
      delete process.env.POLTERTAB_HOME;
      cleanup(tmpHome);
    }
  });

  // ── Y15: proxy_command to CHROME-EXTENSION:// (uppercase) returns self_navigation_refused
  await test("Y15 proxy_command navigate to CHROME-EXTENSION:// returns self_navigation_refused", async () => {
    const port = await freePort();
    const home = makeTmpHome();
    const srv = startServer({ port, home });
    try {
      await waitFor("bridge up", () => srv.stderr.includes("WebSocket server listening"), 5000);

      // Attach a fake extension so the Primary is connected.
      const ext = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://lcijocampajjmennelacdfehmhndfmbd" });
      await new Promise((res) => ext.on("open", res));
      ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));
      await waitFor("ext ready", () => srv.stderr.includes("Chrome extension connected."), 3000);

      // A secondary sends proxy_command navigate with uppercase scheme.
      const secondary = new WebSocket(`ws://localhost:${port}`);
      await new Promise((res) => secondary.on("open", res));
      secondary.send(JSON.stringify({ type: "secondary_mcp", nodeId: crypto.randomUUID(), version: "test" }));
      await waitFor("secondary accepted", () => srv.stderr.includes("Secondary"), 3000);

      let refusal = null;
      secondary.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.error && m.error.includes("self_navigation_refused")) refusal = m;
      });
      const id = crypto.randomUUID();
      secondary.send(JSON.stringify({
        type: "proxy_command", id,
        action: "navigate",
        params: { url: "CHROME-EXTENSION://legit/options.html" },
      }));
      await waitFor("self_navigation_refused", () => refusal !== null, 3000);
      assert.ok(refusal.error.includes("self_navigation_refused"), "must refuse uppercase chrome-extension:// target");

      secondary.close();
      ext.close();
    } finally {
      await stop(srv);
      cleanup(home);
    }
  });

  // ── Y16: proxy_command to chrome-extension:// returns self_navigation_refused
  await test("Y16 proxy_command navigate to chrome-extension:// returns self_navigation_refused", async () => {
    const port = await freePort();
    const home = makeTmpHome();
    const srv = startServer({ port, home });
    try {
      await waitFor("bridge up", () => srv.stderr.includes("WebSocket server listening"), 5000);

      const ext = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://lcijocampajjmennelacdfehmhndfmbd" });
      await new Promise((res) => ext.on("open", res));
      ext.send(JSON.stringify({ type: "extension_ready", version: "test" }));
      await waitFor("ext ready", () => srv.stderr.includes("Chrome extension connected."), 3000);

      const secondary = new WebSocket(`ws://localhost:${port}`);
      await new Promise((res) => secondary.on("open", res));
      secondary.send(JSON.stringify({ type: "secondary_mcp", nodeId: crypto.randomUUID(), version: "test" }));
      await waitFor("secondary accepted", () => srv.stderr.includes("Secondary"), 3000);

      let refusal = null;
      secondary.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.error && m.error.includes("self_navigation_refused")) refusal = m;
      });
      const id = crypto.randomUUID();
      secondary.send(JSON.stringify({
        type: "proxy_command", id,
        action: "navigate",
        params: { url: "chrome-extension://legit/options.html" },
      }));
      await waitFor("self_navigation_refused", () => refusal !== null, 3000);
      assert.ok(refusal.error.includes("self_navigation_refused"), "must refuse chrome-extension:// target");

      secondary.close();
      ext.close();
    } finally {
      await stop(srv);
      cleanup(home);
    }
  });

  // ── Y17: Badge code in background.js ────────────────────────────────────
  await test("Y17 badge code present in background.js", () => {
    const src = fs.readFileSync(BG, "utf8");
    assert.ok(
      src.includes("setBadgeText"),
      "background.js must call setBadgeText for upload badge",
    );
    assert.ok(
      src.includes("setBadgeBackgroundColor"),
      "background.js must set badge background color",
    );
  });

  // ── Y18: CLI uploads subcommand in poltertab.js ──────────────────────────
  await test("Y18 CLI uploads subcommand present in poltertab.js", () => {
    const src = fs.readFileSync(POLTERTAB_BIN, "utf8");
    assert.ok(
      src.includes('"uploads"') || src.includes("'uploads'") || src.includes("=== \"uploads\""),
      "poltertab.js must handle the 'uploads' subcommand",
    );
    assert.ok(
      src.includes("uploads.js"),
      "poltertab.js must require uploads.js",
    );
  });

  // ── Y19: Disabled-upload error text points to CLI ────────────────────────
  await test("Y19 disabled-upload error text mentions poltertab uploads", () => {
    const src = fs.readFileSync(UPLOAD_PATHS, "utf8");
    assert.ok(
      src.includes("poltertab uploads allow"),
      "upload-paths.js disabled error must mention `poltertab uploads allow`",
    );
  });

  // ── Y21: uploads_set_config refused when sender origin is not trusted ────
  await test("Y21 uploads_set_config refused when sender origin is not trusted extension", async () => {
    const port = await freePort();
    const home = makeTmpHome();
    // Pair "legit"; "attacker" is not trusted.
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ trusted_extension_ids: ["legit"] }));
    const srv = startServer({ port, home });
    try {
      await waitFor("bridge up", () => srv.stderr.includes("WebSocket server listening"), 5000);

      // Attacker connects with a chrome-extension:// origin that is NOT in trusted_extension_ids.
      const attacker = new WebSocket(`ws://localhost:${port}`, { origin: "chrome-extension://attacker" });
      await new Promise((res) => attacker.on("open", res));
      // Claim extension_ready so the socket could become extensionSocket — this must not grant access.
      attacker.send(JSON.stringify({ type: "extension_ready", version: "test" }));

      let reply = null;
      attacker.on("message", (raw) => {
        const m = JSON.parse(raw);
        if (m.type === "uploads_not_paired" || m.type === "uploads_config_result" || m.type === "uploads_error") reply = m;
      });
      attacker.send(JSON.stringify({ type: "uploads_set_config", action: "add", dir: "/tmp/evil", _replyId: "evil1" }));
      await waitFor("attacker refused", () => reply !== null, 3000);
      assert.ok(
        reply.type === "uploads_not_paired" || reply.type === "uploads_error",
        "untrusted origin must be refused, got: " + reply.type,
      );
      assert.notStrictEqual(reply.type, "uploads_config_result", "untrusted origin must not receive uploads_config_result");
      attacker.close();
    } finally {
      await stop(srv);
      cleanup(home);
    }
  });

  // ── Y20: logUpload called in index.js ────────────────────────────────────
  await test("Y20 logUpload called in index.js", () => {
    const src = fs.readFileSync(INDEX, "utf8");
    assert.ok(
      src.includes("logUpload"),
      "index.js must call logUpload on upload outcomes",
    );
    assert.ok(
      src.includes("uploads-log"),
      "index.js must require uploads-log",
    );
  });
}

module.exports = groupY;
