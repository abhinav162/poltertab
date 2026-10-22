// `poltertab setup` — interactive installer.
//
// Three things have to land for PolterTab to work end to end:
//   1. the navigation-strategy skill, so the agent knows how to drive a browser
//   2. a CLAUDE.md section, so it knows the tools exist at all
//   3. an MCP server registration, so the tools are actually connected
//
// The fourth thing — the Chrome extension — cannot be installed from a
// terminal, so we hand over a link and stop.
//
// Everything here is re-runnable. A user who runs setup twice (or upgrades and
// runs it again) must not end up with two copies of the snippet or a corrupted
// config, so each step checks for its own prior work.

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");

const PKG = path.join(__dirname, "..");
const SKILL_SRC = path.join(PKG, "skills");
const SNIPPET_SRC = path.join(PKG, "assets", "claude-md-snippet.md");

// EXTENSION_URL is the GitHub release pinned to the version being installed,
// not /releases/latest. Someone on a prerelease (npm i -g poltertab@beta) who
// followed a /latest link would get the previous stable extension, because
// GitHub's /releases/latest skips prereleases — a fresh, correctly-followed
// setup that lands in version skew. The Chrome Web Store URL is shown alongside
// it (Store-first when the Store version is compatible with the server).
//
// Advice printed for skew must not re-create the fault: extensionUrl() always
// pins to the named version, never to /latest. (See update-check.js for the
// full skew-detection logic.)
const { addAllowlistEntry } = require("../mcp-server/uploads-config.js");
const { validateAllowlistEntry } = require("../mcp-server/upload-paths.js");
const updates = require("../mcp-server/update-check.js");
const PKG_VERSION = require("../package.json").version;
const EXTENSION_URL = updates.extensionUrl(PKG_VERSION);
const { CWS_STORE_URL } = updates;

// Identifies our section in a CLAUDE.md we do not own. Presence means
// "already installed" — this is the whole idempotency check for step 2.
const MARKER = "<!-- poltertab -->";

// Builds the extension installation note shown at the end of setup.
//
// Fetches the current Chrome Web Store version and decides compatibility using
// the same major.minor skew() rule as the server's live skew detection, so the
// two agree. fetchImpl is injectable for unit tests; it follows the same
// timeout/opt-out pattern as fetchLatest in update-check.js.
//
// Returns an array of lines ready for console.log.
async function storeExtensionNote({
  serverVersion = PKG_VERSION,
  fetchImpl,
} = {}) {
  const ghUrl = updates.extensionUrl(serverVersion);
  const storeVersion = await updates.fetchStoreCwsVersion(fetchImpl);

  if (storeVersion === null) {
    // Offline, timeout, opted out, or malformed — show both with a neutral note.
    return [
      `  ${c.cyan(CWS_STORE_URL)}`,
      `  or the GitHub release v${serverVersion}: ${c.cyan(ghUrl)}`,
      c.dim(`      could not check the Store version; the GitHub release v${serverVersion} always matches`),
    ];
  }

  const sk = updates.skew(serverVersion, storeVersion);
  if (sk === null) {
    // Compatible (same major.minor): Store first; GitHub as load-unpacked option.
    return [
      `  Chrome Web Store (recommended, updates itself):`,
      `  ${c.cyan(CWS_STORE_URL)}`,
      `  or load unpacked from GitHub release v${serverVersion}: ${c.cyan(ghUrl)}`,
    ];
  }

  // Not compatible: put GitHub first with a one-line explanation.
  const [major, minor] = serverVersion.split(".");
  let reason;
  if (sk.kind === "extension-behind") {
    reason = `the Store has ${storeVersion}; this server ${serverVersion} needs a ${major}.${minor}.x extension until the Store updates`;
  } else {
    reason = `the Store has ${storeVersion}; this server ${serverVersion} — update the server: npm update -g poltertab`;
  }
  return [
    `  GitHub release v${serverVersion} (${reason}):`,
    `  ${c.cyan(ghUrl)}`,
    `  Chrome Web Store (currently ${storeVersion}): ${c.cyan(CWS_STORE_URL)}`,
  ];
}

// Default folder offered in the uploads prompt. Must never be inside
// buildAlwaysBlocked — a unit test (H7) pins this.
const DEFAULT_UPLOAD_FOLDER = "~/Downloads";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

// --- steps -----------------------------------------------------------------

// Global installs live under the home directory and apply everywhere. Project
// installs live in the working directory, so a repo can carry browser access
// without the user granting it to every other project on the machine.
//
// Note the asymmetry: skills always sit in `.claude/skills`, but project
// instructions sit at `./CLAUDE.md` while global ones sit at
// `~/.claude/CLAUDE.md`. Claude Code loads those two paths; a project-level
// `.claude/CLAUDE.md` is read by nothing.
function resolvePaths(scope, { home = os.homedir(), cwd = process.cwd() } = {}) {
  if (scope === "global") {
    return {
      skillsDir: path.join(home, ".claude", "skills"),
      claudeMd: path.join(home, ".claude", "CLAUDE.md"),
      mcpScope: "user",
    };
  }
  if (scope === "project") {
    return {
      skillsDir: path.join(cwd, ".claude", "skills"),
      claudeMd: path.join(cwd, "CLAUDE.md"),
      mcpScope: "project",
    };
  }
  throw new Error(`Unknown install scope: ${scope}`);
}

function installSkill(skillsDir) {
  const name = "browser-navigation-strategy";
  const dest = path.join(skillsDir, name);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(
    path.join(SKILL_SRC, name, "SKILL.md"),
    path.join(dest, "SKILL.md"),
  );
  return path.join(dest, "SKILL.md");
}

// Returns "created" | "appended" | "skipped" so the caller can report honestly
// rather than claiming it wrote something it left alone.
function updateClaudeMd(claudeMd) {
  const snippet = fs.readFileSync(SNIPPET_SRC, "utf8").trimEnd() + "\n";

  if (!fs.existsSync(claudeMd)) {
    fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
    fs.writeFileSync(claudeMd, snippet);
    return "created";
  }

  const existing = fs.readFileSync(claudeMd, "utf8");
  if (existing.includes(MARKER)) return "skipped";

  // A file that does not end in a newline would otherwise run straight into
  // our heading and swallow it into the user's last paragraph.
  const gap = existing.endsWith("\n") ? "\n" : "\n\n";
  fs.appendFileSync(claudeMd, gap + snippet);
  return "appended";
}

// Registration goes through the `claude` CLI on purpose. The user-scope config
// lives in ~/.claude.json alongside a large amount of unrelated Claude Code
// state; rewriting that file ourselves risks clobbering it on a bad parse or a
// concurrent write. `claude mcp add` owns that file and is safe to delegate to.
function registerServer(mcpScope) {
  const r = spawnSync(
    "claude",
    ["mcp", "add", "--scope", mcpScope, "poltertab", "poltertab"],
    { encoding: "utf8" },
  );

  if (r.error && r.error.code === "ENOENT") {
    return { ok: false, reason: "claude CLI not found on PATH" };
  }
  if (r.status !== 0) {
    const out = `${r.stderr || ""}${r.stdout || ""}`.trim();
    // Re-running setup hits this: the server is already registered, which is
    // the desired end state, not a failure.
    if (/already exists/i.test(out)) return { ok: true, already: true };
    return { ok: false, reason: out.split("\n")[0] || `exit ${r.status}` };
  }
  return { ok: true };
}

// --- wizard ----------------------------------------------------------------

// Ctrl-C or Ctrl-D anywhere in the wizard. On a TTY readline holds the terminal
// in raw mode, so Ctrl-C is a keypress delivered to rl as "SIGINT", not a
// signal, and Ctrl-D (EOF) closes rl; either one left the wizard half-run.
function cancelled() {
  return Object.assign(new Error("cancelled"), { code: "CANCELLED" });
}

function ask(rl, question) {
  return new Promise((resolve, reject) => {
    const hasRlEvents = typeof rl.on === "function";
    const stop = () => {
      if (!hasRlEvents) return;
      rl.removeListener("SIGINT", onCancel);
      rl.removeListener("close", onCancel);
    };
    const onCancel = () => { stop(); reject(cancelled()); };
    if (hasRlEvents) { rl.on("SIGINT", onCancel); rl.on("close", onCancel); }
    rl.question(question, (answer) => { stop(); resolve(answer); });
  });
}

async function chooseScope(rl) {
  console.log(`${c.bold("Where should PolterTab be available?")}\n`);
  console.log(`  ${c.cyan("1")}  All projects        ${c.dim("(~/.claude)")}`);
  console.log(`  ${c.cyan("2")}  This project only   ${c.dim(process.cwd())}\n`);

  for (;;) {
    const a = (await ask(rl, "  Choose [1]: ")).trim();
    if (a === "" || a === "1") return "global";
    if (a === "2") return "project";
    console.log(c.yellow("  Enter 1 or 2."));
  }
}

// --- Section 1: folder prompt -----------------------------------------------

// Shows the uploads-folder prompt and updates the allowlist.
// Uses the wizard's existing readline interface (rl); never opens a second one.
// Caller guarantees stdin is a TTY before calling.
//
// Exported for direct unit testing.
async function runFolderPrompt(rl, {
  homeDir = os.homedir(),
  addFn = addAllowlistEntry,
  validateFn = validateAllowlistEntry,
} = {}) {
  console.log(`\n  Let agents upload files from a folder?  [${DEFAULT_UPLOAD_FOLDER}]`);
  console.log("  Enter = allow ~/Downloads · type another folder · n = skip");

  const MAX_RETRIES = 2;
  let retries = 0;

  for (;;) {
    const raw = (await ask(rl, "  > ")).trim();

    if (raw === "n" || raw === "N") {
      console.log("  – uploads skipped      enable later: poltertab uploads allow <dir>");
      return;
    }

    const folderPath = raw === "" ? DEFAULT_UPLOAD_FOLDER : raw;

    const v = validateFn(folderPath, homeDir);
    if (!v.ok) {
      console.log(`  ${c.yellow("!")} ${v.errorText}`);
      retries++;
      if (retries >= MAX_RETRIES) {
        console.log("  – uploads skipped (poltertab uploads allow <dir> any time)");
        return;
      }
      // re-ask; the loop continues
      continue;
    }

    const added = addFn(folderPath);
    if (added) {
      console.log(`  ${c.green("✓")} uploads folder       ${c.dim(folderPath)}`);
    } else {
      console.log(`  ${c.green("✓")} uploads folder       ${c.dim(folderPath)} (already set)`);
    }
    return;
  }
}

// --- Section 3: setup pairing step ------------------------------------------

// Shows the extension instructions and runs the pairing code loop.
// Uses the wizard's existing readline interface (rl).
// Caller guarantees stdin is a TTY before calling.
//
// opts.pairFlow — injectable pair function for unit tests. Signature:
//   async (rl) => { ok, extensionId? } | { ok: false, reason }
// When not injected, the real server/temp-listener flow is used.
//
// Exported for direct unit testing.
// opts.fetchImpl — injectable fetch for Store version lookup (unit tests).
async function runSetupPairingStep(rl, { pairFlow, fetchImpl } = {}) {
  const {
    resolveWsPort,
    tryConnectToServer,
    probeIsPoltertab,
    pairViaRunningServer,
    pairViaTempListener,
  } = require("./pair-flow.js");

  const noteLines = await storeExtensionNote({ fetchImpl });
  console.log(`\n  ${c.bold("Last step — connect the extension:")}`);
  console.log(`  1. Install the extension:`);
  for (const line of noteLines) console.log(`   ${line}`);
  console.log("  2. chrome://extensions → turn on Developer mode → Load unpacked → pick the folder");
  console.log("     (skip step 2 if you install from the Chrome Web Store)");
  console.log("  3. Click the PolterTab icon in Chrome and type the 4-letter code it shows.");
  console.log("");

  // Use the injected flow (tests) or the real connection flow.
  if (!pairFlow) {
    const port = resolveWsPort();
    let serverWs = null;
    try {
      serverWs = await tryConnectToServer(port);
      // Verify the server is actually poltertab before treating it as the pair host.
      if (!(await probeIsPoltertab(port))) {
        serverWs.terminate();
        serverWs = null;
        console.log(
          `  Port ${port} is in use by something that isn’t poltertab.` +
          " Close it or set a different port in ~/.poltertab/config.json, then retry.",
        );
        return;
      }
    } catch (err) {
      if (err.code !== "ECONNREFUSED" && err.code !== "ENOENT" && err.code !== "ETIMEDOUT") {
        console.log(`  Could not reach port ${port}: ${err.message}`);
        return;
      }
      // Nothing listening — use temp listener below.
    }

    if (serverWs) {
      process.stdout.write("  waiting for the extension to connect…\n");
      pairFlow = (r) => pairViaRunningServer(serverWs, r);
    } else {
      process.stdout.write("  waiting for the extension to connect…\n");
      pairFlow = async (r) => {
        try {
          return await pairViaTempListener(port, r, {
            onStatus: (msg) => process.stdout.write(`  ${msg}\n`),
          });
        } catch (e) {
          if (e.code === "EADDRINUSE") {
            console.log(
              `  Port ${port} is in use by something that isn’t poltertab.` +
              " Close it or set a different port in ~/.poltertab/config.json, then retry.",
            );
            return { ok: false, reason: "skipped" };
          }
          throw e;
        }
      };
    }
  }

  const result = await pairFlow(rl);

  if (result.reason === "cancelled") throw cancelled();

  if (result.ok) {
    const shortId = result.extensionId.slice(0, 8);
    console.log(
      `  ${c.green("✓")} paired               extension ${shortId}…` +
      " · uploads panel is live in the extension",
    );
    console.log(c.dim(`      undo: poltertab uploads unpair ${result.extensionId}`));
  } else if (result.reason === "skipped") {
    console.log(
      "  – pairing skipped      run poltertab uploads pair once the extension is loaded",
    );
  } else if (result.reason === "locked") {
    console.log("  Too many wrong codes. Pairing is locked for 15 minutes.");
  }
  // Other reasons (error, server_disconnected): silent skip, don't abort setup.
}

// --- wizard ----------------------------------------------------------------

async function run(argv = [], {
  home = os.homedir(),
  cwd = process.cwd(),
  isTTY = process.stdin.isTTY,
  rl: injectedRl = null,
  fetchImpl,
} = {}) {
  console.log(`\n  ${c.bold("PolterTab")} — browser control for AI agents\n`);

  // Open one readline interface for all prompts. If tests inject one, use it.
  const rl = injectedRl || (isTTY
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null);

  let scope;
  try {
    scope = argv.includes("--global")
      ? "global"
      : argv.includes("--project")
        ? "project"
        : rl
          ? await chooseScope(rl)
          : (() => { throw new Error("Choose --global or --project when stdin is not a TTY"); })();
  } catch (err) {
    if (rl && !injectedRl) rl.close();
    throw err;
  }

  const paths = resolvePaths(scope, { home, cwd });
  console.log("");

  // Each step reports what it actually did. A step that fails is reported with
  // the manual alternative rather than aborting the rest of the install —
  // partial setup the user can finish beats no setup at all.
  try {
    const skill = installSkill(paths.skillsDir);
    console.log(`  ${c.green("✓")} skill installed      ${c.dim(skill)}`);
  } catch (err) {
    console.log(`  ${c.yellow("!")} skill install failed ${c.dim(err.message)}`);
  }

  try {
    const what = updateClaudeMd(paths.claudeMd);
    const label = { created: "created", appended: "updated", skipped: "already present" }[what];
    console.log(`  ${c.green("✓")} CLAUDE.md ${label.padEnd(10)} ${c.dim(paths.claudeMd)}`);
  } catch (err) {
    console.log(`  ${c.yellow("!")} CLAUDE.md failed     ${c.dim(err.message)}`);
  }

  const reg = registerServer(paths.mcpScope);
  if (reg.ok) {
    const label = reg.already ? "already registered" : "registered";
    console.log(`  ${c.green("✓")} MCP server ${label}  ${c.dim(`scope: ${paths.mcpScope}`)}`);
  } else {
    console.log(`  ${c.yellow("!")} MCP server not registered — ${reg.reason}`);
    console.log(c.dim(`      run: claude mcp add --scope ${paths.mcpScope} poltertab poltertab`));
  }

  // Section 1: optional uploads folder prompt (TTY only).
  if (isTTY && rl) {
    try {
      await runFolderPrompt(rl, { homeDir: home });
    } catch (err) {
      if (err.code === "CANCELLED") { if (!injectedRl) rl.close(); throw err; }
      console.log(`  ${c.yellow("!")} uploads folder skipped — ${err.message}`);
    }
  }

  // Section 3: optional pairing step (TTY only).
  if (isTTY && rl) {
    try {
      await runSetupPairingStep(rl, { fetchImpl });
    } catch (err) {
      if (err.code === "CANCELLED") { if (!injectedRl) rl.close(); throw err; }
      console.log(`  ${c.yellow("!")} pairing step failed — ${err.message}`);
    }
  } else {
    // Non-TTY: show extension instructions so the output is still useful.
    console.log(`\n  ${c.bold("One step left — install the Chrome extension:")}`);
    const noteLines = await storeExtensionNote({ fetchImpl });
    for (const line of noteLines) console.log(line);
    console.log(c.dim("      (load-unpacked: chrome://extensions → Developer mode → Load unpacked)\n"));
    console.log(`  ${c.dim("Restart Claude Code to pick up the new tools.")}\n`);
  }

  if (rl && !injectedRl) rl.close();
}

module.exports = {
  run,
  resolvePaths,
  installSkill,
  updateClaudeMd,
  registerServer,
  runFolderPrompt,
  runSetupPairingStep,
  storeExtensionNote,
  MARKER,
  EXTENSION_URL,
  CWS_STORE_URL,
  DEFAULT_UPLOAD_FOLDER,
};

// Guard so the test suite can require this file without triggering a wizard
// that would prompt on stdin and write to the real ~/.claude.
if (require.main === module) {
  run(process.argv.slice(3)).catch((err) => {
    console.error(`\n  setup failed: ${err.message}\n`);
    process.exit(1);
  });
}
