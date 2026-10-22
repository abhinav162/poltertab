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

// Guard: no test in this suite may reach the network. Individual tests that
// need a fetch inject their own fetchImpl directly; nothing here should hit
// the wire.
//
// Block globalThis.fetch (undici, used by run()/checkForUpdate).
globalThis.fetch = async (url) => {
  throw new Error(`LIVE FETCH BLOCKED — inject fetchImpl in the test (url: ${url})`);
};

// Also guard https.get/https.request and http.get/http.request — _cwsFetch
// uses https.get (not globalThis.fetch), so the globalThis.fetch guard above
// does not cover it. Scope the block to NON-loopback hosts only: the in-process
// pairing tests (group I, "Ctrl-C in a real terminal") dial a real ws server on
// 127.0.0.1, and ws's client handshake goes through http(s).request — blocking
// loopback would break those. Real hosts (clients2.google.com,
// registry.npmjs.org) still throw, preserving the suite's zero-live-call
// guarantee. Patching the module object works because Node caches require() and
// both this file and update-check.js hold a reference to the same object.
{
  const _https = require("https");
  const _http = require("http");
  const _isLoopback = (h) => {
    if (!h) return false;
    let host = String(h).toLowerCase();
    if (host.startsWith("[")) host = host.slice(1).split("]")[0]; // [::1]:p -> ::1
    else if (host.includes(":") && !host.includes("::")) host = host.split(":")[0]; // h:port -> h
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  };
  const _hostOf = (arg) => {
    try {
      if (typeof arg === "string") return new URL(arg).hostname;
      if (arg instanceof URL) return arg.hostname;
      if (arg && typeof arg === "object") return arg.hostname || arg.host || null;
    } catch (_) { /* fall through */ }
    return null;
  };
  for (const [_mod, _label] of [[_https, "HTTPS"], [_http, "HTTP"]]) {
    for (const _method of ["get", "request"]) {
      const _real = _mod[_method].bind(_mod);
      _mod[_method] = (...args) => {
        const host = _hostOf(args[0]);
        if (_isLoopback(host)) return _real(...args);
        throw new Error(
          `LIVE ${_label}.${_method.toUpperCase()} BLOCKED — inject fetchImpl in the test (host: ${host}, arg: ${args[0]})`,
        );
      };
    }
  }
}

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
      if (err && err.code === "SKIP") {
        // A test that cannot run in this environment (e.g. no loopback port
        // binding in the sandbox) reports SKIP, not PASS — a silent return
        // would otherwise be counted as a pass it never earned.
        console.log(`  SKIP  ${name} (${err.message})`);
      } else {
        console.log(`  FAIL  ${name}\n          ${err.message.split("\n")[0]}`);
        failures.push(name);
      }
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

// ── H. setup folder prompt ────────────────────────────────────────────────────
group("H  setup folder prompt");

test("H1  setup.js imports addAllowlistEntry and validateAllowlistEntry", () => {
  const src = fs.readFileSync(path.join(REPO, "bin", "setup.js"), "utf8");
  assert.ok(src.includes("addAllowlistEntry"), "setup.js must import addAllowlistEntry");
  assert.ok(src.includes("validateAllowlistEntry"), "setup.js must import validateAllowlistEntry");
});

test("H2  setup.js contains the spec-compliant folder prompt text", () => {
  const src = fs.readFileSync(path.join(REPO, "bin", "setup.js"), "utf8");
  assert.ok(
    src.includes("Let agents upload files from a folder?"),
    "setup.js must contain the exact prompt text",
  );
  assert.ok(src.includes("uploads folder"), "setup.js must contain 'uploads folder' label");
  assert.ok(
    !src.includes("rl2"),
    "setup.js must NOT open a second readline (rl2) — reuse the wizard's rl",
  );
});

test("H3  runFolderPrompt with Enter adds ~/Downloads", async (box) => {
  const mockRl = { question(_q, cb) { cb(""); }, close() {} };
  let addedPath = null;
  const addFn = (p) => { addedPath = p; return true; };
  const validateFn = () => ({ ok: true });

  await setup.runFolderPrompt(mockRl, { homeDir: box, addFn, validateFn });

  assert.strictEqual(addedPath, setup.DEFAULT_UPLOAD_FOLDER,
    "Enter must add ~/Downloads, not skip");
});

test("H4  addAllowlistEntry writes folder to config in isolated home", (box) => {
  // Clear module cache so uploads-config.js re-reads POLTERTAB_HOME fresh.
  const configKey = require.resolve(path.join(REPO, "mcp-server", "config.js"));
  const ucKey = require.resolve(path.join(REPO, "mcp-server", "uploads-config.js"));
  delete require.cache[configKey];
  delete require.cache[ucKey];

  const origHome = process.env.POLTERTAB_HOME;
  process.env.POLTERTAB_HOME = box;
  try {
    const { addAllowlistEntry } = require(path.join(REPO, "mcp-server", "uploads-config.js"));
    const added = addAllowlistEntry(box);
    assert.ok(added, "addAllowlistEntry must return true for a new entry");

    const cfgPath = path.join(box, "config.json");
    assert.ok(fs.existsSync(cfgPath), "config.json must be written");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.ok((cfg.upload_allowed_paths || []).includes(box), "config.json must contain the folder");
  } finally {
    if (origHome !== undefined) process.env.POLTERTAB_HOME = origHome;
    else delete process.env.POLTERTAB_HOME;
    // Restore module cache state so later tests use the suite-wide HOME.
    delete require.cache[configKey];
    delete require.cache[ucKey];
  }
});

test("H5  runFolderPrompt with invalid path shows warning and does not add", async (box) => {
  let consoleOut = "";
  const origLog = console.log;
  console.log = (...args) => { consoleOut += args.join(" ") + "\n"; };

  // Provide 3 bad inputs (initial + 2 retries) so the loop exhausts and skips.
  const inputs = ["../relative", "../also-bad", "../still-bad"];
  let idx = 0;
  const mockRl = { question(_q, cb) { cb(inputs[idx++] || ""); }, close() {} };
  let addFnCalled = false;
  const addFn = () => { addFnCalled = true; return true; };
  const validateFn = (p) => (
    p.startsWith("/") || p.startsWith("~/")
      ? { ok: true }
      : { ok: false, errorText: "must be an absolute path or ~/..." }
  );

  try {
    await setup.runFolderPrompt(mockRl, { homeDir: box, addFn, validateFn });
  } finally {
    console.log = origLog;
  }

  assert.ok(!addFnCalled, "addFn must not be called on invalid path");
  assert.ok(
    consoleOut.includes("uploads skipped"),
    `expected skip message, got: ${consoleOut}`,
  );
});

test("H6  addAllowlistEntry with duplicate path is idempotent (returns false)", (box) => {
  const configKey = require.resolve(path.join(REPO, "mcp-server", "config.js"));
  const ucKey = require.resolve(path.join(REPO, "mcp-server", "uploads-config.js"));
  delete require.cache[configKey];
  delete require.cache[ucKey];

  const origHome = process.env.POLTERTAB_HOME;
  process.env.POLTERTAB_HOME = box;
  try {
    const { addAllowlistEntry } = require(path.join(REPO, "mcp-server", "uploads-config.js"));
    const first = addAllowlistEntry(box);
    const second = addAllowlistEntry(box);
    assert.ok(first, "first add must return true");
    assert.ok(!second, "duplicate add must return false (already present)");

    // Exactly one entry in the config.
    const cfg = JSON.parse(fs.readFileSync(path.join(box, "config.json"), "utf8"));
    const hits = (cfg.upload_allowed_paths || []).filter((e) => e === box);
    assert.strictEqual(hits.length, 1, "duplicate must not double-add the entry");
  } finally {
    if (origHome !== undefined) process.env.POLTERTAB_HOME = origHome;
    else delete process.env.POLTERTAB_HOME;
    delete require.cache[configKey];
    delete require.cache[ucKey];
  }
});

test("H7  ~/Downloads is never inside buildAlwaysBlocked", (box) => {
  const { buildAlwaysBlocked, validateAllowlistEntry } = require(
    path.join(REPO, "mcp-server", "upload-paths.js"),
  );
  const blocked = buildAlwaysBlocked(box);
  const expanded = path.join(box, "Downloads");
  const directlyBlocked = blocked.some(
    (b) => expanded === b || expanded.startsWith(b + path.sep),
  );
  assert.ok(!directlyBlocked, `~/Downloads is inside buildAlwaysBlocked: ${blocked}`);
  // Also verify the validator accepts it.
  const v = validateAllowlistEntry(setup.DEFAULT_UPLOAD_FOLDER, box);
  assert.ok(v.ok, `validateAllowlistEntry("~/Downloads") returned not ok: ${v.errorText}`);
});

test("H8  runFolderPrompt Enter prints the ✓ uploads folder line", async (box) => {
  let consoleOut = "";
  const origLog = console.log;
  console.log = (...args) => { consoleOut += args.join(" ") + "\n"; };

  const mockRl = { question(_q, cb) { cb(""); }, close() {} };
  const addFn = () => true;
  const validateFn = () => ({ ok: true });

  try {
    await setup.runFolderPrompt(mockRl, { homeDir: box, addFn, validateFn });
  } finally {
    console.log = origLog;
  }

  assert.ok(
    consoleOut.includes("uploads folder") && consoleOut.includes("~/Downloads"),
    `expected ✓ uploads folder ~/Downloads, got: ${consoleOut}`,
  );
  assert.ok(!consoleOut.includes("skipped"), "must not print skip on Enter");
});

test("H9  runFolderPrompt n skips with the spec-required message", async (box) => {
  let consoleOut = "";
  const origLog = console.log;
  console.log = (...args) => { consoleOut += args.join(" ") + "\n"; };

  const mockRl = { question(_q, cb) { cb("n"); }, close() {} };
  let addFnCalled = false;
  const addFn = () => { addFnCalled = true; return true; };
  const validateFn = () => ({ ok: true });

  try {
    await setup.runFolderPrompt(mockRl, { homeDir: box, addFn, validateFn });
  } finally {
    console.log = origLog;
  }

  assert.ok(!addFnCalled, "addFn must not be called when user types n");
  assert.ok(
    consoleOut.includes("uploads skipped") && consoleOut.includes("poltertab uploads allow"),
    `expected skip + hint, got: ${consoleOut}`,
  );
});

test("H10  runFolderPrompt already-present prints (already set)", async (box) => {
  let consoleOut = "";
  const origLog = console.log;
  console.log = (...args) => { consoleOut += args.join(" ") + "\n"; };

  const mockRl = { question(_q, cb) { cb(""); }, close() {} };
  const addFn = () => false;  // false = already present
  const validateFn = () => ({ ok: true });

  try {
    await setup.runFolderPrompt(mockRl, { homeDir: box, addFn, validateFn });
  } finally {
    console.log = origLog;
  }

  assert.ok(
    consoleOut.includes("already set"),
    `expected "(already set)" in output, got: ${consoleOut}`,
  );
});

test("H11  runFolderPrompt invalid path re-asks up to 2 times then skips", async (box) => {
  let consoleOut = "";
  const origLog = console.log;
  console.log = (...args) => { consoleOut += args.join(" ") + "\n"; };

  let askCount = 0;
  const mockRl = { question(_q, cb) { askCount++; cb("../bad"); }, close() {} };
  let addFnCalled = false;
  const addFn = () => { addFnCalled = true; return true; };
  const validateFn = () => ({ ok: false, errorText: "must be absolute" });

  try {
    await setup.runFolderPrompt(mockRl, { homeDir: box, addFn, validateFn });
  } finally {
    console.log = origLog;
  }

  assert.ok(!addFnCalled, "addFn must not be called on repeated invalid paths");
  // Initial ask + 2 retries = 3 total calls to question, then skip.
  assert.ok(askCount <= 3, `asked ${askCount} times — should stop after 2 retries`);
  assert.ok(
    consoleOut.includes("uploads skipped"),
    `expected final skip message, got: ${consoleOut}`,
  );
});

test("H12  non-TTY run skips the pairing step silently", async (box) => {
  let consoleOut = "";
  const origLog = console.log;
  console.log = (...args) => { consoleOut += args.join(" ") + "\n"; };

  // Inject a mock so the Store version lookup doesn't reach https.get.
  const fetchImpl = async () => null;
  try {
    await setup.run(["--global"], { home: box, cwd: box, isTTY: false, fetchImpl });
  } finally {
    console.log = origLog;
  }

  assert.ok(!consoleOut.includes("paired"), "paired must not appear in non-TTY output");
  assert.ok(
    !consoleOut.includes("waiting for the extension"),
    "pairing listener must not start in non-TTY mode",
  );
});

test("H13  runSetupPairingStep with skipped pairFlow prints skip message", async () => {
  let consoleOut = "";
  const origLog = console.log;
  console.log = (...args) => { consoleOut += args.join(" ") + "\n"; };

  const mockRl = { question(_q, cb) { cb(""); }, close() {} };
  const mockPairFlow = async () => ({ ok: false, reason: "skipped" });
  // runSetupPairingStep calls storeExtensionNote unconditionally before pairFlow,
  // so fetchImpl must be injected to keep the lookup off the live network.
  const fetchImpl = async () => null;

  try {
    await setup.runSetupPairingStep(mockRl, { pairFlow: mockPairFlow, fetchImpl });
  } finally {
    console.log = origLog;
  }

  assert.ok(
    consoleOut.includes("pairing skipped"),
    `expected "pairing skipped", got: ${consoleOut}`,
  );
});

test("H14  runSetupPairingStep success shows first 8 chars of extension id", async () => {
  let consoleOut = "";
  const origLog = console.log;
  console.log = (...args) => { consoleOut += args.join(" ") + "\n"; };

  const mockRl = { question(_q, cb) { cb(""); }, close() {} };
  const fakeId = "abcdef1234567890abcdef1234567890";
  const mockPairFlow = async () => ({ ok: true, extensionId: fakeId });
  // Inject a failing fetch so the Store version lookup does not go to the network.
  const fetchImpl = async () => { throw new Error("no network in tests"); };

  try {
    await setup.runSetupPairingStep(mockRl, { pairFlow: mockPairFlow, fetchImpl });
  } finally {
    console.log = origLog;
  }

  assert.ok(
    consoleOut.includes("abcdef12"),
    `expected first 8 chars "abcdef12" in output, got: ${consoleOut}`,
  );
  assert.ok(
    consoleOut.includes("paired"),
    `expected "paired" in output, got: ${consoleOut}`,
  );
});

// --- I  Ctrl-C in a real terminal ------------------------------------------
//
// readline puts a TTY in raw mode, so Ctrl-C arrives as a keypress, not as a
// SIGINT. Without a readline SIGINT handler the interface just closes: a prompt
// exits 0 as if setup had finished, and the pairing wait hangs until its 5-minute
// idle timeout. Only a real pseudo-terminal reproduces that, so these cases drive
// the CLI through python3's pty module (skipped where it is unavailable).

const { spawn } = require("child_process");
const net = require("net");

const PTY_DRIVER = String.raw`
import os, pty, sys, json, time, re, select, termios, signal
cfg = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cfg["cwd"]); os.execvpe(cfg["cmd"][0], cfg["cmd"], cfg["env"])
buf = b""
def read(t):
    global buf
    r, _, _ = select.select([fd], [], [], t)
    if not r: return None
    try: d = os.read(fd, 4096)
    except OSError: return False
    if not d: return False
    buf += d
    return True
t_send = None; status = None; t_exit = None
for wait, send in cfg["steps"]:
    end = time.time() + 15
    while not re.search(wait.encode(), buf) and time.time() < end:
        if read(0.1) is False: break
    if not re.search(wait.encode(), buf): break
    time.sleep(0.3)
    os.write(fd, send.encode()); t_send = time.time()
end = time.time() + cfg["exitTimeout"]
while time.time() < end:
    p, st = os.waitpid(pid, os.WNOHANG)
    if p: status = st; t_exit = time.time(); break
    read(0.05)
while read(0.05): pass
a = termios.tcgetattr(fd)
res = {"output": buf.decode("utf8", "replace"), "exited": status is not None,
       "icanon": bool(a[3] & termios.ICANON), "echo": bool(a[3] & termios.ECHO)}
if status is None:
    os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
else:
    res["code"] = os.WEXITSTATUS(status) if os.WIFEXITED(status) else None
    res["secs"] = round(t_exit - t_send, 2) if t_send else None
print(json.dumps(res))
`;

const hasPty = process.platform !== "win32" &&
  spawnSync("python3", ["-c", "import pty, termios"]).status === 0;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
      .once("error", () => resolve(false))
      .listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

// Runs `poltertab <args>` in a pty under a throwaway HOME, with a stub `claude`
// on PATH so registerServer never touches the real Claude config. steps are
// [promptRegex, keys] pairs; onPrompt runs when a step's prompt shows up.
async function runInPty(box, args, steps, { port, during } = {}) {
  const bin = path.join(box, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: box,
    POLTERTAB_HOME: path.join(box, ".poltertab"),
    MCP_BROWSER_WS_PORT: String(port),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    TERM: "xterm",
    POLTERTAB_NO_UPDATE_CHECK: "1",
  };
  for (const k of ["NO_COLOR", "FORCE_COLOR", "CLAUDE_CONFIG_DIR"]) delete env[k];
  const cfg = {
    cmd: [process.execPath, path.join(REPO, "bin", "poltertab.js"), ...args],
    cwd: box, env, steps, exitTimeout: 3,
  };
  const child = spawn("python3", ["-c", PTY_DRIVER, JSON.stringify(cfg)]);
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  if (during) await during();
  await new Promise((resolve) => child.on("close", resolve));
  const res = JSON.parse(out);
  res.text = res.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return res;
}

function assertCancelled(res, port, free) {
  const tail = res.text.trim().split(/\r?\n/).slice(-3).join(" | ");
  assert.ok(res.exited, `still running 3 s after the key; last output: ${tail}`);
  assert.strictEqual(res.code, 130, `exit code ${res.code}, want 130; last output: ${tail}`);
  assert.ok(/Cancelled\./.test(res.text), `no "Cancelled." line; last output: ${tail}`);
  assert.ok(res.icanon && res.echo, "terminal left in raw mode (ICANON/ECHO off)");
  assert.ok(free, `port ${port} is still bound after exit`);
}

// A pairing promise that never settles would otherwise park the suite until the
// 5-minute idle timeout.
function within(ms, promise, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} did not settle in ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

function ptyTest(name, fn) {
  if (hasPty) return test(name, fn);
  chain = chain.then(() => console.log(`  SKIP  ${name} (no python3 pty)`));
}

group("I  Ctrl-C in a real terminal");

ptyTest("I1  Ctrl-C at the scope prompt cancels with exit 130", async (box) => {
  const port = await freePort();
  const res = await runInPty(box, ["setup"], [["Choose \\[1\\]: ", "\x03"]], { port });
  assertCancelled(res, port, await portIsFree(port));
});

ptyTest("I2  Ctrl-C at the uploads-folder prompt cancels with exit 130", async (box) => {
  const port = await freePort();
  const res = await runInPty(box, ["setup", "--global"], [["  > ", "\x03"]], { port });
  assertCancelled(res, port, await portIsFree(port));
  assert.ok(!/uploads folder skipped/.test(res.text), "a cancel is not a skipped step");
});

ptyTest("I3  Ctrl-C while waiting for the extension cancels and frees the port", async (box) => {
  const port = await freePort();
  const res = await runInPty(box, ["setup", "--global"],
    [["  > ", "n\r"], ["waiting for the extension to connect", "\x03"]], { port });
  assertCancelled(res, port, await portIsFree(port));
  assert.ok(!/pairing skipped/.test(res.text), "a cancel must not report the step as skipped");
});

ptyTest("I4  Ctrl-C at the pairing-code prompt cancels and frees the port", async (box) => {
  const WebSocket = require(path.join(REPO, "node_modules", "ws"));
  const port = await freePort();
  let ext = null;
  const res = await runInPty(box, ["setup", "--global"],
    [["  > ", "n\r"], ["Code \\(Enter to skip\\): ", "\x03"]], {
      port,
      // Play the extension: dial the temp listener once it is up and say hello.
      during: async () => {
        for (let i = 0; i < 100 && !ext; i++) {
          await new Promise((r) => setTimeout(r, 100));
          ext = await new Promise((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://i4test" });
            ws.on("open", () => { ws.send(JSON.stringify({ type: "extension_ready", version: "test" })); resolve(ws); });
            ws.on("error", () => resolve(null));
          });
        }
      },
    });
  if (ext) ext.terminate();
  assert.ok(ext, "fake extension never reached the temp listener");
  assertCancelled(res, port, await portIsFree(port));
});

ptyTest("I5  Ctrl-C while `uploads pair` waits cancels with exit 130", async (box) => {
  const port = await freePort();
  const res = await runInPty(box, ["uploads", "pair"],
    [["waiting for the extension to connect", "\x03"]], { port });
  assertCancelled(res, port, await portIsFree(port));
});

// Ctrl-D on an empty line is EOF: readline closes the interface, which left the
// same traps as Ctrl-C (a prompt exiting 0, the extension wait hanging). It is
// treated as a cancel too: "Cancelled.", exit 130.
const EOF_CASES = [
  ["I9 ", "scope prompt", ["setup"], [["Choose \\[1\\]: ", "\x04"]]],
  ["I10", "uploads-folder prompt", ["setup", "--global"], [["  > ", "\x04"]]],
  ["I11", "extension wait", ["setup", "--global"], [["  > ", "n\r"], ["waiting for the extension to connect", "\x04"]]],
  ["I13", "`uploads pair` wait", ["uploads", "pair"], [["waiting for the extension to connect", "\x04"]]],
];
for (const [id, where, args, steps] of EOF_CASES) {
  ptyTest(`${id}  Ctrl-D at the ${where} cancels with exit 130`, async (box) => {
    const port = await freePort();
    const res = await runInPty(box, args, steps, { port });
    assertCancelled(res, port, await portIsFree(port));
  });
}

ptyTest("I12  Ctrl-D at the pairing-code prompt cancels and frees the port", async (box) => {
  const WebSocket = require(path.join(REPO, "node_modules", "ws"));
  const port = await freePort();
  let ext = null;
  const res = await runInPty(box, ["setup", "--global"],
    [["  > ", "n\r"], ["Code \\(Enter to skip\\): ", "\x04"]], {
      port,
      during: async () => {
        for (let i = 0; i < 100 && !ext; i++) {
          await new Promise((r) => setTimeout(r, 100));
          ext = await new Promise((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://i12test" });
            ws.on("open", () => { ws.send(JSON.stringify({ type: "extension_ready", version: "test" })); resolve(ws); });
            ws.on("error", () => resolve(null));
          });
        }
      },
    });
  if (ext) ext.terminate();
  assert.ok(ext, "fake extension never reached the temp listener");
  assertCancelled(res, port, await portIsFree(port));
});

test("I14  readline closing (EOF) cancels the temp listener and drops its hooks", async () => {
  const { EventEmitter } = require("events");
  const { pairViaTempListener } = require(path.join(REPO, "bin", "pair-flow.js"));
  const port = await freePort();
  const rl = Object.assign(new EventEmitter(), { question() {}, close() {} });
  const pending = pairViaTempListener(port, rl);
  await new Promise((r) => setTimeout(r, 50));
  rl.emit("close");
  assert.deepStrictEqual(await within(2000, pending, "temp listener after EOF"), { ok: false, reason: "cancelled" });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(await portIsFree(port), "temp listener still bound after EOF");
  assert.strictEqual(rl.listenerCount("close"), 0, "readline close hook left behind");
});

ptyTest("I15  answering every prompt still finishes with exit 0 and no cancel", async (box) => {
  const WebSocket = require(path.join(REPO, "node_modules", "ws"));
  const port = await freePort();
  let ext = null;
  const res = await runInPty(box, ["setup"],
    [["Choose \\[1\\]: ", "1\r"], ["  > ", "n\r"], ["Code \\(Enter to skip\\): ", "\r"]], {
      port,
      during: async () => {
        for (let i = 0; i < 100 && !ext; i++) {
          await new Promise((r) => setTimeout(r, 100));
          ext = await new Promise((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://i15test" });
            ws.on("open", () => { ws.send(JSON.stringify({ type: "extension_ready", version: "test" })); resolve(ws); });
            ws.on("error", () => resolve(null));
          });
        }
      },
    });
  if (ext) ext.terminate();
  assert.ok(res.exited, "setup did not finish");
  assert.strictEqual(res.code, 0, `exit code ${res.code}`);
  assert.ok(/pairing skipped/.test(res.text), "expected the skip line");
  assert.ok(!/Cancelled\./.test(res.text), "closing readline at the end must not read as a cancel");
  assert.ok(res.icanon && res.echo, "terminal left in raw mode");
  assert.ok(await portIsFree(port), "temp listener still bound");
});

test("I6  a Ctrl-C on the temp listener closes it and drops its SIGINT hooks", async () => {
  const { EventEmitter } = require("events");
  const { pairViaTempListener } = require(path.join(REPO, "bin", "pair-flow.js"));
  const port = await freePort();
  const rl = Object.assign(new EventEmitter(), { question() {}, close() {} });
  const before = process.listenerCount("SIGINT");
  const pending = pairViaTempListener(port, rl);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(rl.listenerCount("SIGINT"), 1, "listener must hook readline's SIGINT");
  rl.emit("SIGINT");
  const result = await within(2000, pending, "temp listener after Ctrl-C");
  assert.deepStrictEqual(result, { ok: false, reason: "cancelled" });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(await portIsFree(port), "temp listener still bound after cancel");
  assert.strictEqual(rl.listenerCount("SIGINT"), 0, "readline SIGINT hook left behind");
  assert.strictEqual(process.listenerCount("SIGINT"), before, "process SIGINT hook left behind");
});

test("I7  a Ctrl-C while paired through a running server closes that socket", async () => {
  const { EventEmitter } = require("events");
  const { pairViaRunningServer } = require(path.join(REPO, "bin", "pair-flow.js"));
  let closed = false;
  const ws = Object.assign(new EventEmitter(), { send() {}, close() { closed = true; } });
  const rl = Object.assign(new EventEmitter(), { question() {}, close() {} });
  const before = process.listenerCount("SIGINT");
  const pending = pairViaRunningServer(ws, rl);
  rl.emit("SIGINT");
  assert.deepStrictEqual(await within(2000, pending, "running-server pairing after Ctrl-C"), { ok: false, reason: "cancelled" });
  assert.ok(closed, "server socket left open");
  assert.strictEqual(rl.listenerCount("SIGINT"), 0, "readline SIGINT hook left behind");
  assert.strictEqual(process.listenerCount("SIGINT"), before, "process SIGINT hook left behind");
});

test("I8  a pairing that ends normally leaves no SIGINT hook behind", async () => {
  const { EventEmitter } = require("events");
  const { pairViaRunningServer } = require(path.join(REPO, "bin", "pair-flow.js"));
  const ws = Object.assign(new EventEmitter(), { send() {}, close() {} });
  const rl = Object.assign(new EventEmitter(), { question(_q, cb) { cb(""); }, close() {} });
  const before = process.listenerCount("SIGINT");
  assert.deepStrictEqual(await pairViaRunningServer(ws, rl), { ok: false, reason: "skipped" });
  assert.strictEqual(process.listenerCount("SIGINT"), before, "process SIGINT hook left behind");
});

group("J  Store extension link");

test("J1  fetchStoreCwsVersion parses the version from CWS XML response", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app><updatecheck status="ok" version="1.10.0"/></app></gupdate>`;
  const fetchImpl = async () => ({ ok: true, text: async () => xml });
  const v = await up.fetchStoreCwsVersion(fetchImpl);
  assert.strictEqual(v, "1.10.0", `got ${v}`);
});

test("J2  fetchStoreCwsVersion returns null on network error", async () => {
  const fetchImpl = async () => { throw new Error("offline"); };
  assert.strictEqual(await up.fetchStoreCwsVersion(fetchImpl), null);
});

test("J3  fetchStoreCwsVersion returns null on non-ok response", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, text: async () => "" });
  assert.strictEqual(await up.fetchStoreCwsVersion(fetchImpl), null);
});

test("J4  fetchStoreCwsVersion returns null when update-check is opted out", async () => {
  const prev = process.env.POLTERTAB_NO_UPDATE_CHECK;
  process.env.POLTERTAB_NO_UPDATE_CHECK = "1";
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, text: async () => "" }; };
  try {
    const v = await up.fetchStoreCwsVersion(fetchImpl);
    assert.strictEqual(v, null);
    assert.ok(!called, "fetch was called despite opt-out");
  } finally {
    if (prev === undefined) delete process.env.POLTERTAB_NO_UPDATE_CHECK;
    else process.env.POLTERTAB_NO_UPDATE_CHECK = prev;
  }
});

test("J5  fetchStoreCwsVersion returns null on malformed XML (no version attr)", async () => {
  const xml = `<?xml version="1.0"?><gupdate><app><updatecheck status="noupdate"/></app></gupdate>`;
  const fetchImpl = async () => ({ ok: true, text: async () => xml });
  assert.strictEqual(await up.fetchStoreCwsVersion(fetchImpl), null);
});

test("J5b fetchStoreCwsVersion returns null on app status=error (no x.y.z version attr)", async () => {
  const xml = `<?xml version="1.0"?><gupdate><app><updatecheck status="error-unknownApplication"/></app></gupdate>`;
  const fetchImpl = async () => ({ ok: true, text: async () => xml });
  assert.strictEqual(await up.fetchStoreCwsVersion(fetchImpl), null);
});

test("J6  storeExtensionNote compatible: Store version same major.minor as server", async () => {
  const xml = `<updatecheck version="1.10.1"/>`;
  const fetchImpl = async () => ({ ok: true, text: async () => xml });
  const lines = await setup.storeExtensionNote({ serverVersion: "1.10.0", fetchImpl });
  const text = lines.join("\n");
  assert.ok(text.includes("recommended"), `missing 'recommended': ${text}`);
  assert.ok(text.includes(setup.CWS_STORE_URL), `missing Store URL: ${text}`);
  assert.ok(text.includes("load unpacked"), `missing 'load unpacked': ${text}`);
  // Store should come before GitHub in compatible case
  assert.ok(
    text.indexOf(setup.CWS_STORE_URL) < text.indexOf("github.com"),
    "Store URL should appear before GitHub URL in compatible case",
  );
});

test("J7  storeExtensionNote Store older / extension-behind: GitHub first with reason", async () => {
  const xml = `<updatecheck version="1.9.0"/>`;
  const fetchImpl = async () => ({ ok: true, text: async () => xml });
  const lines = await setup.storeExtensionNote({ serverVersion: "1.10.0", fetchImpl });
  const text = lines.join("\n");
  assert.ok(text.includes("github.com"), `missing GitHub URL: ${text}`);
  assert.ok(text.includes("1.9.0"), `missing Store version in reason: ${text}`);
  assert.ok(text.includes("1.10.0"), `missing server version in reason: ${text}`);
  assert.ok(text.includes("1.10.x"), `missing 1.10.x in reason: ${text}`);
  // GitHub should come before Store in incompatible case
  assert.ok(
    text.indexOf("github.com") < text.indexOf(setup.CWS_STORE_URL),
    "GitHub URL should appear before Store URL in incompatible case",
  );
});

test("J8  storeExtensionNote Store newer / server-behind: GitHub first with reason", async () => {
  const xml = `<updatecheck version="1.11.0"/>`;
  const fetchImpl = async () => ({ ok: true, text: async () => xml });
  const lines = await setup.storeExtensionNote({ serverVersion: "1.10.0", fetchImpl });
  const text = lines.join("\n");
  assert.ok(text.includes("github.com"), `missing GitHub URL: ${text}`);
  assert.ok(text.includes("1.11.0"), `missing Store version in reason: ${text}`);
  assert.ok(
    text.indexOf("github.com") < text.indexOf(setup.CWS_STORE_URL),
    "GitHub URL should appear before Store URL when server is behind",
  );
});

test("J9  storeExtensionNote network error: neutral note with both links", async () => {
  const fetchImpl = async () => { throw new Error("no network"); };
  const lines = await setup.storeExtensionNote({ serverVersion: "1.10.0", fetchImpl });
  const text = lines.join("\n");
  assert.ok(text.includes(setup.CWS_STORE_URL), `missing Store URL: ${text}`);
  assert.ok(text.includes("github.com"), `missing GitHub URL: ${text}`);
  assert.ok(text.includes("always matches"), `missing neutral note: ${text}`);
});

test("J10  non-TTY setup output includes both Store URL and GitHub release URL, compatible wording", async () => {
  let consoleOut = "";
  const origLog = console.log;
  console.log = (...args) => { consoleOut += args.join(" ") + "\n"; };

  // Inject a mock that returns the same major.minor as the installed version,
  // so the compatible ("recommended, updates itself") path is exercised.
  const pkgVersion = require(path.join(REPO, "package.json")).version;
  const xml = `<updatecheck version="${pkgVersion}"/>`;
  const fetchImpl = async () => ({ ok: true, text: async () => xml });

  try {
    await setup.run(["--global"], {
      home: fs.mkdtempSync(path.join(os.tmpdir(), "poltertab-i10-")),
      cwd: os.tmpdir(),
      isTTY: false,
      fetchImpl,
    });
  } finally {
    console.log = origLog;
  }

  assert.ok(consoleOut.includes(setup.CWS_STORE_URL), `missing Store URL in non-TTY output: ${consoleOut}`);
  assert.ok(consoleOut.includes("github.com"), `missing GitHub URL in non-TTY output: ${consoleOut}`);
  assert.ok(consoleOut.includes("recommended"), `expected compatible ("recommended") wording in non-TTY output: ${consoleOut}`);
});

test("J11  AbortController wiring: run() resolves within CWS timeout + margin", async () => {
  // Injects a mock fetchImpl that hangs until the AbortSignal fires, then
  // rejects with AbortError. Verifies that AbortController + CWS_TIMEOUT_MS
  // causes run() to resolve promptly — not that _cwsFetch or https exits promptly
  // (that is J12's job).
  const fetchImpl = (_url, { signal } = {}) =>
    new Promise((_resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort);
    });

  let consoleOut = "";
  const origLog = console.log;
  console.log = (...args) => { consoleOut += args.join(" ") + "\n"; };

  const start = Date.now();
  try {
    await setup.run(["--global"], {
      home: fs.mkdtempSync(path.join(os.tmpdir(), "poltertab-i11-")),
      cwd: os.tmpdir(),
      isTTY: false,
      fetchImpl,
    });
  } finally {
    console.log = origLog;
  }

  const elapsed = Date.now() - start;
  // CWS_TIMEOUT_MS is 5000; allow 1500 ms of margin for startup overhead.
  assert.ok(
    elapsed < 6500,
    `run() took ${elapsed}ms with a hung fetch; should resolve within ~5000ms + margin`,
  );
  assert.ok(
    consoleOut.includes(setup.CWS_STORE_URL),
    `timed-out fetch should produce the neutral note with Store URL: ${consoleOut}`,
  );
});

test("J12  _cwsFetch unref: process exits promptly after CWS timeout (child-process)", async () => {
  // Proves the F2 fix: _cwsFetch's socket.unref() + req.destroy() on abort
  // allows the process to exit as soon as the 5 s timer fires, with no lingering
  // https connection-pool or socket. Uses a real child process so there is no
  // escape from genuine handle leaks. Skips gracefully when port binding is
  // unavailable (sandbox environment).
  const net = require("net");
  const { spawn } = require("child_process");

  // Stalling TCP server: accepts connections, never sends data.
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const s = net.createServer(() => {});
      s.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
  } catch (_) {
    // port binding unavailable (sandbox) — report SKIP, not a silent PASS.
    throw Object.assign(new Error("no loopback port binding"), { code: "SKIP" });
  }

  const port = server.address().port;
  const updateCheckPath = path.join(REPO, "mcp-server", "update-check.js");

  // Child script: call _cwsFetch against the stalling server with a 5 s abort,
  // then let the process exit naturally. Tests that no handle lingers post-abort.
  const childScript = `
    const { _cwsFetch } = require(${JSON.stringify(updateCheckPath)});
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5000);
    _cwsFetch('https://127.0.0.1:${port}', { signal: ac.signal });
  `;

  const start = Date.now();
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`child did not exit within 6500 ms (lingering handle?)`)),
      6500,
    );
    const child = spawn(process.execPath, ["-e", childScript]);
    child.on("exit", () => { clearTimeout(deadline); resolve(); });
    child.on("error", (e) => { clearTimeout(deadline); reject(e); });
  });

  server.close();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 6500, `child process exited in ${elapsed} ms; expected < 6500 ms`);
});

chain.then(() => {
  console.log(
    `\n${pass} passed, ${failures.length} failed` +
      (failures.length ? `\n  ${failures.join("\n  ")}` : "") +
      "\n",
  );
  process.exit(failures.length ? 1 : 0);
});
