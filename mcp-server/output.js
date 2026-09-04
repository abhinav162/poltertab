// Writing a payload to disk instead of into the context window, and the CSV /
// JSONL encoders that make the file the deliverable rather than something the
// agent has to re-type.

const fs = require("fs");
const path = require("path");
const { DOWNLOADS_DIR } = require("./config.js");

// --- Output handling ---
//
// The raw payload must never be the default path into the context window. Two
// costs dominated a 100-record scrape and neither was the data: envelopes
// several lines of JSON deep to carry one short string, and the agent then
// re-typing every record by hand into a file. Writing straight to disk removes
// both.

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = Array.isArray(v)
      ? v.join(" | ")
      : typeof v === "object"
        ? JSON.stringify(v) // beats a column of "[object Object]"
        : String(v);
    // Quote only when it would otherwise break the row, and double any
    // embedded quote — the two mistakes that produce a file which imports
    // silently and wrongly.
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => cell(r[c])).join(",")),
  ].join("\n");
}

const isBlank = (v) =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);

// `rows` is passed separately when the payload has a records array: .jsonl and
// .csv are formats for records, not for envelopes.
function writeOutput(name, payload, rows) {
  const requested = String(name);
  const safeName = path.basename(requested);
  const parts = safeName.split(".");
  const ext = parts.length > 1 ? `.${parts.pop()}` : "";
  const base = parts.join(".");
  const finalName = `${base}_${Date.now()}${ext}`;

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const safePath = path.join(DOWNLOADS_DIR, finalName);

  let body;
  if (rows && ext === ".jsonl") {
    body = rows.map((r) => JSON.stringify(r)).join("\n");
  } else if (rows && ext === ".csv") {
    body = toCsv(rows);
  } else {
    body = JSON.stringify(payload, null, 2);
  }

  fs.writeFileSync(safePath, body);
  const out = { file: safePath, bytes: Buffer.byteLength(body) };

  // Output stays inside DOWNLOADS_DIR: this path comes from a model, and a tool
  // that writes to an arbitrary absolute path is a different capability than
  // one that saves a scrape. But relocating without a word is how a caller ends
  // up looking for a file that was never going to be there.
  if (safeName !== requested) {
    out.note = `output_file is confined to ${DOWNLOADS_DIR} — "${requested}" was written as ${path.basename(safePath)}, not to the path requested.`;
  }
  return out;
}

// What comes back inline when the payload went to disk: enough to know the call
// worked and the shape is right, and nothing more.
function summarizeOutput(payload, rows, written) {
  const summary = { ...written };
  if (rows) {
    summary.rows = rows.length;
    summary.fields = rows.length ? Object.keys(rows[0]) : [];
    summary.sample = rows.slice(0, 2);
    for (const k of ["fill_rates", "dropped", "warnings", "stopped_because", "pages_fetched"]) {
      if (payload && payload[k] !== undefined) summary[k] = payload[k];
    }
  } else if (Array.isArray(payload)) {
    summary.items = payload.length;
    summary.sample = payload.slice(0, 2);
  } else if (payload && typeof payload === "object") {
    summary.keys = Object.keys(payload);
  }
  return summary;
}

// Payload shapes that carry a records array worth writing as jsonl/csv.
function rowsOf(payload) {
  if (payload && Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload)) return payload;
  return null;
}

module.exports = { toCsv, isBlank, writeOutput, summarizeOutput, rowsOf };
