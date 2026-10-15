// X. File upload feature — unit-testable invariants
//
// Integration cases (1-6 from the design, and case 9) require a live Chrome
// browser and are flagged for Dwight's live lab run. This group covers:
//
//   X1  browser_upload_file is registered in BROWSER_TOOLS
//   X2  upload_file appears in the extension ROUTES table
//   X3  upload_file appears in the content-script handlers map
//   X4  path validation: paths outside allowlist are rejected
//   X5  path validation: always-blocked paths are rejected regardless of allowlist
//   X6  path validation: home dotfiles are rejected
//   X7  drop method: files exceeding 10 MB are rejected (real sparse file)
//   X8  no config: uploads are refused with a helpful error
//   X9  positive case: an allowed file in an allowed dir passes validation
//   X10 symlink pointing outside the allowlist is rejected (symlink regression)

const { EXT, REPO, SERVER, TOOLS, assert, fs, path, test } = require("./harness.js");
const os = require("os");
const { validateUploadPaths } = require("../upload-paths.js");

async function groupX() {
  console.log("\nX. file upload feature");

  // ── X1: tool schema registered ──────────────────────────────────────────
  await test("X1 browser_upload_file is in BROWSER_TOOLS", () => {
    const src = fs.readFileSync(TOOLS, "utf8");
    assert.ok(
      src.includes('name: "browser_upload_file"'),
      "browser_upload_file schema missing from tools.js",
    );
  });

  // ── X2: extension route present ─────────────────────────────────────────
  await test("X2 upload_file is in ROUTES in background.js", () => {
    const src = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
    assert.ok(
      /upload_file\s*:/.test(src),
      "upload_file route missing from background.js ROUTES",
    );
  });

  // ── X3: content-script handler present ──────────────────────────────────
  await test("X3 upload_file is in the content-script handlers map", () => {
    const src = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");
    const idx = src.indexOf("const handlers = {");
    assert.notStrictEqual(idx, -1, "handlers map not found in content_script.js");
    let depth = 0, i = idx + "const handlers = {".length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    const body = src.slice(idx, i + 1);
    assert.ok(
      /\bupload_file\b/.test(body),
      "upload_file missing from the content-script handlers map",
    );
  });

  // ── X4-X9: path validation via the real shared module ────────────────────
  // Each test creates real files in an isolated mkdtemp directory so
  // validateUploadPaths can realpathSync them. Never touches the real home dir.

  // Shared fake-home base for all tests
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "poltertab-test-home-"));
  // On macOS, mkdtemp returns /var/folders/… which realpaths to /private/var/folders/…
  // The module allows /private/var/folders (not in the always-blocked list), so it works.
  const realFakeHome = (() => { try { return fs.realpathSync(fakeHome); } catch(_) { return fakeHome; } })();

  // An isolated allowed directory (under fakeHome so realpaths agree)
  const allowedDir = path.join(fakeHome, "allowed");
  fs.mkdirSync(allowedDir, { recursive: true });

  // ── X9 (positive case first so a function that rejects everything can't pass) ─
  await test("X9 an allowed file in an allowed dir passes validation", () => {
    const file = path.join(allowedDir, "ok.txt");
    fs.writeFileSync(file, "content");
    const result = validateUploadPaths([file], {
      allowedPaths: [allowedDir],
      homeDir: realFakeHome,
    });
    assert.strictEqual(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  });

  // ── X4: path outside allowlist rejected ─────────────────────────────────
  await test("X4 paths outside the allowlist are rejected", () => {
    const outsideDir = path.join(fakeHome, "outside");
    fs.mkdirSync(outsideDir, { recursive: true });
    const file = path.join(outsideDir, "secret.pdf");
    fs.writeFileSync(file, "x");
    const result = validateUploadPaths([file], {
      allowedPaths: [allowedDir],
      homeDir: realFakeHome,
    });
    assert.strictEqual(result.ok, false, "expected rejection but got ok:true");
    assert.ok(
      result.errorText.includes("not within any configured upload_allowed_paths"),
      `unexpected errorText: ${result.errorText}`,
    );
  });

  // ── X5: always-blocked paths rejected even if allowlisted ───────────────
  await test("X5 always-blocked paths are rejected even if inside the allowlist", () => {
    // Create a fake .ssh dir and file under fakeHome
    const fakeSsh = path.join(fakeHome, ".ssh");
    fs.mkdirSync(fakeSsh, { recursive: true });
    const keyFile = path.join(fakeSsh, "id_rsa");
    fs.writeFileSync(keyFile, "fake key");
    // Attacker tries to allow ~/.ssh — still blocked
    const result = validateUploadPaths([keyFile], {
      allowedPaths: [fakeSsh],
      homeDir: realFakeHome,
    });
    assert.strictEqual(result.ok, false, "expected rejection but got ok:true");
    assert.ok(
      result.errorText.includes("protected system directory"),
      `unexpected errorText: ${result.errorText}`,
    );
  });

  // ── X6: home dotfiles rejected even if parent is allowlisted ────────────
  await test("X6 home dotfiles are rejected even if parent is in the allowlist", () => {
    // Create a fake .bashrc directly under fakeHome
    const fakeDotfile = path.join(fakeHome, ".bashrc");
    fs.writeFileSync(fakeDotfile, "# fake bashrc");
    // Allow fakeHome itself — the dotfile inside is still blocked
    const result = validateUploadPaths([fakeDotfile], {
      allowedPaths: [fakeHome],
      homeDir: realFakeHome,
    });
    assert.strictEqual(result.ok, false, "expected rejection but got ok:true");
    assert.ok(
      result.errorText.includes("dotfile"),
      `unexpected errorText: ${result.errorText}`,
    );
  });

  // ── X7: size cap via real sparse file ───────────────────────────────────
  await test("X7 drop method: files > 10 MB trigger the size cap error", () => {
    const bigFile = path.join(allowedDir, "big.bin");
    // Create an 11 MB sparse file using truncate (no actual disk space needed)
    fs.writeFileSync(bigFile, "");
    fs.truncateSync(bigFile, 11 * 1024 * 1024);

    // With checkSize:true → rejected
    const rejected = validateUploadPaths([bigFile], {
      allowedPaths: [allowedDir],
      homeDir: realFakeHome,
      checkSize: true,
    });
    assert.strictEqual(rejected.ok, false, "expected rejection for 11 MB file with checkSize:true");
    assert.ok(
      rejected.errorText.includes("File too large"),
      `unexpected errorText: ${rejected.errorText}`,
    );

    // With checkSize:false (picker method) → passes
    const passed = validateUploadPaths([bigFile], {
      allowedPaths: [allowedDir],
      homeDir: realFakeHome,
      checkSize: false,
    });
    assert.strictEqual(passed.ok, true, `expected ok:true with checkSize:false, got: ${JSON.stringify(passed)}`);
  });

  // ── X10: symlink regression — symlink into allowedDir pointing outside is rejected ─
  await test("X10 symlink from allowedDir pointing outside allowlist is rejected", () => {
    const outsideSym = path.join(fakeHome, "outside-sym");
    fs.mkdirSync(outsideSym, { recursive: true });
    const outsideFile = path.join(outsideSym, "secret.pdf");
    fs.writeFileSync(outsideFile, "x");
    const linkPath = path.join(allowedDir, "link.pdf");
    // Symlink inside allowedDir → file outside it. realpathSync resolves through
    // the symlink so the allowlist check sees the real path and rejects it.
    try { fs.unlinkSync(linkPath); } catch (_) {}
    fs.symlinkSync(outsideFile, linkPath);
    const result = validateUploadPaths([linkPath], {
      allowedPaths: [allowedDir],
      homeDir: realFakeHome,
    });
    assert.strictEqual(result.ok, false, "expected rejection for symlink pointing outside allowlist");
    assert.ok(
      result.errorText.includes("not within any configured upload_allowed_paths"),
      `unexpected errorText: ${result.errorText}`,
    );
  });

  // ── X8: no config → uploads disabled ────────────────────────────────────
  await test("X8 no config file → uploads refused with helpful message", () => {
    const result = validateUploadPaths([path.join(allowedDir, "ok.txt")], {
      allowedPaths: null,
      homeDir: realFakeHome,
    });
    assert.strictEqual(result.ok, false, "expected refusal when no config is present");
    assert.ok(
      result.errorText.includes("File uploads are disabled"),
      `unexpected errorText: ${result.errorText}`,
    );
    // Also empty array
    const result2 = validateUploadPaths([path.join(allowedDir, "ok.txt")], {
      allowedPaths: [],
      homeDir: realFakeHome,
    });
    assert.strictEqual(result2.ok, false, "expected refusal for empty allowedPaths array");
    assert.ok(
      result2.errorText.includes("File uploads are disabled"),
      `unexpected errorText: ${result2.errorText}`,
    );
  });
}

module.exports = groupX;
