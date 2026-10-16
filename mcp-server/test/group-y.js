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
//   Y9  WS uploads_get_config accepted only from extension-origin (source check)
//   Y10 WS uploads_set_config refused from originless (source check)
//   Y11 Self-navigation guard present in bridge.js
//   Y12 Self-navigation guard present in background.js
//   Y13 Badge code present in background.js
//   Y14 CLI uploads subcommand present in poltertab.js
//   Y15 Disabled-upload error text points to CLI
//   Y16 logUpload called in index.js

const { REPO, assert, fs, path, test } = require("./harness.js");
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

  // ── Y9: uploads_get_config accepted from extension-origin (source check) ─
  await test("Y9 bridge.js accepts uploads_get_config only from extension-origin (source-code check)", () => {
    const src = fs.readFileSync(BRIDGE, "utf8");
    assert.ok(
      src.includes("chrome-extension://"),
      "bridge.js must gate uploads messages on chrome-extension:// origin",
    );
    assert.ok(
      src.includes("uploads_get_config"),
      "bridge.js must handle uploads_get_config",
    );
  });

  // ── Y10: uploads_set_config refused from originless (source check) ───────
  await test("Y10 bridge.js refuses uploads_set_config from originless connections (source-code check)", () => {
    const src = fs.readFileSync(BRIDGE, "utf8");
    assert.ok(
      src.includes("uploads_forbidden"),
      "bridge.js must send uploads_forbidden error for non-extension-origin",
    );
    assert.ok(
      src.includes("uploads_set_config"),
      "bridge.js must check uploads_set_config",
    );
  });

  // ── Y11: Self-navigation guard in bridge.js ──────────────────────────────
  await test("Y11 self-navigation guard present in bridge.js", () => {
    const src = fs.readFileSync(BRIDGE, "utf8");
    assert.ok(
      src.includes("self_navigation_refused"),
      "bridge.js must contain self_navigation_refused guard",
    );
    assert.ok(
      src.includes("chrome-extension://"),
      "bridge.js must check for chrome-extension:// in params",
    );
  });

  // ── Y12: Self-navigation guard in background.js ──────────────────────────
  await test("Y12 self-navigation guard present in background.js", () => {
    const src = fs.readFileSync(BG, "utf8");
    assert.ok(
      src.includes("self_navigation_refused"),
      "background.js must contain self_navigation_refused guard",
    );
    assert.ok(
      src.includes("SELF_NAV_ACTIONS"),
      "background.js must define SELF_NAV_ACTIONS set",
    );
  });

  // ── Y13: Badge code in background.js ────────────────────────────────────
  await test("Y13 badge code present in background.js", () => {
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

  // ── Y14: CLI uploads subcommand in poltertab.js ──────────────────────────
  await test("Y14 CLI uploads subcommand present in poltertab.js", () => {
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

  // ── Y15: Disabled-upload error text points to CLI ────────────────────────
  await test("Y15 disabled-upload error text mentions poltertab uploads", () => {
    const src = fs.readFileSync(UPLOAD_PATHS, "utf8");
    assert.ok(
      src.includes("poltertab uploads allow"),
      "upload-paths.js disabled error must mention `poltertab uploads allow`",
    );
  });

  // ── Y16: logUpload called in index.js ────────────────────────────────────
  await test("Y16 logUpload called in index.js", () => {
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
