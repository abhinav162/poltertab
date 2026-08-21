#!/usr/bin/env node
// Installer regression suite. Covers the parts of `poltertab setup` that touch
// the user's filesystem, because those are the parts that can silently corrupt
// a config or duplicate themselves on a re-run.
//
//   A  path resolution     global vs project scope
//   B  skill install       copies the shipped skill into place
//   C  CLAUDE.md update    appends once, never twice
//   D  CLI routing         `poltertab` starts the server, `poltertab setup` does not
//
// Run: node test/setup.test.js
// Same shape as mcp-server/test/run.js — plain asserts, one file, real fs.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const setup = require(path.join(REPO, "bin", "setup.js"));

let pass = 0;
const failures = [];

function test(name, fn) {
  // Every test gets its own throwaway HOME/cwd so a leaked write cannot reach
  // the real ~/.claude and cannot make the next test pass for the wrong reason.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "poltertab-test-"));
  try {
    fn(sandbox);
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL  ${name}\n          ${err.message.split("\n")[0]}`);
    failures.push(name);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log("\nA  path resolution\n");

test("A1  global scope resolves under the home directory", (box) => {
  const p = setup.resolvePaths("global", { home: box, cwd: "/somewhere/else" });
  assert.strictEqual(p.skillsDir, path.join(box, ".claude", "skills"));
  assert.strictEqual(p.claudeMd, path.join(box, ".claude", "CLAUDE.md"));
  assert.strictEqual(p.mcpScope, "user");
});

test("A2  project scope resolves under the working directory", (box) => {
  const p = setup.resolvePaths("project", { home: "/home/nope", cwd: box });
  assert.strictEqual(p.skillsDir, path.join(box, ".claude", "skills"));
  assert.strictEqual(p.claudeMd, path.join(box, "CLAUDE.md"));
  assert.strictEqual(p.mcpScope, "project");
});

test("A3  project CLAUDE.md sits at the repo root, not inside .claude", (box) => {
  // Claude Code reads project instructions from ./CLAUDE.md. Writing them to
  // .claude/CLAUDE.md instead would install a file nothing ever loads.
  const p = setup.resolvePaths("project", { home: "/home/nope", cwd: box });
  assert.ok(!p.claudeMd.includes(".claude"), `leaked into .claude: ${p.claudeMd}`);
});

test("A4  an unknown scope is rejected rather than guessed", () => {
  assert.throws(() => setup.resolvePaths("sideways", {}), /scope/i);
});

console.log("\nB  skill install\n");

test("B1  the shipped skill lands as a readable SKILL.md", (box) => {
  const dest = setup.installSkill(path.join(box, "skills"));
  const body = fs.readFileSync(dest, "utf8");
  assert.ok(dest.endsWith(path.join("browser-navigation-strategy", "SKILL.md")), dest);
  assert.ok(body.includes("browser_snapshot"), "skill lost its tool references");
});

test("B2  the skill carries the frontmatter Claude Code needs to load it", (box) => {
  const body = fs.readFileSync(setup.installSkill(path.join(box, "skills")), "utf8");
  assert.ok(body.startsWith("---"), "missing frontmatter block");
  assert.ok(/^name:\s*\S+/m.test(body), "missing name field");
  assert.ok(/^description:\s*\S+/m.test(body), "missing description field");
});

test("B3  installing over an existing copy overwrites instead of erroring", (box) => {
  const dir = path.join(box, "skills");
  setup.installSkill(dir);
  const dest = setup.installSkill(dir); // must not throw
  assert.ok(fs.readFileSync(dest, "utf8").includes("browser_snapshot"));
});

test("B4  nested target directories are created on demand", (box) => {
  const dest = setup.installSkill(path.join(box, "a", "b", "c", "skills"));
  assert.ok(fs.existsSync(dest));
});

test("B5  the shipped skill names no dead tools", (box) => {
  // The skill is the agent's map of the tool surface. A tool named here that
  // the server does not expose sends the agent chasing a call that cannot work.
  const body = fs.readFileSync(setup.installSkill(path.join(box, "s")), "utf8");
  const server = fs.readFileSync(path.join(REPO, "mcp-server", "index.js"), "utf8");
  const named = [...new Set(body.match(/browser_[a-z_]+/g) || [])];
  assert.ok(named.length > 3, `skill references almost no tools: ${named}`);
  const missing = named.filter((t) => !server.includes(`"${t}"`));
  assert.deepStrictEqual(missing, [], `skill names tools the server lacks: ${missing}`);
});

console.log("\nC  CLAUDE.md update\n");

test("C1  a missing CLAUDE.md is created with the snippet", (box) => {
  const md = path.join(box, "CLAUDE.md");
  assert.strictEqual(setup.updateClaudeMd(md), "created");
  assert.ok(fs.readFileSync(md, "utf8").includes(setup.MARKER));
});

test("C2  an existing CLAUDE.md keeps its content and gains the snippet", (box) => {
  const md = path.join(box, "CLAUDE.md");
  fs.writeFileSync(md, "# My rules\n\nDo not delete the database.\n");
  assert.strictEqual(setup.updateClaudeMd(md), "appended");
  const body = fs.readFileSync(md, "utf8");
  assert.ok(body.includes("Do not delete the database."), "clobbered user content");
  assert.ok(body.includes(setup.MARKER), "snippet never landed");
});

test("C3  running twice appends exactly once", (box) => {
  const md = path.join(box, "CLAUDE.md");
  setup.updateClaudeMd(md);
  assert.strictEqual(setup.updateClaudeMd(md), "skipped");
  const hits = fs.readFileSync(md, "utf8").split(setup.MARKER).length - 1;
  assert.strictEqual(hits, 1, `snippet present ${hits} times`);
});

test("C4  six runs still leave one copy", (box) => {
  const md = path.join(box, "CLAUDE.md");
  for (let i = 0; i < 6; i++) setup.updateClaudeMd(md);
  const hits = fs.readFileSync(md, "utf8").split(setup.MARKER).length - 1;
  assert.strictEqual(hits, 1, `snippet present ${hits} times`);
});

test("C5  the snippet is separated from prose that lacks a trailing newline", (box) => {
  const md = path.join(box, "CLAUDE.md");
  fs.writeFileSync(md, "no trailing newline here");
  setup.updateClaudeMd(md);
  const body = fs.readFileSync(md, "utf8");
  assert.ok(
    !/no trailing newline here\S/.test(body),
    "snippet ran into the previous line",
  );
});

test("C6  parent directories are created for the CLAUDE.md path", (box) => {
  const md = path.join(box, ".claude", "CLAUDE.md");
  assert.strictEqual(setup.updateClaudeMd(md), "created");
  assert.ok(fs.existsSync(md));
});

test("C7  the snippet points at the skill that actually gets installed", (box) => {
  const md = path.join(box, "CLAUDE.md");
  setup.updateClaudeMd(md);
  const skill = fs.readFileSync(setup.installSkill(path.join(box, "s")), "utf8");
  const name = skill.match(/^name:\s*"?([\w-]+)"?/m)[1];
  assert.ok(
    fs.readFileSync(md, "utf8").includes(name),
    `snippet never names the ${name} skill`,
  );
});

console.log("\nD  CLI routing\n");

test("D1  the bin is executable and declares a node shebang", () => {
  const bin = path.join(REPO, "bin", "poltertab.js");
  assert.ok(
    fs.readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node"),
    "missing shebang — npm link would produce an unrunnable binary",
  );
  assert.ok(fs.statSync(bin).mode & 0o111, "bin is not executable");
});

test("D2  package.json exposes the bin and ships the files setup needs", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO, "package.json"), "utf8"),
  );
  assert.strictEqual(pkg.bin.poltertab, "./bin/poltertab.js");
  for (const need of ["bin/", "mcp-server/", "skills/", "assets/"]) {
    assert.ok(pkg.files.includes(need), `package.files omits ${need}`);
  }
  // The wizard shells out to `claude`; the server needs these two at runtime.
  for (const dep of ["@modelcontextprotocol/sdk", "ws"]) {
    assert.ok(pkg.dependencies[dep], `root package.json missing ${dep}`);
  }
});

test("D3  requiring setup.js does not run the wizard", () => {
  // require.main guard: importing for tests must not prompt or write anything.
  assert.strictEqual(typeof setup.run, "function");
  assert.strictEqual(typeof setup.resolvePaths, "function");
});

test("D4  the published package excludes the extension and test dirs", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO, "package.json"), "utf8"),
  );
  const joined = pkg.files.join(" ");
  assert.ok(!joined.includes("chrome-extension"), "extension would bloat the tarball");
  assert.ok(
    pkg.files.some((f) => f.startsWith("!") && f.includes("test")),
    "test dirs are not excluded from the tarball",
  );
});

test("D5  the extension download link is a real https URL", () => {
  assert.ok(
    /^https:\/\/\S+$/.test(setup.EXTENSION_URL),
    `not a usable URL: ${setup.EXTENSION_URL}`,
  );
});

console.log(
  `\n${pass} passed, ${failures.length} failed` +
    (failures.length ? `\n  ${failures.join("\n  ")}` : "") +
    "\n",
);
process.exit(failures.length ? 1 : 0);
