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

// Cases queue onto one chain and run in order. A plain synchronous runner would
// call an `async` test, get a promise back, never await it, and print PASS — so
// an async assertion failure would land as an unhandled rejection while the
// suite reported success. Awaiting is the only thing that makes those real.
let chain = Promise.resolve();

function test(name, fn) {
  chain = chain.then(async () => {
    // Every test gets its own throwaway HOME/cwd so a leaked write cannot reach
    // the real ~/.claude and cannot make the next test pass for the wrong reason.
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "poltertab-test-"));
    try {
      await fn(sandbox);
      console.log(`  PASS  ${name}`);
      pass++;
    } catch (err) {
      console.log(`  FAIL  ${name}\n          ${err.message.split("\n")[0]}`);
      failures.push(name);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
}

// Headers queue too, or they would all print before the first test ran.
function group(title) {
  chain = chain.then(() => console.log(`\n${title}\n`));
}

group("A  path resolution");

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

group("B  skill install");

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
  // Tool definitions live in tools.js; index.js only dispatches them.
  const server = fs.readFileSync(path.join(REPO, "mcp-server", "tools.js"), "utf8");
  const named = [...new Set(body.match(/browser_[a-z_]+/g) || [])];
  assert.ok(named.length > 3, `skill references almost no tools: ${named}`);
  const missing = named.filter((t) => !server.includes(`"${t}"`));
  assert.deepStrictEqual(missing, [], `skill names tools the server lacks: ${missing}`);
});

group("C  CLAUDE.md update");

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

group("D  CLI routing");

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

test("E6  the extension link names this build's own release, not /latest", () => {
  // GitHub's /releases/latest skips prereleases. A `poltertab@beta` install
  // told to fetch "the latest release" gets the previous *stable* extension —
  // so a fresh setup that followed the instructions exactly lands in version
  // skew, and the skew remediation used to point at the same wrong place.
  const version = require(path.join(REPO, "package.json")).version;
  assert.strictEqual(
    setup.EXTENSION_URL,
    `https://github.com/abhinav162/poltertab/releases/tag/v${version}`,
    "setup does not link the release matching the version it installs",
  );
});

test("E7  extensionUrl pins a prerelease, and falls back only when unparseable", () => {
  const up = require(path.join(REPO, "mcp-server", "update-check.js"));
  const tag = (v) => `https://github.com/abhinav162/poltertab/releases/tag/v${v}`;
  assert.strictEqual(up.extensionUrl("1.5.0-beta.1"), tag("1.5.0-beta.1"));
  assert.strictEqual(up.extensionUrl("1.4.0"), tag("1.4.0"));
  assert.strictEqual(up.extensionUrl("v1.4.0"), tag("1.4.0"), "leading v doubled up");
  // Only a version we cannot parse may fall back — a dev checkout, where a tag
  // URL would 404.
  for (const bad of ["", null, undefined, "garbage"]) {
    assert.strictEqual(
      up.extensionUrl(bad),
      "https://github.com/abhinav162/poltertab/releases/latest",
      `unparseable ${JSON.stringify(bad)} should fall back`,
    );
  }
});

test("E8  skew advice never points at a build that would re-create the skew", () => {
  const up = require(path.join(REPO, "mcp-server", "update-check.js"));
  const msg = up.notice({
    current: "1.5.0-beta.1",
    latest: null,
    updateAvailable: false,
    skew: up.skew("1.5.0-beta.1", "1.4.0"),
  });
  assert.ok(msg, "no notice produced for a real skew");
  assert.ok(
    msg.includes("/releases/tag/v1.5.0-beta.1"),
    `skew advice must name the server's own release: ${msg}`,
  );
  assert.ok(
    !msg.includes("/releases/latest"),
    "skew advice still sends a prerelease install to the stable extension",
  );
});

group("E  runtime state lives outside the package");

// A global npm install puts the server under node_modules/poltertab/. Anything
// it writes next to its own code is destroyed by `npm update -g`, so these
// assertions guard against the paths quietly drifting back into __dirname.
const SERVER_SRC = fs.readFileSync(
  path.join(REPO, "mcp-server", "index.js"),
  "utf8",
);
const CONFIG_SRC = fs.readFileSync(
  path.join(REPO, "mcp-server", "config.js"),
  "utf8",
);
// The state paths were hoisted into config.js. E1 still scans both, because a
// package-relative path is just as wrong wherever it is written.
const STATE_SRC = SERVER_SRC + "\n" + CONFIG_SRC;

test("E1  neither state directory is built from __dirname", () => {
  const offenders = STATE_SRC.split("\n").filter(
    (l) =>
      l.includes("__dirname") &&
      /navigation_memory|downloads/.test(l) &&
      !l.trimStart().startsWith("//"),
  );
  // The migration read of the legacy directory is the one allowed use.
  assert.deepStrictEqual(
    offenders.filter((l) => !l.includes("legacy")),
    [],
    `state path still package-relative:\n${offenders.join("\n")}`,
  );
});

test("E2  both directories hang off POLTERTAB_HOME", () => {
  assert.ok(
    /POLTERTAB_HOME\s*=[\s\S]{0,120}homedir\(\)[\s\S]{0,40}\.poltertab/.test(STATE_SRC),
    "POLTERTAB_HOME does not default to ~/.poltertab",
  );
  // Written as object properties in config.js's exports, so accept either
  // `NAME = path.join(POLTERTAB_HOME` or `NAME: path.join(POLTERTAB_HOME`.
  for (const name of ["MEMORY_DIR", "DOWNLOADS_DIR"]) {
    assert.ok(
      new RegExp(`${name}\\s*[:=]\\s*path\\.join\\(\\s*POLTERTAB_HOME`).test(STATE_SRC),
      `${name} is not resolved under POLTERTAB_HOME`,
    );
  }
});

test("E3  the server honours POLTERTAB_HOME and creates the tree", (box) => {
  // Boot the real server just far enough to see where it writes, then stop it.
  const { spawnSync } = require("child_process");
  spawnSync(
    process.execPath,
    ["-e", `process.env.POLTERTAB_HOME=${JSON.stringify(box)};
      const p=require(${JSON.stringify(path.join(REPO, "mcp-server", "index.js"))});
      setTimeout(()=>process.exit(0),50);`],
    { env: { ...process.env, POLTERTAB_HOME: box }, timeout: 15000 },
  );
  assert.ok(
    fs.existsSync(path.join(box, "navigation_memory")),
    "server did not create navigation_memory under POLTERTAB_HOME",
  );
});

test("E4  legacy in-package memory is copied forward on first start", (box) => {
  // Simulate an upgrade: a note sitting in the old location, nothing in the new.
  const legacy = path.join(REPO, "mcp-server", "navigation_memory");
  const probe = path.join(legacy, "__migration-probe.example.json");
  const had = fs.existsSync(legacy);
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(probe, JSON.stringify([{ obstacle: "probe", solution: "x" }]));
  try {
    const { spawnSync } = require("child_process");
    spawnSync(
      process.execPath,
      ["-e", `require(${JSON.stringify(path.join(REPO, "mcp-server", "index.js"))});
        setTimeout(()=>process.exit(0),50);`],
      { env: { ...process.env, POLTERTAB_HOME: box }, timeout: 15000 },
    );
    assert.ok(
      fs.existsSync(path.join(box, "navigation_memory", "__migration-probe.example.json")),
      "legacy memory was not carried forward",
    );
  } finally {
    fs.rmSync(probe, { force: true });
    if (!had) fs.rmSync(legacy, { recursive: true, force: true });
  }
});

test("E5  migration never overwrites a note already in the new location", (box) => {
  const legacy = path.join(REPO, "mcp-server", "navigation_memory");
  const name = "__migration-probe.example.json";
  const probe = path.join(legacy, name);
  const had = fs.existsSync(legacy);
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(probe, JSON.stringify([{ obstacle: "STALE" }]));
  fs.mkdirSync(path.join(box, "navigation_memory"), { recursive: true });
  fs.writeFileSync(
    path.join(box, "navigation_memory", name),
    JSON.stringify([{ obstacle: "LIVE" }]),
  );
  try {
    const { spawnSync } = require("child_process");
    spawnSync(
      process.execPath,
      ["-e", `require(${JSON.stringify(path.join(REPO, "mcp-server", "index.js"))});
        setTimeout(()=>process.exit(0),50);`],
      { env: { ...process.env, POLTERTAB_HOME: box }, timeout: 15000 },
    );
    const body = fs.readFileSync(
      path.join(box, "navigation_memory", name),
      "utf8",
    );
    assert.ok(body.includes("LIVE"), "stale legacy note clobbered the live one");
    assert.ok(!body.includes("STALE"), "stale legacy note clobbered the live one");
  } finally {
    fs.rmSync(probe, { force: true });
    if (!had) fs.rmSync(legacy, { recursive: true, force: true });
  }
});

group("F  release plumbing");

const { spawnSync } = require("child_process");

// Run the real script against a throwaway copy of the repo's two version
// files, so these exercise the shipped logic without touching the checkout.
function releaseMeta(box, { pkgVersion, manifest, tag, prerelease }) {
  fs.mkdirSync(path.join(box, "chrome-extension"), { recursive: true });
  fs.mkdirSync(path.join(box, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(box, "package.json"),
    JSON.stringify({ name: "poltertab", version: pkgVersion }),
  );
  fs.writeFileSync(
    path.join(box, "chrome-extension", "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  fs.copyFileSync(
    path.join(REPO, "scripts", "release-meta.js"),
    path.join(box, "scripts", "release-meta.js"),
  );
  const r = spawnSync(
    process.execPath,
    [path.join(box, "scripts", "release-meta.js"), tag, String(prerelease)],
    { encoding: "utf8" },
  );
  const out = {};
  for (const line of (r.stdout || "").trim().split("\n")) {
    const [k, v] = line.split("=");
    if (k) out[k] = v;
  }
  return { status: r.status, out, stderr: r.stderr || "" };
}

const stable = (v) => ({ version: v });
const pre = (v, name) => ({ version: v, version_name: name });

test("F1  a stable version publishes to latest", (box) => {
  const r = releaseMeta(box, {
    pkgVersion: "2.0.0",
    manifest: stable("2.0.0"),
    tag: "v2.0.0",
    prerelease: false,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.out.dist_tag, "latest");
});

test("F2  alpha, beta, and rc each get their own channel", (box) => {
  for (const [id, expected] of [
    ["alpha.1", "alpha"],
    ["beta.4", "beta"],
    ["rc.2", "rc"],
  ]) {
    const v = `2.1.0-${id}`;
    const r = releaseMeta(box, {
      pkgVersion: v,
      manifest: pre("2.1.0", v),
      tag: `v${v}`,
      prerelease: true,
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.out.dist_tag, expected, `${v} -> ${r.out.dist_tag}`);
  }
});

test("F3  an unrecognised identifier never lands on latest", (box) => {
  // The dangerous default. A typo'd channel must not become the tag that every
  // plain `npm install poltertab` resolves to.
  const v = "2.1.0-wierd.1";
  const r = releaseMeta(box, {
    pkgVersion: v,
    manifest: pre("2.1.0", v),
    tag: `v${v}`,
    prerelease: true,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.notStrictEqual(r.out.dist_tag, "latest");
});

test("F4  a tag that disagrees with package.json is refused", (box) => {
  const r = releaseMeta(box, {
    pkgVersion: "2.0.0",
    manifest: stable("2.0.0"),
    tag: "v9.9.9",
    prerelease: false,
  });
  assert.notStrictEqual(r.status, 0, "published despite a version mismatch");
  assert.match(r.stderr, /package\.json/);
});

test("F5  a manifest left behind is refused", (box) => {
  const r = releaseMeta(box, {
    pkgVersion: "2.0.0",
    manifest: stable("1.0.0"),
    tag: "v2.0.0",
    prerelease: false,
  });
  assert.notStrictEqual(r.status, 0, "published with a stale extension version");
  assert.match(r.stderr, /manifest\.json/);
});

test("F6  a stable version flagged prerelease on GitHub is refused", (box) => {
  // Publishing this would put a release the author called unfinished on the
  // tag everyone installs by default.
  const r = releaseMeta(box, {
    pkgVersion: "2.0.0",
    manifest: stable("2.0.0"),
    tag: "v2.0.0",
    prerelease: true,
  });
  assert.notStrictEqual(r.status, 0, "prerelease footgun not caught");
  assert.match(r.stderr, /latest/);
});

test("F7  a non-semver tag is refused", (box) => {
  const r = releaseMeta(box, {
    pkgVersion: "2.0.0",
    manifest: stable("2.0.0"),
    tag: "release-two",
    prerelease: false,
  });
  assert.notStrictEqual(r.status, 0, "accepted a non-semver tag");
});

test("F8  the manifest sync writes a Chrome-legal version", (box) => {
  // Chrome rejects a manifest whose version has a prerelease identifier, so the
  // numeric base goes in version and the full string in version_name.
  const pkg = path.join(box, "package.json");
  fs.mkdirSync(path.join(box, "chrome-extension"), { recursive: true });
  fs.mkdirSync(path.join(box, "scripts"), { recursive: true });
  fs.writeFileSync(pkg, JSON.stringify({ version: "3.4.5-beta.2" }));
  fs.writeFileSync(
    path.join(box, "chrome-extension", "manifest.json"),
    '{\n  "manifest_version": 3,\n  "version": "0.0.1",\n  "permissions": ["tabs"]\n}\n',
  );
  fs.copyFileSync(
    path.join(REPO, "scripts", "sync-manifest-version.js"),
    path.join(box, "scripts", "sync-manifest-version.js"),
  );
  const r = spawnSync(
    process.execPath,
    [path.join(box, "scripts", "sync-manifest-version.js")],
    { encoding: "utf8" },
  );
  assert.strictEqual(r.status, 0, r.stderr);
  const body = fs.readFileSync(
    path.join(box, "chrome-extension", "manifest.json"),
    "utf8",
  );
  const m = JSON.parse(body);
  assert.strictEqual(m.version, "3.4.5", "Chrome would reject this version");
  assert.strictEqual(m.version_name, "3.4.5-beta.2");
  assert.ok(/^\d+(\.\d+){0,3}$/.test(m.version), "version is not Chrome-legal");
  // Untouched keys keep their original formatting — a version bump should not
  // reformat the whole file.
  assert.ok(body.includes('"permissions": ["tabs"]'), `reformatted: ${body}`);
});

test("F9  syncing a stable version clears a stale prerelease label", (box) => {
  const pkg = path.join(box, "package.json");
  fs.mkdirSync(path.join(box, "chrome-extension"), { recursive: true });
  fs.mkdirSync(path.join(box, "scripts"), { recursive: true });
  fs.writeFileSync(pkg, JSON.stringify({ version: "3.4.5" }));
  fs.writeFileSync(
    path.join(box, "chrome-extension", "manifest.json"),
    '{\n  "version": "3.4.5",\n  "version_name": "3.4.5-beta.2",\n  "x": 1\n}\n',
  );
  fs.copyFileSync(
    path.join(REPO, "scripts", "sync-manifest-version.js"),
    path.join(box, "scripts", "sync-manifest-version.js"),
  );
  const r = spawnSync(
    process.execPath,
    [path.join(box, "scripts", "sync-manifest-version.js")],
    { encoding: "utf8" },
  );
  assert.strictEqual(r.status, 0, r.stderr);
  const m = JSON.parse(
    fs.readFileSync(path.join(box, "chrome-extension", "manifest.json"), "utf8"),
  );
  assert.strictEqual(m.version, "3.4.5");
  assert.strictEqual(
    m.version_name,
    undefined,
    "chrome://extensions would still show the beta label",
  );
});

test("F10  the repo's own version files agree right now", () => {
  // Catches drift on any PR, rather than at publish time when the tag exists.
  const r = spawnSync(
    process.execPath,
    [
      path.join(REPO, "scripts", "release-meta.js"),
      `v${JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version}`,
    ],
    { encoding: "utf8" },
  );
  assert.strictEqual(r.status, 0, r.stderr);
});

test("F11  the publish workflow gates on tests and resolves a channel", () => {
  const wf = fs.readFileSync(
    path.join(REPO, ".github", "workflows", "publish.yml"),
    "utf8",
  );
  assert.ok(/release-meta\.js/.test(wf), "publish never validates the version");
  assert.ok(/npm test/.test(wf), "publish is not gated on the test suite");
  assert.ok(/--tag "\$\{\{ steps\.meta\.outputs\.dist_tag \}\}"/.test(wf),
    "publish does not use the resolved dist-tag");
  assert.ok(/id-token: write/.test(wf), "provenance needs id-token: write");
  // A manual re-run exists to repair a half-finished release, so it must be
  // able to attach the zip too — gating that on the release event meant a
  // re-run could publish to npm and still leave the release empty.
  const attach = wf.slice(wf.indexOf("Attach extension zip"));
  assert.ok(
    !/if:\s*\$\{\{\s*github\.event_name == 'release'\s*\}\}/.test(attach.slice(0, 200)),
    "zip attach is still gated on the release event only",
  );
  assert.ok(
    /inputs\.tag/.test(attach.slice(0, 400)),
    "zip attach cannot resolve a tag on a manual re-run",
  );
  // A publish step that runs before the tests would defeat the gate.
  assert.ok(
    wf.indexOf("npm test") < wf.indexOf("npm publish"),
    "publish runs before the tests",
  );
});

group("G  update + skew checking");

const up = require(path.join(REPO, "mcp-server", "update-check.js"));

test("G1  version ordering follows semver, not string comparison", () => {
  const lt = (a, b) =>
    assert.ok(up.compareVersions(a, b) < 0, `expected ${a} < ${b}`);
  lt("1.0.0", "1.0.1");
  lt("1.9.0", "1.10.0"); // string compare gets this backwards
  lt("1.0.0", "2.0.0");
  lt("1.2.0-beta.1", "1.2.0"); // a release outranks its prereleases
  lt("1.2.0-alpha.1", "1.2.0-beta.1");
  lt("1.2.0-beta.2", "1.2.0-beta.10"); // numeric identifiers compare as numbers
  lt("1.2.0-beta", "1.2.0-beta.1"); // shorter prerelease ranks lower
  lt("1.2.0-1", "1.2.0-alpha"); // numeric ranks below alphanumeric
  assert.strictEqual(up.compareVersions("1.2.3", "v1.2.3"), 0, "v prefix");
  assert.strictEqual(up.compareVersions("2.0.0", "1.0.0"), 1);
});

test("G2  a prerelease is never told to downgrade to an older stable", () => {
  // The bug a naive check produces: on 1.2.0-beta.1 with latest 1.1.0, telling
  // the user to "update" would move them backwards.
  assert.ok(!up.isNewer("1.1.0", "1.2.0-beta.1"));
  assert.ok(up.isNewer("1.2.0", "1.2.0-beta.1"), "stable 1.2.0 is an upgrade");
});

test("G3  garbage versions compare equal instead of throwing", () => {
  for (const bad of [null, undefined, "", "next", "1", {}]) {
    assert.strictEqual(up.compareVersions(bad, "1.0.0"), 0, String(bad));
    assert.strictEqual(up.compareVersions("1.0.0", bad), 0, String(bad));
  }
});

test("G4  skew fires on a minor gap and stays quiet on a patch gap", () => {
  assert.strictEqual(up.skew("1.2.0", "1.2.3"), null, "patch gap is normal");
  assert.strictEqual(up.skew("1.2.0", "1.2.0"), null);
  const behind = up.skew("1.3.0", "1.2.0");
  assert.strictEqual(behind.kind, "extension-behind");
  const ahead = up.skew("1.2.0", "1.3.0");
  assert.strictEqual(ahead.kind, "server-behind");
  assert.strictEqual(up.skew("2.0.0", "1.0.0").kind, "extension-behind");
});

test("G5  no extension seen yet is not a skew warning", () => {
  // Before the extension ever connects there is nothing to disagree with, and
  // crying skew would make the warning meaningless.
  assert.strictEqual(up.skew("1.2.0", null), null);
  assert.strictEqual(up.skew("1.2.0", undefined), null);
  assert.strictEqual(up.skew("1.2.0", ""), null);
});

test("G6  the notice is silent when everything is current", () => {
  assert.strictEqual(
    up.notice({ current: "1.0.0", latest: "1.0.0", updateAvailable: false, skew: null }),
    null,
  );
});

test("G7  the notice names both problems when both apply", () => {
  const text = up.notice({
    current: "1.0.0",
    latest: "1.3.0",
    updateAvailable: true,
    skew: { kind: "extension-behind", server: "1.0.0", extension: "0.9.0" },
  });
  assert.match(text, /extension/i);
  assert.match(text, /1\.3\.0/);
  assert.match(text, /npm update -g poltertab/);
});

test("G8  extension state round-trips and reports last-seen", (box) => {
  assert.strictEqual(up.readExtensionState(box), null, "empty home");
  up.recordExtension(box, "1.4.2", 1000);
  const s = up.readExtensionState(box);
  assert.strictEqual(s.extensionVersion, "1.4.2");
  assert.strictEqual(s.seenAt, 1000);
});

test("G9  recording a missing version is a no-op, not a null write", (box) => {
  assert.strictEqual(up.recordExtension(box, null), false);
  assert.strictEqual(up.readExtensionState(box), null);
});

test("G10  a corrupt state file reads as absent rather than throwing", (box) => {
  fs.writeFileSync(path.join(box, up.STATE_FILE), "{not json");
  assert.strictEqual(up.readExtensionState(box), null);
});

test("G11  a fresh cache is reused without touching the network", async (box) => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw new Error("should not be called");
  };
  fs.writeFileSync(
    path.join(box, up.CACHE_FILE),
    JSON.stringify({ checkedAt: 5000, latest: "9.9.9" }),
  );
  const r = await up.checkForUpdate({
    current: "1.0.0",
    home: box,
    now: 5000 + 60_000,
    fetchImpl,
  });
  assert.strictEqual(calls, 0, "hit the network despite a fresh cache");
  assert.strictEqual(r.latest, "9.9.9");
  assert.ok(r.updateAvailable);
});

test("G12  a stale cache is refreshed and rewritten", async (box) => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ version: "2.0.0" }) });
  fs.writeFileSync(
    path.join(box, up.CACHE_FILE),
    JSON.stringify({ checkedAt: 0, latest: "1.0.0" }),
  );
  const r = await up.checkForUpdate({
    current: "1.0.0",
    home: box,
    now: 30 * 60 * 60 * 1000,
    fetchImpl,
  });
  assert.strictEqual(r.latest, "2.0.0");
  const onDisk = JSON.parse(fs.readFileSync(path.join(box, up.CACHE_FILE), "utf8"));
  assert.strictEqual(onDisk.latest, "2.0.0");
});

test("G13  a failed check is cached briefly, not permanently", async (box) => {
  // The package 404s until first publish. That must not wedge the check for a
  // full day, nor hammer the registry on every start.
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const r = await up.checkForUpdate({
    current: "1.0.0",
    home: box,
    now: 1_000_000,
    fetchImpl,
  });
  assert.strictEqual(r.latest, null);
  assert.strictEqual(r.updateAvailable, false);

  // Still inside the short failure TTL: no second request.
  let calls = 0;
  await up.checkForUpdate({
    current: "1.0.0",
    home: box,
    now: 1_000_000 + 60_000,
    fetchImpl: async () => {
      calls++;
      return { ok: false };
    },
  });
  assert.strictEqual(calls, 0, "retried inside the failure TTL");

  // Past it, it tries again rather than staying dark forever.
  await up.checkForUpdate({
    current: "1.0.0",
    home: box,
    now: 1_000_000 + 2 * 60 * 60 * 1000,
    fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => ({ version: "3.0.0" }) };
    },
  });
  assert.strictEqual(calls, 1, "never retried after the failure TTL expired");
});

test("G14  network failures and junk payloads resolve to null", async () => {
  const cases = [
    async () => {
      throw new Error("offline");
    },
    async () => ({ ok: true, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ version: "not-a-version" }) }),
    async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }),
    async () => null,
  ];
  for (const fetchImpl of cases) {
    assert.strictEqual(await up.fetchLatest("poltertab", fetchImpl), null);
  }
});

test("G15  POLTERTAB_NO_UPDATE_CHECK suppresses the network call", async (box) => {
  const prev = process.env.POLTERTAB_NO_UPDATE_CHECK;
  process.env.POLTERTAB_NO_UPDATE_CHECK = "1";
  try {
    let calls = 0;
    const r = await up.checkForUpdate({
      current: "1.0.0",
      home: box,
      now: 1,
      fetchImpl: async () => {
        calls++;
        return { ok: true, json: async () => ({ version: "9.9.9" }) };
      },
    });
    assert.ok(up.disabled(), "env var not respected");
    assert.strictEqual(calls, 0, "made a request while disabled");
    assert.strictEqual(r.updateAvailable, false);
  } finally {
    if (prev === undefined) delete process.env.POLTERTAB_NO_UPDATE_CHECK;
    else process.env.POLTERTAB_NO_UPDATE_CHECK = prev;
  }
});

test("G16  the fetch timeout stays well clear of a cold connection", () => {
  // Every test above injects a fake fetch, so all of them passed while the real
  // lookup failed 100% of the time: a cold TLS+DNS handshake to
  // registry.npmjs.org measured ~4s, and the timeout was 3s. Mocks cannot see
  // this, so the constant itself is what gets guarded.
  const src = fs.readFileSync(
    path.join(REPO, "mcp-server", "update-check.js"),
    "utf8",
  );
  const m = /FETCH_TIMEOUT_MS\s*=\s*(\d+)/.exec(src);
  assert.ok(m, "FETCH_TIMEOUT_MS is gone");
  assert.ok(
    Number(m[1]) >= 10000,
    `timeout ${m[1]}ms is too tight for a ~4s cold handshake`,
  );
});

test("G17  the server reports its real version, not a hardcoded one", () => {
  // serverInfo said "1.0.0" through every release, so the version a client
  // reported had nothing to do with what was installed.
  const src = fs.readFileSync(path.join(REPO, "mcp-server", "index.js"), "utf8");
  assert.ok(
    /version:\s*OWN_VERSION/.test(src),
    "serverInfo version is not read from package.json",
  );
  assert.ok(
    !/name:\s*"poltertab-browser-mcp",\s*\n\s*version:\s*"/.test(src),
    "serverInfo still has a hardcoded version string",
  );
});

test("G18  the server keeps the extension version it used to discard", () => {
  // The version handshake lives with the socket that carries it, in bridge.js.
  const src = fs.readFileSync(path.join(REPO, "mcp-server", "bridge.js"), "utf8");
  assert.ok(/recordExtension/.test(src), "extension version is never recorded");
  assert.ok(
    /extensionVersion = msg\.version/.test(src),
    "extension version is still dropped on the floor",
  );
});

test("G19  the notice is appended as its own block, once per process", () => {
  const src = fs.readFileSync(path.join(REPO, "mcp-server", "index.js"), "utf8");
  assert.ok(/noticeDelivered/.test(src), "no once-per-process guard");
  assert.ok(
    /content:\s*\[\.\.\.result\.content/.test(src),
    "notice does not append to the existing content array",
  );
});

test("G20  doctor runs with no server, no network, and no state", async (box) => {
  // The state someone is actually in when they reach for doctor.
  const { spawnSync } = require("child_process");
  const r = spawnSync(
    process.execPath,
    [path.join(REPO, "bin", "poltertab.js"), "doctor", "--port", "7999"],
    {
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        POLTERTAB_HOME: box,
        POLTERTAB_NO_UPDATE_CHECK: "1",
      },
    },
  );
  assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /server/, "no server line");
  assert.match(r.stdout, /extension/, "no extension line");
  assert.match(r.stdout, /nothing on port 7999/, "did not probe the port");
});

test("G21  doctor exits non-zero on skew so a script can act on it", async (box) => {
  const { spawnSync } = require("child_process");
  const own = JSON.parse(
    fs.readFileSync(path.join(REPO, "package.json"), "utf8"),
  ).version;
  // Seed a last-seen extension a major version behind whatever is installed.
  const behind = `${Number(own.split(".")[0]) + 1}.0.0`;
  up.recordExtension(box, "0.0.1", Date.now());
  const r = spawnSync(
    process.execPath,
    [path.join(REPO, "bin", "poltertab.js"), "doctor", "--port", "7999"],
    {
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        POLTERTAB_HOME: box,
        POLTERTAB_NO_UPDATE_CHECK: "1",
      },
    },
  );
  assert.strictEqual(r.status, 1, `expected 1 on skew, got ${r.status}`);
  assert.match(r.stdout, /SKEW/);
  assert.ok(behind, "guard against an unused-var lint");
});

chain.then(() => {
  console.log(
    `\n${pass} passed, ${failures.length} failed` +
      (failures.length ? `\n  ${failures.join("\n  ")}` : "") +
      "\n",
  );
  process.exit(failures.length ? 1 : 0);
});
