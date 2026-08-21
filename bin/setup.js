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

// Bump to the Chrome Web Store listing once it clears review. The GitHub
// release stays valid either way, so this is a one-line switch.
const EXTENSION_URL = "https://github.com/abhinav162/poltertab/releases/latest";

// Identifies our section in a CLAUDE.md we do not own. Presence means
// "already installed" — this is the whole idempotency check for step 2.
const MARKER = "<!-- poltertab -->";

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

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
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

async function run(argv = []) {
  console.log(`\n  ${c.bold("PolterTab")} — browser control for AI agents\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let scope;
  try {
    scope = argv.includes("--global")
      ? "global"
      : argv.includes("--project")
        ? "project"
        : await chooseScope(rl);
  } finally {
    rl.close();
  }

  const paths = resolvePaths(scope);
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

  console.log(`\n  ${c.bold("One step left — install the Chrome extension:")}`);
  console.log(`  ${c.cyan(EXTENSION_URL)}`);
  console.log(c.dim("      unzip it, then chrome://extensions → Developer mode → Load unpacked\n"));
  console.log(`  ${c.dim("Restart Claude Code to pick up the new tools.")}\n`);
}

module.exports = {
  run,
  resolvePaths,
  installSkill,
  updateClaudeMd,
  registerServer,
  MARKER,
  EXTENSION_URL,
};

// Guard so the test suite can require this file without triggering a wizard
// that would prompt on stdin and write to the real ~/.claude.
if (require.main === module) {
  run(process.argv.slice(3)).catch((err) => {
    console.error(`\n  setup failed: ${err.message}\n`);
    process.exit(1);
  });
}
