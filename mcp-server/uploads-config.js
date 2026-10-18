"use strict";

// Atomic read-modify-write for the upload_allowed_paths key in config.json.
// Preserves all other keys in config.json. Atomic write = temp file + rename.
//
// Used by bridge.js (WS messages) and bin/uploads.js (CLI).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { POLTERTAB_HOME } = require("./config.js");

const CONFIG_PATH = path.join(POLTERTAB_HOME, "config.json");

function _readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error("config.json is not valid JSON — fix it before editing the allowlist");
  }
}

function _writeConfig(data) {
  fs.mkdirSync(POLTERTAB_HOME, { recursive: true });
  const tmp = CONFIG_PATH + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
}

function getAllowlist() {
  const cfg = _readConfig();
  const v = cfg.upload_allowed_paths;
  return Array.isArray(v) ? v : [];
}

// Adds dir to the allowlist if not already present. Returns true if added,
// false if already present. Throws if validation fails (call
// validateAllowlistEntry first to surface user-facing messages).
function addAllowlistEntry(dir) {
  const cfg = _readConfig();
  const list = Array.isArray(cfg.upload_allowed_paths) ? cfg.upload_allowed_paths : [];
  if (list.includes(dir)) return false;
  _writeConfig({ ...cfg, upload_allowed_paths: [...list, dir] });
  return true;
}

// Removes dir from the allowlist. Returns true if removed, false if absent.
function removeAllowlistEntry(dir) {
  const cfg = _readConfig();
  const list = Array.isArray(cfg.upload_allowed_paths) ? cfg.upload_allowed_paths : [];
  const next = list.filter((e) => e !== dir);
  if (next.length === list.length) return false;
  _writeConfig({ ...cfg, upload_allowed_paths: next });
  return true;
}

// Adds id to trusted_extension_ids if not already present. Returns true if added.
function addTrustedExtensionId(id) {
  const cfg = _readConfig();
  const list = Array.isArray(cfg.trusted_extension_ids) ? cfg.trusted_extension_ids : [];
  if (list.includes(id)) return false;
  _writeConfig({ ...cfg, trusted_extension_ids: [...list, id] });
  return true;
}

function getTrustedExtensionIds() {
  const cfg = _readConfig();
  const v = cfg.trusted_extension_ids;
  return Array.isArray(v) ? v : [];
}

// Removes id from trusted_extension_ids. Returns true if removed, false if absent.
function removeTrustedExtensionId(id) {
  const cfg = _readConfig();
  const list = Array.isArray(cfg.trusted_extension_ids) ? cfg.trusted_extension_ids : [];
  const next = list.filter((e) => e !== id);
  if (next.length === list.length) return false;
  _writeConfig({ ...cfg, trusted_extension_ids: next });
  return true;
}

module.exports = {
  getAllowlist,
  addAllowlistEntry,
  removeAllowlistEntry,
  addTrustedExtensionId,
  getTrustedExtensionIds,
  removeTrustedExtensionId,
  CONFIG_PATH,
};
