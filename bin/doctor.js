// `poltertab doctor` — what is installed, what is available, and whether the
// two halves agree.
//
// Deliberately works with no server running and no network. Someone runs this
// because something is already broken, which is the worst time to demand that
// more things be working.

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const PKG = path.join(__dirname, "..");
const updates = require(path.join(PKG, "mcp-server", "update-check.js"));

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const home = () =>
  process.env.POLTERTAB_HOME || path.join(os.homedir(), ".poltertab");

function port() {
  const i = process.argv.indexOf("--port");
  if (i !== -1 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return Number(process.env.MCP_BROWSER_WS_PORT) || 7822;
}

// A listening port means a server holds the bridge. Cheaper and more reliable
// than speaking the protocol just to answer "is anything running".
function probePort(p, timeout = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ port: p, host: "127.0.0.1" });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeout);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

async function run(argv = []) {
  const H = home();
  const own = require(path.join(PKG, "package.json")).version;
  const row = (k, v) => console.log(`  ${k.padEnd(12)}${v}`);

  console.log(`\n  ${c.bold("PolterTab")} ${c.dim("doctor")}\n`);

  // Start the registry lookup before printing anything, then report everything
  // local while it is in flight. A cold lookup costs seconds, and blocking the
  // whole report on it makes doctor look hung exactly when someone is already
  // suspicious that something is broken.
  const checking = updates
    .checkForUpdate({ current: own, home: H, force: argv.includes("--force") })
    .catch(() => ({ latest: null, updateAvailable: false }));

  // --- versions
  const seen = updates.readExtensionState(H);
  const ext = seen && seen.extensionVersion;
  const sk = updates.skew(own, ext);

  row("server", own);

  if (!ext) {
    row("extension", c.dim("never seen — has it connected to a server yet?"));
  } else {
    row(
      "extension",
      `${ext}  ${sk ? c.red("SKEW") : c.green("matches server")}` +
        c.dim(`  last seen ${ago(seen.seenAt || 0)}`),
    );
  }

  const listening = await probePort(port());
  row(
    "bridge",
    listening
      ? `${c.green("listening")} ${c.dim(`on port ${port()}`)}`
      : `${c.dim(`nothing on port ${port()}`)}`,
  );

  row("state", c.dim(H));

  // Now collect the answer we started with.
  const check = await checking;
  if (updates.disabled() && !check.latest) {
    row("npm", c.dim("update check disabled by POLTERTAB_NO_UPDATE_CHECK"));
  } else if (check.latest) {
    row(
      "npm",
      check.updateAvailable
        ? `${c.yellow(check.latest)} ${c.dim("available")}`
        : `${c.green("up to date")} ${c.dim(`(latest is ${check.latest})`)}`,
    );
  } else {
    row("npm", c.dim("could not reach the registry"));
  }

  // --- what to do about it
  const todo = [];
  if (sk && sk.kind === "extension-behind") {
    todo.push(
      `${c.red("The extension is older than the server.")} Browser commands can fail\n` +
        `    in ways that look like a missing element. Download and reload it:\n` +
        `    ${c.cyan(updates.EXTENSION_URL)}`,
    );
  } else if (sk && sk.kind === "server-behind") {
    todo.push(
      `${c.yellow("The extension is newer than the server.")} Update the package:\n` +
        `    ${c.cyan("npm update -g poltertab")}`,
    );
  }
  if (check.updateAvailable) {
    todo.push(
      `PolterTab ${c.bold(check.latest)} is available:\n` +
        `    ${c.cyan("npm update -g poltertab")}\n` +
        `    ${c.dim("then reload the extension from")} ${c.cyan(updates.EXTENSION_URL)}`,
    );
  }
  if (!listening) {
    todo.push(
      `No bridge on port ${port()}. That is expected unless an MCP client has\n` +
        `    PolterTab running — the server starts when the client starts it.`,
    );
  }

  if (todo.length) {
    console.log(`\n  ${c.bold("To do")}\n`);
    for (const t of todo) console.log(`  • ${t}`);
  } else if (!ext) {
    // Claiming "both halves agree" having never seen one of them is the kind of
    // all-clear that sends someone looking for the fault somewhere else.
    console.log(
      `\n  ${c.yellow("Nothing wrong found, but the extension has never checked in.")}\n` +
        `  ${c.dim("Install it, open a page, and run doctor again to compare versions:")}\n` +
        `  ${c.cyan(updates.EXTENSION_URL)}`,
    );
  } else {
    console.log(`\n  ${c.green("Nothing to do — both halves agree and are current.")}`);
  }
  console.log("");

  // Non-zero on skew only: an available update is information, but two halves
  // that disagree is a real fault, and a script may want to act on it.
  return sk ? 1 : 0;
}

module.exports = { run, probePort, ago };

if (require.main === module) {
  run(process.argv.slice(3))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`\n  doctor failed: ${err.message}\n`);
      process.exit(1);
    });
}
