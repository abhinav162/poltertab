"use strict";

// Shared path-validation logic for browser_upload_file.
// Used by both index.js (the MCP server) and group-x.js (tests).
// Validates an array of file paths against the configured allowlist,
// the always-blocked list, and the home-dotfile rule.
//
// Returns { ok: true } on success, or { ok: false, errorText: string } on
// the first rejected path. Callers wrap errorText in an MCP error response.

const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file

// Paths that are never allowed regardless of the allowlist.
// /private is NOT listed here because /private/tmp and /private/var/folders
// are legitimate writable locations on macOS (they are the realpaths of /tmp
// and the system temp dir). Sensitive subdirectories ARE listed instead.
function buildAlwaysBlocked(homeDir) {
  return [
    path.join(homeDir, ".ssh"),
    path.join(homeDir, ".aws"),
    path.join(homeDir, ".gnupg"),
    path.join(homeDir, ".config"),
    "/etc",
    "/private/etc",
    "/System",
    "/private/System",
    "/Library",
    "/private/Library",
    "/proc",
  ];
}

/**
 * Expand ~ and resolve symlinks in a single allowlist entry.
 * Returns the real absolute path, or the resolved-but-not-realpathd path if
 * the directory does not exist yet (so future-created dirs still match).
 */
function expandAllowlistEntry(p) {
  const expanded = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
  try {
    return fs.realpathSync(path.resolve(expanded));
  } catch (_) {
    return path.resolve(expanded);
  }
}

/**
 * Validate file paths for upload.
 *
 * @param {string[]} filePaths   - Raw paths as supplied by the caller.
 * @param {object}   config
 * @param {string[]|null} config.allowedPaths  - Raw allowlist entries from config.json;
 *   null or empty array means uploads are disabled.
 * @param {boolean}  [config.checkSize]   - When true, also enforce MAX_BYTES.
 * @param {string}   [config.homeDir]     - Override os.homedir() (tests only).
 * @returns {{ ok: true } | { ok: false, errorText: string }}
 */
function validateUploadPaths(filePaths, config) {
  const {
    allowedPaths = null,
    checkSize = false,
    homeDir = os.homedir(),
  } = config;

  if (!allowedPaths || allowedPaths.length === 0) {
    return {
      ok: false,
      errorText:
        "File uploads are disabled. To enable them, add an upload_allowed_paths array " +
        "to ~/.poltertab/config.json listing the directories Claude may read files from.\n\n" +
        "Example:\n{\n  \"upload_allowed_paths\": [\"/Users/you/Documents\", \"/Users/you/Downloads\"]\n}",
    };
  }

  const expandedAllowed = allowedPaths.map(expandAllowlistEntry);
  const alwaysBlocked = buildAlwaysBlocked(homeDir);

  for (const p of filePaths) {
    // Resolve symlinks so a symlink pointing outside the allowlist cannot
    // bypass the check (e.g. ~/Downloads/key.pem -> ~/.ssh/id_ed25519).
    let resolved;
    try {
      resolved = fs.realpathSync(path.resolve(p));
    } catch (_) {
      return { ok: false, errorText: `File not found: "${p}"` };
    }

    // Always-blocked check
    for (const blocked of alwaysBlocked) {
      if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
        return {
          ok: false,
          errorText: `Access denied: "${p}" is in a protected system directory.`,
        };
      }
    }

    // Deny home dotfiles (direct children of homeDir starting with .)
    const rel = path.relative(homeDir, resolved);
    if (!rel.startsWith("..") && rel.startsWith(".") && !rel.includes(path.sep)) {
      return {
        ok: false,
        errorText: `Access denied: "${p}" is a home directory dotfile.`,
      };
    }

    // Allowlist check (both sides are realpathSync'd)
    const allowed = expandedAllowed.some(
      (a) => resolved === a || resolved.startsWith(a + path.sep),
    );
    if (!allowed) {
      return {
        ok: false,
        errorText: `Access denied: "${p}" is not within any configured upload_allowed_paths directory. Check ~/.poltertab/config.json.`,
      };
    }

    // Optional size check (drop method only)
    if (checkSize) {
      const stat = fs.statSync(resolved);
      if (stat.size > MAX_BYTES) {
        return {
          ok: false,
          errorText: `File too large: "${path.basename(p)}" is ${(stat.size / 1024 / 1024).toFixed(1)} MB. The drop method supports files up to 10 MB.`,
        };
      }
    }
  }

  return { ok: true };
}

module.exports = { validateUploadPaths, MAX_BYTES };
