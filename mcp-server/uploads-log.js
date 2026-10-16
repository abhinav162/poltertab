"use strict";

// Append + rotate upload activity log at ~/.poltertab/uploads.log.jsonl.
// Each entry: { ts, paths, method, outcome, origin, session }.
// Rotation: drop oldest lines until the file is ≤ LOG_MAX_BYTES.

const fs = require("fs");
const path = require("path");
const { POLTERTAB_HOME } = require("./config.js");

const LOG_PATH = path.join(POLTERTAB_HOME, "uploads.log.jsonl");
const LOG_MAX_BYTES = 1 * 1024 * 1024; // 1 MB

function logUpload({ paths, method, outcome, origin, session }) {
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      paths,
      method,
      outcome,
      origin: origin || null,
      session: session || null,
    }) + "\n";

  fs.mkdirSync(POLTERTAB_HOME, { recursive: true });
  fs.appendFileSync(LOG_PATH, line, "utf8");

  // Rotate if file exceeds limit
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > LOG_MAX_BYTES) {
      let content = fs.readFileSync(LOG_PATH, "utf8");
      const lines = content.split("\n").filter(Boolean);
      while (lines.length > 1 && Buffer.byteLength(lines.join("\n") + "\n") > LOG_MAX_BYTES) {
        lines.shift();
      }
      fs.writeFileSync(LOG_PATH, lines.join("\n") + "\n", "utf8");
    }
  } catch (_) {
    // Rotation failure is non-fatal
  }
}

function getRecentLog(n = 20) {
  try {
    const content = fs.readFileSync(LOG_PATH, "utf8");
    const lines = content.split("\n").filter(Boolean);
    return lines
      .slice(-n)
      .map((l) => {
        try { return JSON.parse(l); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

module.exports = { logUpload, getRecentLog, LOG_PATH, LOG_MAX_BYTES };
