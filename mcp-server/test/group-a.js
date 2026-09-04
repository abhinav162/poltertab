const {
  EXT,
  REPO,
  SERVER,
  assert,
  fs,
  path,
  test,
  toolNames,
} = require("./harness.js");

// ───────────────────────── A. source invariants ─────────────────────────

async function groupA() {
  console.log("\nA. source invariants");

  await test("A1 manifest declares an options page that exists", () => {
    const m = JSON.parse(
      fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"),
    );
    const page = m.options_page || (m.options_ui && m.options_ui.page);
    assert.ok(page, "no options_page/options_ui — openOptionsPage() will throw");
    assert.ok(
      fs.existsSync(path.join(EXT, page)),
      `options page ${page} missing on disk`,
    );
  });

  await test("A2 mcp-server never writes to stdout (it is the JSON-RPC channel)", () => {
    const src = fs.readFileSync(SERVER, "utf8");
    const hits = src.split("\n").filter((l) => /(^|[^.\w])console\.log\(/.test(l));
    assert.strictEqual(
      hits.length,
      0,
      `console.log would corrupt the protocol stream: ${hits.join(" | ")}`,
    );
  });

  await test("A4 README documents every tool the server exposes, and no others", () => {
    const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
    const tools = toolNames().map((n) => `browser_${n}`);
    const mentioned = new Set(readme.match(/browser_[a-z_]+/g) || []);
    const undocumented = tools.filter((t) => !mentioned.has(t));
    assert.deepStrictEqual(undocumented, [], `undocumented tools: ${undocumented}`);
    const bogus = [...mentioned].filter((m) => !tools.includes(m));
    assert.deepStrictEqual(bogus, [], `README names non-existent tools: ${bogus}`);
  });

  await test("A7 the skill names the extraction tools, and no phantom ones", () => {
    // The skill is what an agent reads before working a site. New tools that
    // never reach it are new tools nobody uses: the agent takes the
    // flat-scrape-and-reassemble route these exist to replace.
    const skill = fs.readFileSync(
      path.join(REPO, "skills", "browser-navigation-strategy", "SKILL.md"),
      "utf8",
    );
    const tools = new Set(toolNames().map((n) => `browser_${n}`));
    const named = new Set(skill.match(/browser_[a-z_]+/g) || []);
    for (const must of ["browser_extract", "browser_extract_all"]) {
      assert.ok(named.has(must), `skill never mentions ${must}`);
    }
    const phantom = [...named].filter((n) => !tools.has(n));
    assert.deepStrictEqual(phantom, [], `skill names non-existent tools: ${phantom}`);
  });

  await test("A5 README does not claim the server exits on a busy port", () => {
    const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
    assert.ok(
      !/will exit with an `?EADDRINUSE/.test(readme),
      "stale claim: a busy port now means secondary mode, not an exit",
    );
  });

  await test("A6 snapshot descends into shadow roots so elements are discoverable", () => {
    const src = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");
    const walk = src.slice(src.indexOf("const walk = (el, depth)"));
    assert.ok(
      /shadowRootOf\(el\)/.test(walk.slice(0, 900)),
      "snapshot's walk no longer descends into shadow roots",
    );
  });

  // The action word is the contract between the MCP tool name, the server's
  // dispatch, background.js's route table and content_script's handler map —
  // four spellings in three files, in two runtimes, with nothing checking they
  // agree. A typo used to surface as "Unknown action: scrap" on a user's
  // machine, mid-scrape. These read the routes back out of the source.
  // Brace-match from the object's opening `{` so the block is found regardless
  // of how deeply it is nested, then take only the keys at its top level.
  const keysOf = (src, decl) => {
    const start = src.indexOf(decl);
    assert.notStrictEqual(start, -1, `${decl} not found`);
    let i = start + decl.length - 1; // sits on the `{`
    let depth = 0;
    const from = i + 1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    assert.ok(depth === 0, `unbalanced braces in ${decl}`);
    const body = src.slice(from, i);
    // [ \t] not \s — \s would eat the leading newline into the indent.
    const indent = /^([ \t]*)\S/m.exec(body)[1];
    const keys = new Set(
      [...body.matchAll(new RegExp(`^${indent}(\\w+)\\s*[,:]`, "gm"))].map(
        (m) => m[1],
      ),
    );
    assert.ok(keys.size > 0, `parsed no keys out of ${decl}`);
    return keys;
  };

  // Tools this process answers itself; they never reach the extension, so
  // background.js must not be expected to route them. Adding a tool here is a
  // deliberate act — if you add one and forget, A10 tells you.
  const SERVER_HANDLED = new Set([
    "get_network_state", // reads the server's own capture buffer
    "smart_scroll", // sends "scroll", then waits for lazy-loaded traffic
    "get_site_memory", // reads ~/.poltertab/navigation_memory
    "save_site_memory",
    "extract_all", // drives navigate + extract in a loop
  ]);

  await test("A10 every tool the server exposes has a route in the extension", () => {
    const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
    const routes = keysOf(bg, "const ROUTES = {");
    assert.ok(routes.size >= 18, `only parsed ${routes.size} routes`);

    const tools = toolNames();
    const orphans = tools.filter(
      (t) => !SERVER_HANDLED.has(t) && !routes.has(t),
    );
    assert.deepStrictEqual(
      orphans,
      [],
      `tools with no route and not server-handled: ${orphans}`,
    );
  });

  await test("A11 every extension route is a tool, or a known internal action", () => {
    // The other direction: a route nothing can reach is dead weight, and a
    // renamed tool that left its old route behind reads as still working.
    const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
    const tools = new Set(toolNames());
    // update_patterns is pushed tab-to-tab by set_intercept_patterns, never by
    // a tool call.
    const INTERNAL = new Set(["update_patterns"]);
    const unreachable = [...keysOf(bg, "const ROUTES = {")].filter(
      (r) => !tools.has(r) && !INTERNAL.has(r),
    );
    assert.deepStrictEqual(unreachable, [], `routes nothing can call: ${unreachable}`);
  });

  await test("A12 every action forwarded into the page has a content-script handler", () => {
    const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
    const cs = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");
    const handlers = keysOf(cs, "const handlers = {");
    assert.ok(handlers.size >= 8, `only parsed ${handlers.size} handlers`);

    // A handful of actions are answered by an explicit branch ahead of the map
    // (update_patterns just relays a postMessage into the MAIN world), so count
    // those as handled too.
    const branched = new Set(
      [...cs.matchAll(/action === "([a-z_]+)"/g)].map((m) => m[1]),
    );

    const forwarded = [
      ...bg.matchAll(/forwardToContentScript\("([a-z_]+)"/g),
    ].map((m) => m[1]);
    assert.ok(forwarded.length >= 8, `only found ${forwarded.length} forwards`);
    const missing = forwarded.filter(
      (a) => !handlers.has(a) && !branched.has(a),
    );
    assert.deepStrictEqual(
      missing,
      [],
      `forwarded to the page with no handler there: ${missing}`,
    );
  });

  await test("A13 the restricted-page error is spelled the same on both sides", () => {
    // background.js throws it; index.js string-matches it to decide isError.
    // Two processes, one English sentence, and nothing pinning it.
    const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
    const idx = fs.readFileSync(SERVER, "utf8");
    const thrown = /"(Cannot interact with this page[^"]*)"/.exec(bg);
    assert.ok(thrown, "background.js no longer throws the restricted-page error");
    const matched = /result\.includes\(\s*"([^"]+)"/.exec(idx);
    assert.ok(matched, "index.js no longer string-matches a result");
    assert.ok(
      thrown[1].startsWith(matched[1]),
      `server matches "${matched[1]}" but the extension throws "${thrown[1]}"`,
    );
  });

  await test("A8 the ref snapshot stamps is the ref resolveElement accepts", () => {
    // Two halves of one contract in one file, 160 lines apart. If snapshot's
    // prefix changes and the resolver's regex does not, every ref silently
    // stops resolving again — which is exactly how it shipped broken.
    const src = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");
    assert.ok(
      /setAttribute\("data-zc-ref", ref\)/.test(src),
      "snapshot no longer stamps data-zc-ref",
    );
    assert.ok(
      /"@e"\s*\+\s*\+\+counter/.test(src),
      "snapshot's ref is no longer @e<n>",
    );
    assert.ok(
      /\/\^@e\\d\+\$\/\.test\(selector\)/.test(src),
      "resolveElement no longer translates an @e ref",
    );
    assert.ok(
      /\[data-zc-ref="\$\{selector\}"\]/.test(src),
      "the ref is translated to some other attribute than the one stamped",
    );
  });

  await test("A9 the interceptor posts no synthetic startup record", () => {
    // TEST_INIT travelled content script → background → server and landed in
    // networkState as a real captured request, so every get_network_state on a
    // freshly loaded tab returned a fake entry that also ate the 500-cap.
    const src = fs.readFileSync(path.join(EXT, "interceptor.js"), "utf8");
    const posts = [...src.matchAll(/postMessage\(/g)];
    assert.ok(!/TEST_INIT/.test(src), "the TEST_INIT debug record is back");
    assert.strictEqual(
      posts.length,
      2,
      "interceptor should postMessage only from the fetch and XHR paths",
    );
  });

  await test("A3 content_script guards re-execution before registering anything", () => {
    const src = fs.readFileSync(path.join(EXT, "content_script.js"), "utf8");
    const guard = src.indexOf("__polterTabInjected");
    const listener = src.indexOf("addEventListener");
    const onMessage = src.indexOf("onMessage.addListener");
    assert.ok(guard !== -1, "no injection sentinel");
    assert.ok(guard < listener, "sentinel must precede window listeners");
    assert.ok(guard < onMessage, "sentinel must precede the command listener");
  });
}

module.exports = groupA;
