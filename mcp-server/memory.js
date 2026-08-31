// Site memory: the notes an agent leaves itself about a domain, keyed by
// hostname. The key arrives from a model, so it is untrusted input rather than
// a filename — see memoryFile.

const fs = require("fs");
const path = require("path");
const { MEMORY_DIR } = require("./config.js");

fs.mkdirSync(MEMORY_DIR, { recursive: true });

// Installs predating the move kept memory beside the code. Copy it forward once
// so an upgrade does not look like the agent forgot everything it learned.
// Never overwrite: if both sides have a note for a domain, the one already in
// the new location is the live one.
(() => {
  const legacy = path.join(__dirname, "navigation_memory");
  if (legacy === MEMORY_DIR || !fs.existsSync(legacy)) return;
  let copied = 0;
  for (const name of fs.readdirSync(legacy)) {
    const to = path.join(MEMORY_DIR, name);
    if (!name.endsWith(".json") || fs.existsSync(to)) continue;
    try {
      fs.copyFileSync(path.join(legacy, name), to);
      copied++;
    } catch (_) {
      // A read-only or half-removed legacy dir is not worth failing startup.
    }
  }
  if (copied) {
    console.error(
      `[PolterTab MCP] Migrated ${copied} site memory file(s) to ${MEMORY_DIR}`,
    );
  }
})();

// Site memory is keyed by hostname, and that key arrives from a model — so it
// is untrusted input rather than a filename. Two failures this closes: a note
// saved under kw.com was invisible to a lookup for www.kw.com (the same site),
// and the raw value was interpolated straight into a path, so "../.." reached
// outside MEMORY_DIR.
function memoryFile(rawHost) {
  let host = String(rawHost).trim().toLowerCase();

  // The parameter is also documented as accepting `url`, so a full URL turning
  // up here is expected rather than a caller mistake.
  if (host.includes("/")) {
    try {
      host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
    } catch {
      host = host.split("/")[0];
    }
  }

  host = host.replace(/[^a-z0-9.-]/g, "").replace(/^\.+/, "");
  if (!host) throw new Error(`Not a usable hostname: ${rawHost}`);

  // Existing notes live under whichever spelling first created them — the store
  // already holds both kw.com.json and www.linkedin.com.json — so try the
  // variants before concluding this is a new file.
  const bare = host.replace(/^www\./, "");
  for (const name of [bare, host, `www.${bare}`]) {
    const p = path.join(MEMORY_DIR, `${name}.json`);
    if (fs.existsSync(p)) return p;
  }
  return path.join(MEMORY_DIR, `${bare}.json`);
}

function readMemory(rawHost) {
  const file = memoryFile(rawHost);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

function saveMemory(rawHost, obstacle, solution) {
  const file = memoryFile(rawHost);
  const data = readMemory(rawHost);
  data.push({ obstacle, solution, timestamp: Date.now() });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return data.length;
}

module.exports = { memoryFile, readMemory, saveMemory };
