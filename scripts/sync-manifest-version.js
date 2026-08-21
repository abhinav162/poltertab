#!/usr/bin/env node
// Keeps chrome-extension/manifest.json in step with package.json.
//
// Wired to npm's `version` lifecycle, so `npm version 1.1.0-beta.1` bumps the
// package, syncs the manifest, and stages it — all inside the commit npm makes.
//
// The two files cannot just hold the same string. A Chrome manifest version is
// 1-4 dot-separated integers, each 0-65535, and nothing else: "1.1.0-beta.1" is
// rejected at load time. The prerelease part goes in version_name, which exists
// for exactly this and is what Chrome shows in chrome://extensions.
//
// Edits are textual rather than parse-and-restringify. JSON.stringify would
// reformat the whole file — it disagrees with prettier on short arrays — turning
// every version bump into a hundred-line diff. Touch the two lines that matter
// and leave the rest byte-identical.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MANIFEST = path.join(ROOT, "chrome-extension", "manifest.json");

const { version } = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
);

const die = (msg) => {
  console.error(`[sync-manifest] ${msg}`);
  process.exit(1);
};

// "1.2.3-beta.1" -> base "1.2.3"
const base = version.split("-")[0];
if (!/^\d+(\.\d+){0,3}$/.test(base)) {
  die(`cannot derive a Chrome version from "${version}"`);
}
if (base.split(".").some((p) => Number(p) > 65535)) {
  die(`"${base}" has a part above Chrome's 65535 limit`);
}

const before = fs.readFileSync(MANIFEST, "utf8");
let after = before;

// "version" is a common key; anchor on the one at the top level of the object,
// which is the only one written at two-space indentation.
const VERSION_LINE = /^(  "version":\s*)"[^"]*"/m;
if (!VERSION_LINE.test(after)) die("no top-level version field found");
after = after.replace(VERSION_LINE, `$1"${base}"`);

const NAME_LINE = /^  "version_name":\s*"[^"]*",?\n/m;
if (base === version) {
  // Stable release: drop any stale prerelease label, or chrome://extensions
  // keeps showing "1.1.0-beta.1" for a shipped 1.1.0.
  after = after.replace(NAME_LINE, "");
} else if (NAME_LINE.test(after)) {
  after = after.replace(NAME_LINE, `  "version_name": "${version}",\n`);
} else {
  after = after.replace(
    VERSION_LINE,
    `$1"${base}",\n  "version_name": "${version}"`,
  );
}

// A regex edit on JSON earns a parse check before it touches disk.
let parsed;
try {
  parsed = JSON.parse(after);
} catch (err) {
  die(`edit produced invalid JSON (${err.message}) — manifest left alone`);
}
if (parsed.version !== base) die("version did not take — manifest left alone");
if (base !== version && parsed.version_name !== version) {
  die("version_name did not take — manifest left alone");
}
if (base === version && parsed.version_name !== undefined) {
  die("stale version_name survived — manifest left alone");
}

fs.writeFileSync(MANIFEST, after);
console.error(
  `[sync-manifest] manifest.json -> ${base}` +
    (base === version ? "" : ` (version_name ${version})`),
);
