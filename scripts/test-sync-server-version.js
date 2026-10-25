// Test the server.json version sync used by release-please.yml and publish.yml.
// Run: node scripts/test-sync-server-version.js
// Exercises the same module the workflows call, so logic drift is caught here.

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { syncServerVersion } = require("./sync-server-version");

let pass = 0,
  fail = 0;

function run(label, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-server-"));
  try {
    fn(root);
    console.log(`PASS  ${label}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${label}\n        ${err.message.split("\n")[0]}`);
    fail++;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const writePkg = (root, version) =>
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "poltertab", version }));
const writeServer = (root, obj) =>
  fs.writeFileSync(path.join(root, "server.json"), JSON.stringify(obj, null, 2) + "\n");
const readServer = (root) =>
  JSON.parse(fs.readFileSync(path.join(root, "server.json"), "utf8"));

run("stable version syncs top-level and packages[].version", (root) => {
  writePkg(root, "1.12.0");
  writeServer(root, { version: "0.0.0", packages: [{ identifier: "poltertab", version: "0.0.0", transport: { type: "stdio" } }] });
  const v = syncServerVersion(root);
  const s = readServer(root);
  assert.strictEqual(v, "1.12.0");
  assert.strictEqual(s.version, "1.12.0", "top-level version");
  assert.strictEqual(s.packages[0].version, "1.12.0", "packages[0].version");
});

run("prerelease tail is copied verbatim (no transform)", (root) => {
  writePkg(root, "1.12.0-beta.3");
  writeServer(root, { version: "1.0.0", packages: [{ identifier: "poltertab", version: "1.0.0", transport: { type: "stdio" } }] });
  syncServerVersion(root);
  const s = readServer(root);
  assert.strictEqual(s.version, "1.12.0-beta.3");
  assert.strictEqual(s.packages[0].version, "1.12.0-beta.3");
});

run("every package entry is updated", (root) => {
  writePkg(root, "2.0.0");
  writeServer(root, { version: "0.0.0", packages: [
    { identifier: "poltertab", version: "0.0.0", transport: { type: "stdio" } },
    { identifier: "poltertab", version: "0.0.0", registryType: "npm", transport: { type: "stdio" } },
  ] });
  syncServerVersion(root);
  const s = readServer(root);
  assert.ok(s.packages.every((p) => p.version === "2.0.0"), "all packages synced");
});

run("no packages array is tolerated", (root) => {
  writePkg(root, "1.2.3");
  writeServer(root, { version: "0.0.0" });
  syncServerVersion(root);
  assert.strictEqual(readServer(root).version, "1.2.3");
});

run("trailing newline is preserved", (root) => {
  writePkg(root, "1.2.3");
  writeServer(root, { version: "0.0.0", packages: [] });
  syncServerVersion(root);
  assert.ok(fs.readFileSync(path.join(root, "server.json"), "utf8").endsWith("}\n"), "trailing newline");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
