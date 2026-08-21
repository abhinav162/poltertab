#!/usr/bin/env node
// Validates a release and resolves which npm dist-tag it should publish under.
//
//   node scripts/release-meta.js <git-tag> [github-prerelease-flag]
//
// Prints `dist_tag=<tag>` on stdout for $GITHUB_OUTPUT; everything human goes
// to stderr. Exits non-zero with a specific reason rather than letting a
// mismatched publish reach the registry, where it cannot be taken back —
// npm unpublish is heavily restricted and a wrong `latest` is what every
// `npm install poltertab` gets until a newer version replaces it.
//
// The version string is the single source of truth for the channel:
//
//   1.2.3          -> latest
//   1.2.3-beta.4   -> beta
//   1.2.3-alpha.1  -> alpha
//   1.2.3-rc.2     -> rc

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const [rawTag, prereleaseFlag] = process.argv.slice(2);

const fail = (msg) => {
  console.error(`\n  release-meta: ${msg}\n`);
  process.exit(1);
};

if (!rawTag) fail("no git tag given");

// Accept both `v1.2.3` and `1.2.3`; the repo tags with the v.
const tagVersion = rawTag.replace(/^v/, "");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const m = SEMVER.exec(tagVersion);
if (!m) fail(`tag "${rawTag}" is not a semver version`);
const prerelease = m[4] || "";

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
if (pkg.version !== tagVersion) {
  fail(
    `tag says ${tagVersion} but package.json says ${pkg.version}.\n` +
      `  Bump with \`npm version ${tagVersion}\` so both move together.`,
  );
}

// The manifest carries the numeric base only — Chrome rejects prerelease
// identifiers — with the full string in version_name. See sync-manifest-version.
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "chrome-extension", "manifest.json"), "utf8"),
);
const base = tagVersion.split("-")[0];
if (manifest.version !== base) {
  fail(
    `manifest.json says ${manifest.version}, expected ${base}.\n` +
      `  Run: node scripts/sync-manifest-version.js`,
  );
}
if (prerelease && manifest.version_name !== tagVersion) {
  fail(
    `manifest.json version_name is ${manifest.version_name || "unset"}, expected ${tagVersion}.\n` +
      `  Run: node scripts/sync-manifest-version.js`,
  );
}

// First identifier decides the channel: beta.4 -> beta. An unrecognised one
// gets its own tag rather than silently becoming latest.
const KNOWN = ["alpha", "beta", "rc", "next", "canary"];
let distTag = "latest";
if (prerelease) {
  const first = prerelease.split(".")[0].toLowerCase();
  distTag = KNOWN.includes(first) ? first : "prerelease";
}

// Guard the one mistake that is expensive to undo: a release flagged
// prerelease on GitHub but versioned as stable would publish to `latest` and
// become the default install for everyone.
if (distTag === "latest" && String(prereleaseFlag) === "true") {
  fail(
    `the GitHub release is marked prerelease but ${tagVersion} has no prerelease identifier,\n` +
      `  so this would publish to the "latest" tag and become the default install.\n` +
      `  Either retag as ${tagVersion}-beta.1, or untick "This is a pre-release".`,
  );
}

console.error(`  version   ${tagVersion}`);
console.error(`  manifest  ${manifest.version}${manifest.version_name ? ` (${manifest.version_name})` : ""}`);
console.error(`  dist-tag  ${distTag}`);
console.log(`dist_tag=${distTag}`);
console.log(`version=${tagVersion}`);
