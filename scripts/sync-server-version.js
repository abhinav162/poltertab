#!/usr/bin/env node
// Keeps server.json (the MCP Registry entry) in step with package.json.
//
// The MCP Registry verifies that a published server's metadata matches the npm
// package it points at, so server.json's own version AND its packages[].version
// must equal package.json's version at release time. release-please edits
// package.json directly (no npm lifecycle hooks), so — exactly like
// sync-manifest-version.js — the release workflow runs this script and pushes
// the result back onto the release PR, and publish.yml re-runs it before
// publishing so the tagged tree is always consistent.
//
// Unlike the Chrome manifest, server.json takes the full semver string verbatim
// (prerelease tails included), so there is no transform — just copy the version
// into the two places that must agree. Edits go through JSON.parse/stringify
// because server.json is machine-owned (2-space, one object) and never
// hand-formatted, so a re-stringify keeps the diff to the version lines.
//
// Logic lives in syncServerVersion() so scripts/test-sync-server-version.js can
// exercise it against a fixture tree without touching the repo's own files.

const fs = require("fs");
const path = require("path");

// Writes package.json's version into server.json (.version and every
// packages[].version) under `root`. Returns the version it wrote.
function syncServerVersion(root) {
  const { version } = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  if (!version) throw new Error("package.json has no version");

  const serverPath = path.join(root, "server.json");
  const server = JSON.parse(fs.readFileSync(serverPath, "utf8"));
  server.version = version;
  for (const pkg of server.packages || []) pkg.version = version;

  fs.writeFileSync(serverPath, JSON.stringify(server, null, 2) + "\n");
  return version;
}

module.exports = { syncServerVersion };

if (require.main === module) {
  try {
    const version = syncServerVersion(path.join(__dirname, ".."));
    console.log(`[sync-server] server.json version -> ${version}`);
  } catch (err) {
    console.error(`[sync-server] ${err.message}`);
    process.exit(1);
  }
}
