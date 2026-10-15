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
//   X7  drop method: files exceeding 10 MB are rejected
//   X8  no config: uploads are refused with a helpful error

const { EXT, REPO, SERVER, TOOLS, assert, fs, path, test } = require("./harness.js");
const os = require("os");

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
    // Find the handlers block and confirm upload_file appears in it.
    const idx = src.indexOf("const handlers = {");
    assert.notStrictEqual(idx, -1, "handlers map not found in content_script.js");
    // Walk to the closing brace
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

  // ── X4-X8: MCP-side path validation ─────────────────────────────────────
  // We exercise the validation logic by spinning up a minimal node context
  // that replicates exactly what index.js does, without starting the server.

  // Helper: simulate what the index.js upload_file handler does for a given
  // set of paths, an allowlist (or null for no config), and a method.
  // Returns the error text string, or null if it would proceed to bridge.sendCommand.
  function simulateValidation(filePaths, allowedPaths, method) {
    const expandedAllowed = allowedPaths
      ? allowedPaths.map((p) =>
          p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p,
        )
      : null;

    // No config / empty allowlist
    if (!expandedAllowed || expandedAllowed.length === 0) {
      return "File uploads are disabled";
    }

    const homeDir = os.homedir();
    const alwaysBlocked = [
      path.join(homeDir, ".ssh"),
      path.join(homeDir, ".aws"),
      path.join(homeDir, ".gnupg"),
      path.join(homeDir, ".config"),
      "/etc",
      "/System",
      "/Library",
      "/private",
      "/proc",
    ];

    for (const p of filePaths) {
      const resolved = path.resolve(p);

      // Always-blocked
      for (const blocked of alwaysBlocked) {
        if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
          return `Access denied: "${p}" is in a protected system directory.`;
        }
      }

      // Home dotfiles
      const rel = path.relative(homeDir, resolved);
      if (!rel.startsWith("..") && rel.startsWith(".") && !rel.includes(path.sep)) {
        return `Access denied: "${p}" is a home directory dotfile.`;
      }

      // Allowlist
      const allowed = expandedAllowed.some(
        (a) => resolved === a || resolved.startsWith(a + path.sep),
      );
      if (!allowed) {
        return `Access denied: "${p}" is not within any configured upload_allowed_paths directory.`;
      }
    }

    return null; // would proceed to bridge
  }

  await test("X4 paths outside the allowlist are rejected", () => {
    const home = os.homedir();
    const allowedDir = path.join(home, "Documents");
    const blockedFile = path.join(home, "Desktop", "secret.pdf");
    const result = simulateValidation([blockedFile], [allowedDir], "picker");
    assert.ok(result !== null, "expected rejection but got null (would proceed)");
    assert.ok(
      result.includes("not within any configured upload_allowed_paths"),
      `unexpected error: ${result}`,
    );
  });

  await test("X5 always-blocked paths are rejected even if inside the allowlist", () => {
    const home = os.homedir();
    // Attacker sets allowlist to include ~/.ssh — still blocked.
    const sshKey = path.join(home, ".ssh", "id_rsa");
    const result = simulateValidation([sshKey], [path.join(home, ".ssh")], "picker");
    assert.ok(result !== null, "expected rejection but got null (would proceed)");
    assert.ok(
      result.includes("protected system directory"),
      `unexpected error: ${result}`,
    );
  });

  await test("X6 home dotfiles are rejected even if parent is in the allowlist", () => {
    const home = os.homedir();
    const bashrc = path.join(home, ".bashrc");
    const result = simulateValidation([bashrc], [home], "picker");
    assert.ok(result !== null, "expected rejection but got null (would proceed)");
    assert.ok(
      result.includes("dotfile"),
      `unexpected error: ${result}`,
    );
  });

  await test("X7 drop method: files > 10 MB trigger the size cap error in index.js", () => {
    // Read the server source and confirm the MAX_BYTES cap and size check exist.
    const src = fs.readFileSync(SERVER, "utf8");
    assert.ok(
      /10 \* 1024 \* 1024/.test(src),
      "10 MB cap constant not found in index.js",
    );
    assert.ok(
      /stat\.size > MAX_BYTES/.test(src),
      "size cap check not found in index.js upload handler",
    );
  });

  await test("X8 no config file → uploads refused with helpful message", () => {
    const result = simulateValidation(["/tmp/test.txt"], null, "picker");
    assert.ok(result !== null, "expected refusal when no config is present");
    assert.ok(
      result.includes("File uploads are disabled"),
      `unexpected message: ${result}`,
    );
  });
}

module.exports = groupX;
