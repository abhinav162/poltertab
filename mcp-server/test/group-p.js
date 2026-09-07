const {
  PORT,
  TAB,
  WebSocket,
  agentCard,
  assert,
  memoryHome,
  recordSandbox,
  rpc,
  test,
  textOf,
  waitFor,
  withServer,
} = require("./harness.js");
const fs = require("fs");
const os = require("os");
const path = require("path");

// In-process unit tests for the recipe store in memory.js. config.js reads
// POLTERTAB_HOME at load, so an isolated home has to exist before requiring
// the module — but group-o requires it first when the whole suite runs, and by
// then config.js is cached. Only claim the env var if nobody else has, and ask
// config where the store actually landed rather than recomputing it.
if (!process.env.POLTERTAB_HOME) {
  process.env.POLTERTAB_HOME = fs.mkdtempSync(
    path.join(os.tmpdir(), "poltertab-mem-"),
  );
}
const memory = require("../memory.js");
const recipes = require("../recipes.js");
const MEM_DIR = require("../config.js").MEMORY_DIR;

// A minimal recipe: one extract spec plus one named variant.
function recipe(variant, lastOk, fields = { name: "h3", salary: ".pay" }) {
  return {
    extract: { record: ".card", fields, anchor: "url" },
    variants: {
      [variant]: {
        steps: [{ action: "click", selector: "#go" }],
        baseline: { name: 1 },
        lastOk,
        failCount: 0,
      },
    },
  };
}

// recipes.js is policy only — no filesystem, no server — so these are straight
// in-process unit tests. No POLTERTAB_HOME to set up.

const SPEC = {
  record: ".agent-card",
  fields: {
    name: { sel: "a.name", get: "text" },
    url: { sel: "a.name", get: "href" },
  },
};

// A clean 12-row extract result, shaped exactly like content_script's
// extract(): fill_rates are counts, not ratios.
function result(over = {}) {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    name: `agent ${i}`,
    url: `http://t/a${i}`,
  }));
  return {
    url: "http://t/agents",
    count: rows.length,
    records_found: rows.length,
    dropped: 0,
    fill_rates: { name: rows.length, url: rows.length },
    warnings: [],
    rows,
    ...over,
  };
}

async function groupP() {
  console.log("\nP. learned extraction recipes");

  await test("P1 putRecipe then getRecipe round-trips", () => {
    memory.putRecipe("p1.example", "/search", "name-salary", recipe("eng", 10));
    const got = memory.getRecipe("p1.example", "/search", "name-salary");
    assert.ok(got, "recipe was not stored");
    assert.strictEqual(got.extract.record, ".card");
    assert.deepStrictEqual(Object.keys(got.variants), ["eng"]);
    assert.strictEqual(
      memory.getRecipe("p1.example", "/search", "nope"),
      null,
      "an unknown recipe name must read as null",
    );
    assert.deepStrictEqual(
      memory.getRecipes("p1.example", "/other"),
      {},
      "an unknown path pattern must read as {}",
    );
  });

  await test("P2 a second variant merges rather than replacing the first", () => {
    memory.putRecipe("p2.example", "/jobs", "titles", recipe("remote", 10));
    memory.putRecipe("p2.example", "/jobs", "titles", recipe("onsite", 20));
    const got = memory.getRecipe("p2.example", "/jobs", "titles");
    assert.deepStrictEqual(
      Object.keys(got.variants).sort(),
      ["onsite", "remote"],
      "learning a second slice of the same task forgot the first",
    );
  });

  await test("P3 a variant that keeps failing is dropped after 3 misses", () => {
    memory.putRecipe("p3.example", "/jobs", "titles", recipe("remote", 10));
    memory.putRecipe("p3.example", "/jobs", "titles", recipe("onsite", 20));
    memory.noteRecipeFail("p3.example", "/jobs", "titles", "remote");
    memory.noteRecipeFail("p3.example", "/jobs", "titles", "remote");
    assert.ok(
      memory.getRecipe("p3.example", "/jobs", "titles").variants.remote,
      "dropped too early",
    );
    memory.noteRecipeFail("p3.example", "/jobs", "titles", "remote");
    assert.deepStrictEqual(
      Object.keys(memory.getRecipe("p3.example", "/jobs", "titles").variants),
      ["onsite"],
      "not dropped after MAX_FAILS",
    );

    // The last variant going takes the recipe with it, and the last recipe
    // takes the path pattern — otherwise the file accretes empty objects.
    for (let i = 0; i < 3; i++)
      memory.noteRecipeFail("p3.example", "/jobs", "titles", "onsite");
    assert.strictEqual(
      memory.getRecipe("p3.example", "/jobs", "titles"),
      null,
      "an empty recipe was left behind",
    );
    assert.deepStrictEqual(memory.readMemory("p3.example").recipes, {});

    // A miss against something that was never learned is a no-op, not a throw.
    memory.noteRecipeFail("p3.example", "/jobs", "titles", "onsite");
    memory.noteRecipeFail("p3-unknown.example", "/x", "y", "z");
  });

  await test("P4 pathPattern buckets volatile path segments together", () => {
    assert.strictEqual(
      memory.pathPattern("/jobs/12345"),
      memory.pathPattern("/jobs/99"),
      "two ids on the same page shape did not bucket together",
    );
    assert.strictEqual(memory.pathPattern("/jobs/12345"), "/jobs/:n");
    assert.strictEqual(memory.pathPattern("/search?page=2"), "/search");
    assert.strictEqual(memory.pathPattern("/search#top"), "/search");
    assert.strictEqual(
      memory.pathPattern("/u/8f14e45f-ceea-467a-9f43-d9e0f37f5c2b/profile"),
      "/u/:id/profile",
    );
    assert.strictEqual(memory.pathPattern("/o/a1b2c3d4e5f67890"), "/o/:id");
    assert.strictEqual(memory.pathPattern(""), "/");
    assert.strictEqual(memory.pathPattern("/"), "/");
    assert.strictEqual(memory.pathPattern(null), "/");
    assert.strictEqual(memory.pathPattern("/search/"), "/search");
    assert.strictEqual(memory.pathPattern("//search//deep/"), "/search/deep");
    // Documented as taking a pathname, but callers hand over whatever the page
    // reported, and that is often the full URL.
    assert.strictEqual(
      memory.pathPattern("https://x.example/jobs/7?q=a#b"),
      "/jobs/:n",
    );
    // A readable slug is the signal, not noise — collapsing it would merge two
    // genuinely different page shapes into one recipe bucket.
    assert.strictEqual(
      memory.pathPattern("/senior-engineer-2024"),
      "/senior-engineer-2024",
    );
  });

  await test("P5 recipes are capped per host, evicting the stalest first", () => {
    // lastOk ascending, so recipe r0 is the stalest and r24 the freshest.
    for (let i = 0; i < 25; i++)
      memory.putRecipe("p5.example", "/p" + i, "r", recipe("v", 1000 + i));
    const stored = memory.readMemory("p5.example").recipes;
    const patterns = Object.keys(stored);
    assert.strictEqual(patterns.length, 20, "cap not enforced across patterns");
    assert.ok(!patterns.includes("/p4"), "a stale recipe survived eviction");
    assert.ok(patterns.includes("/p5"), "evicted one too many");
    assert.ok(patterns.includes("/p24"), "the freshest recipe was evicted");
    assert.strictEqual(memory.RECIPES_CAP, 20);
  });

  await test("P6 listRecipeSummaries stays small", () => {
    memory.putRecipe("p6.example", "/jobs", "titles", recipe("remote", 10));
    memory.putRecipe("p6.example", "/jobs", "titles", recipe("onsite", 20));
    const summaries = memory.listRecipeSummaries("p6.example", "/jobs");
    assert.strictEqual(summaries.length, 1);
    const [s] = summaries;
    assert.strictEqual(s.name, "titles");
    assert.deepStrictEqual(s.fields.sort(), ["name", "salary"]);
    assert.deepStrictEqual(s.variants.sort(), ["onsite", "remote"]);
    assert.strictEqual(s.lastOk, 20, "lastOk is not the newest across variants");
    // This exists to be cheap enough for an unconditional hint: the selectors
    // and the replay steps must not ride along.
    const json = JSON.stringify(summaries);
    assert.ok(!json.includes(".card"), "the extract spec leaked into a summary");
    assert.ok(!json.includes("steps"), "the replay steps leaked into a summary");
    assert.deepStrictEqual(memory.listRecipeSummaries("p6.example", "/none"), []);
  });

  await test("P7 an old bare-array file reports no recipes", () => {
    fs.writeFileSync(
      path.join(MEM_DIR, "p7.example.json"),
      JSON.stringify([{ obstacle: "x", solution: "y", timestamp: 1 }]),
    );
    const m = memory.readMemory("p7.example");
    assert.deepStrictEqual(m.notes, [
      { obstacle: "x", solution: "y", timestamp: 1 },
    ]);
    assert.deepStrictEqual(m.recipes, {});

    // A recipes key of the wrong shape is treated as absent rather than
    // trusted — Object.keys on an array would hand out numeric "names".
    fs.writeFileSync(
      path.join(MEM_DIR, "p7b.example.json"),
      JSON.stringify({ notes: [], selectors: {}, recipes: ["nope"] }),
    );
    assert.deepStrictEqual(memory.readMemory("p7b.example").recipes, {});
  });

  await test("P8 an unwritable store never throws at a caller mid-extract", () => {
    memory.putRecipe("p21.example", "/jobs", "titles", recipe("remote", 10));
    // Writes go temp-file-then-rename, so only an unwritable *directory* blocks
    // them — a read-only file still renames fine.
    fs.chmodSync(MEM_DIR, 0o500);
    try {
      // The extract already succeeded; failing to write the recipe down must
      // not surface as a failed extract, or the agent re-runs the whole crawl.
      memory.putRecipe("p21.example", "/jobs", "titles", recipe("onsite", 20));
      memory.noteRecipeFail("p21.example", "/jobs", "titles", "remote");
    } finally {
      fs.chmodSync(MEM_DIR, 0o700);
    }
  });

  await test("P9 a corrupt file cannot brick the extract path", () => {
    fs.writeFileSync(
      path.join(MEM_DIR, "p22.example.json"),
      '{"recipes":{"/jobs":{"tit',
    );
    assert.deepStrictEqual(memory.getRecipes("p22.example", "/jobs"), {});
    assert.strictEqual(memory.getRecipe("p22.example", "/jobs", "titles"), null);
    assert.deepStrictEqual(memory.listRecipeSummaries("p22.example", "/jobs"), []);
  });

  console.log("\nP. recipe policy (recipes.js)");

  await test("P10 sameSpec ignores key order but not a changed selector", () => {
    const a = {
      record: ".agent-card",
      fields: { name: { sel: "a", get: "text" }, url: { get: "href", sel: "a" } },
    };
    const b = {
      record: ".agent-card",
      fields: { url: { sel: "a", get: "href" }, name: { get: "text", sel: "a" } },
    };
    assert.strictEqual(recipes.sameSpec(a, b), true, "key order changed the verdict");

    const c = JSON.parse(JSON.stringify(b));
    c.fields.url.sel = "a.profile";
    assert.strictEqual(
      recipes.sameSpec(a, c),
      false,
      "a different field selector read as the same spec",
    );
  });

  await test("P11 collapse is judged against this variant's own baseline", () => {
    assert.deepStrictEqual(
      recipes.collapsed({ name: 0.9 }, { name: 0.1 }, 0.5),
      ["name"],
      "a field that fell from 90% to 10% is not being reported",
    );
    // A slice where the column is legitimately sparse must not read as stale.
    assert.deepStrictEqual(recipes.collapsed({ name: 0.1 }, { name: 0.1 }, 0.5), []);
  });

  await test("P12 qualityOk refuses to learn from a result it cannot trust", () => {
    const rows1 = [{ name: "solo", url: "http://t/a" }];
    assert.strictEqual(
      recipes.qualityOk(
        result({ rows: rows1, count: 1, records_found: 1, fill_rates: { name: 1, url: 1 } }),
        SPEC,
      ).ok,
      false,
      "a spec proven on one card was accepted",
    );

    // The literal strings content_script emits.
    assert.strictEqual(
      recipes.qualityOk(
        result({
          warnings: [
            'record: no matches for ".agent-card" — wrong selector, or the records live in another frame',
          ],
        }),
        SPEC,
      ).ok,
      false,
    );
    assert.strictEqual(
      recipes.qualityOk(
        result({
          warnings: [
            'name: 0/12 within record scope, but 12 matches page-wide for "a.name" — record boundary likely too narrow',
          ],
        }),
        SPEC,
      ).ok,
      false,
    );

    // Half the cards dropped for a missing anchor means the anchor is wrong.
    assert.strictEqual(
      recipes.qualityOk(result({ records_found: 24, dropped: 12 }), {
        ...SPEC,
        anchor: "name",
      }).ok,
      false,
      "a spec that dropped half the page was accepted",
    );

    assert.strictEqual(
      recipes.qualityOk(result({ fill_rates: { name: 5, url: 1 } }), SPEC).ok,
      false,
      "a spec with no field above 50% fill was accepted",
    );

    const good = recipes.qualityOk(result(), SPEC);
    assert.strictEqual(good.ok, true, good.why);
  });

  await test("P13 qualityOk rejects a spec too big to be a spec", () => {
    const fields = {};
    for (let i = 0; i < 51; i++) fields[`f${i}`] = { sel: `.f${i}`, get: "text" };
    const many = recipes.qualityOk(result({ fill_rates: { f0: 12 } }), {
      record: ".agent-card",
      fields,
    });
    assert.strictEqual(many.ok, false, "51 fields was accepted");

    const fat = { f0: { sel: ".f0", get: "text" } };
    for (let i = 1; i < 5; i++) fat[`f${i}`] = { sel: ".x".repeat(600), get: "text" };
    const big = recipes.qualityOk(result({ fill_rates: { f0: 12 } }), {
      record: ".agent-card",
      fields: fat,
    });
    assert.strictEqual(big.ok, false, "a >4KB spec was accepted");
  });

  await test("P14 collapsed does not mutate the baseline it is handed", () => {
    // The ratchet guard compares against a stored baseline; if this call edited
    // it, every later page would be judged against a moving bar.
    const baseline = { name: 0.9, url: 0.8 };
    const ratios = { name: 0.1, url: 0.8 };
    const beforeB = JSON.stringify(baseline);
    const beforeR = JSON.stringify(ratios);
    recipes.collapsed(baseline, ratios, 0.5);
    assert.strictEqual(JSON.stringify(baseline), beforeB, "baseline was mutated");
    assert.strictEqual(JSON.stringify(ratios), beforeR, "ratios were mutated");
  });

  await test("P15 collapsed is a pure function of its arguments", () => {
    const baseline = { name: 0.9, url: 0.8 };
    const ratios = { name: 0.1, url: 0.8 };
    const first = recipes.collapsed(baseline, ratios, 0.5);
    assert.deepStrictEqual(recipes.collapsed(baseline, ratios, 0.5), first);
    assert.deepStrictEqual(
      recipes.collapsed(baseline, ratios, 0),
      [],
      "tolerance 0 must disable the check",
    );
  });

  await test("P16 an omitted tolerance defaults rather than disabling the check", () => {
    // Staleness detection must never fail open: a recipe-replay caller that
    // passes an absent recipe.tolerance would otherwise report a rotted spec
    // as clean forever.
    assert.deepStrictEqual(recipes.collapsed({ salary: 1 }, { salary: 0.05 }, undefined), [
      "salary",
    ]);
    assert.deepStrictEqual(recipes.collapsed({ salary: 1 }, { salary: 0.05 }, null), [
      "salary",
    ]);
    assert.deepStrictEqual(
      recipes.collapsed({ salary: 1 }, { salary: 0.05 }, undefined),
      recipes.collapsed({ salary: 1 }, { salary: 0.05 }, recipes.DEFAULT_TOLERANCE),
    );
  });

  await test("P17 an explicit zero tolerance still disables the check", () => {
    // fill_tolerance: 0 is a deliberate opt-out a caller can pass.
    assert.deepStrictEqual(recipes.collapsed({ salary: 1 }, { salary: 0.05 }, 0), []);
    assert.deepStrictEqual(recipes.collapsed({ salary: 1 }, { salary: 0.05 }, -1), []);
  });

  await test("P18 qualityOk matches the warnings content_script really emits", async () => {
    // P7 asserts against pasted strings, which stay green if content_script
    // rewords a warning and the substring silently stops firing. These run the
    // real extract() and hand it the text it actually produced.
    const cards = [
      agentCard({ name: "Ann", path: "/agent/ann", socials: ["http://fb/ann"] }),
      agentCard({ name: "Cal", path: "/agent/cal", socials: ["http://fb/cal"] }),
      agentCard({ name: "Dee", path: "/agent/dee", socials: ["http://fb/dee"] }),
    ];

    const missing = await recordSandbox(cards).send("extract", {
      record: ".nope",
      fields: { name: { sel: "a.agent-card-name", get: "text" } },
    });
    assert.strictEqual(missing.success, true, missing.error);
    assert.ok(missing.data.warnings.length, "extract emitted no warning to match");
    // Give it rows so the row-count rule cannot be what rejects it.
    const noRecord = recipes.qualityOk(
      { ...missing.data, rows: result().rows, fill_rates: { name: 12 } },
      { record: ".nope", fields: { name: { sel: "a.agent-card-name", get: "text" } } },
    );
    assert.strictEqual(noRecord.ok, false, JSON.stringify(missing.data.warnings));
    assert.ok(/selector matched nothing/.test(noRecord.why), noRecord.why);

    // .agent-card-info looks like the card but socials are its sibling.
    const narrow = await recordSandbox(cards).send("extract", {
      record: ".agent-card-info",
      fields: {
        name: { sel: "a.agent-card-name", get: "text" },
        socials: { sel: "a.agent-card-social-button", get: "href", many: true },
      },
    });
    assert.strictEqual(narrow.success, true, narrow.error);
    const tooNarrow = recipes.qualityOk(narrow.data, {
      record: ".agent-card-info",
      fields: {
        name: { sel: "a.agent-card-name", get: "text" },
        socials: { sel: "a.agent-card-social-button", get: "href", many: true },
      },
    });
    assert.strictEqual(tooNarrow.ok, false, JSON.stringify(narrow.data.warnings));
    assert.ok(/record boundary/.test(tooNarrow.why), tooNarrow.why);
  });

  await test("P19 ratiosOf on a zero-row result is empty, not NaN", () => {
    const r = recipes.ratiosOf({ rows: [], fill_rates: { name: 0, url: 0 } });
    assert.deepStrictEqual(r, {});
    assert.deepStrictEqual(recipes.ratiosOf(result()), { name: 1, url: 1 });
    assert.deepStrictEqual(recipes.ratiosOf(result({ fill_rates: { name: 6 } })), {
      name: 0.5,
    });
  });

  await test("P20 deriveName is deterministic and caps at three fields", () => {
    const fields = { Name: 1, "Job Title": 1, salary: 1, url: 1 };
    assert.strictEqual(recipes.deriveName(fields), "name-job-title-salary");
    assert.strictEqual(recipes.deriveName(fields), recipes.deriveName(fields));
    assert.strictEqual(recipes.deriveName({ name: 1, title: 1, salary: 1 }), "name-title-salary");
    assert.strictEqual(recipes.deriveName({}), "default");
    assert.strictEqual(recipes.deriveName(undefined), "default");
  });

  await test("P21 redactValue drops a value that looks like a secret", () => {
    const cases = [
      ["#login-pw", { value: "hunter2" }, { attrs: { type: "password" } }],
      ["#otp-code", { value: "483920" }, { attrs: { type: "text" } }],
      ["#f1", { value: "4111111111111111" }, { attrs: { name: "card_number" } }],
    ];
    for (const [selector, args, fp] of cases) {
      const out = recipes.redactValue("fill", { selector, ...args }, fp);
      assert.strictEqual(out.value, null, `${selector} value survived`);
      assert.strictEqual(out.redacted, true, `${selector} not marked redacted`);
    }

    const plain = recipes.redactValue(
      "fill",
      { selector: "#facet-search", value: "remote" },
      { attrs: { type: "text", name: "q" } },
    );
    assert.strictEqual(plain.value, "remote");
    assert.strictEqual(plain.redacted, false);

    const clicked = recipes.redactValue("click", { selector: "#next" }, {});
    assert.strictEqual(clicked.value, undefined);
    assert.strictEqual(clicked.redacted, false);
  });

  await test("P22 step seq increases without consulting the clock", () => {
    recipes.clearSteps("p14", "test setup");
    for (const sel of ["#a", "#b", "#c"])
      recipes.noteStep("p14", { action: "click", selector: sel, path: "/" });
    const steps = recipes.takeSteps("p14");
    assert.deepStrictEqual(
      steps.map((s) => s.seq),
      [0, 1, 2],
      // lastOk-style timestamps land in the same millisecond and reorder
      // between runs; an explicit counter cannot.
      JSON.stringify(steps),
    );
    assert.deepStrictEqual(
      steps.map((s) => s.selector),
      ["#a", "#b", "#c"],
    );
  });

  await test("P23 consecutive scrolls coalesce into one counted step", () => {
    recipes.clearSteps("p15", "test setup");
    for (let i = 0; i < 40; i++)
      recipes.noteStep("p15", { action: "smart_scroll", selector: null, path: "/" });
    recipes.noteStep("p15", { action: "click", selector: "#next", path: "/" });
    const steps = recipes.takeSteps("p15");
    assert.strictEqual(steps.length, 2, JSON.stringify(steps));
    assert.strictEqual(steps[0].count, 40);
    assert.strictEqual(steps[1].action, "click");
  });

  await test("P24 buffers are independent per targetKey", () => {
    recipes.clearSteps("p16-a", "test setup");
    recipes.clearSteps("p16-b", "test setup");
    recipes.noteStep("p16-a", { action: "click", selector: "#a", path: "/" });
    recipes.noteStep("p16-b", { action: "click", selector: "#b", path: "/" });
    recipes.noteStep("p16-a", { action: "click", selector: "#a2", path: "/" });
    assert.deepStrictEqual(
      recipes.takeSteps("p16-b").map((s) => s.selector),
      ["#b"],
      "one tab's steps leaked into another's recipe",
    );
    assert.deepStrictEqual(
      recipes.takeSteps("p16-a").map((s) => s.selector),
      ["#a", "#a2"],
    );
  });

  await test("P25 overflow past the cap drops the buffer, and take clears it", () => {
    recipes.clearSteps("p17", "test setup");
    for (let i = 0; i <= recipes.STEP_CAP; i++)
      recipes.noteStep("p17", { action: "click", selector: `#s${i}`, path: "/" });
    assert.deepStrictEqual(
      recipes.takeSteps("p17"),
      [],
      "a flow longer than the cap was kept as a recipe preamble",
    );

    recipes.noteStep("p17", { action: "click", selector: "#one", path: "/" });
    assert.strictEqual(recipes.takeSteps("p17").length, 1);
    assert.deepStrictEqual(recipes.takeSteps("p17"), [], "takeSteps did not clear");
  });

  await test("P26 a buffer older than the TTL is not replayed", () => {
    recipes.clearSteps("p18", "test setup");
    recipes.noteStep("p18", { action: "click", selector: "#a", path: "/" });
    const later = Date.now() + recipes.STEP_TTL_MS + 1;
    assert.deepStrictEqual(
      recipes.takeSteps("p18", later),
      [],
      "a stale preamble was replayed",
    );
    assert.deepStrictEqual(recipes.takeSteps("p18"), [], "stale buffer was not cleared");
  });

  console.log("\nP. recipes end to end (index.js wiring)");

  // A fake extension for the recipe path. It serves records, keeps every
  // extract spec it was asked for — the only way to tell a hydrated call from
  // a model-supplied one — and hands back the element fingerprints redaction
  // reads.
  function recipeExtension(cfg = {}) {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const rowsFor =
      cfg.rows ||
      ((state) =>
        Array.from({ length: 12 }, (_, i) => ({
          name: `Agent ${state.page}-${i}`,
          url: `http://t/a/${state.page}-${i}`,
        })));
    const state = { ws, open: false, seen: [], extracts: [], page: 1, url: "http://t/" };
    ws.on("open", () => {
      state.open = true;
      ws.send(JSON.stringify({ type: "extension_ready", version: "test" }));
    });
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      state.seen.push(m);
      if (!m.id || !m.action) return;
      let data;
      if (m.action === "navigate") {
        state.url = m.url;
        const hit = /[?&]page=(\d+)/.exec(m.url || "");
        state.page = hit ? Number(hit[1]) : 1;
        data = { tabId: TAB, url: m.url, title: "T", status: "ok" };
      } else if (m.action === "get_url") {
        data = { url: state.url, title: "T", tabId: TAB };
      } else if (m.action === "extract") {
        state.extracts.push(m);
        const rows = rowsFor(state);
        const fill_rates = {};
        for (const f of Object.keys(rows[0] || {}))
          fill_rates[f] = rows.filter((r) => r[f] !== null && r[f] !== "").length;
        data = {
          url: state.url,
          count: rows.length,
          records_found:
            cfg.records_found !== undefined ? cfg.records_found : rows.length,
          dropped: 0,
          fill_rates,
          warnings: [],
          rows,
        };
      } else {
        data = { ok: true, tabId: TAB };
        const fp = (cfg.fingerprints || {})[m.selector];
        if (fp) data.fingerprint = fp;
      }
      ws.send(JSON.stringify({ id: m.id, success: true, data }));
    });
    return state;
  }

  // One server, one fake extension, one disposable memory home — the shape
  // every case below needs. `store()` reads what the server actually wrote.
  async function withRecipeServer({ seed = {}, ext: cfg = {} }, fn) {
    const home = memoryHome(seed);
    return withServer(home, async (srv) => {
      const ext = recipeExtension(cfg);
      await waitFor("ext open", () => ext.open);
      const store = (host = "t") => {
        const file = path.join(home, "navigation_memory", `${host}.json`);
        return fs.existsSync(file)
          ? JSON.parse(fs.readFileSync(file, "utf8"))
          : { notes: [], selectors: {}, recipes: {} };
      };
      try {
        return await fn({ srv, ext, home, store });
      } finally {
        ext.ws.close();
      }
    });
  }

  const call = (srv, name, args = {}) =>
    rpc(srv, "tools/call", { name, arguments: args });
  const jsonOf = (reply) => JSON.parse(textOf(reply));

  const LIVE_SPEC = {
    record: ".card",
    fields: {
      name: { sel: "a.name", get: "text" },
      url: { sel: "a.name", get: "href" },
    },
  };

  // A seeded recipe, as the server would have written it: the two-field spec
  // above plus one variant carrying the baseline a replay is judged against.
  const DAY = 24 * 60 * 60 * 1000;
  function seededStore(over = {}) {
    return {
      "t.json": {
        notes: [{ obstacle: "12 per page", solution: "?page=N", timestamp: 1 }],
        selectors: {},
        recipes: {
          "/search": {
            "name-salary": {
              extract: {
                record: ".card",
                fields: {
                  name: { sel: "a.name", get: "text" },
                  salary: { sel: ".pay", get: "text" },
                },
              },
              variants: {
                default: {
                  steps: [
                    { seq: 0, action: "click", selector: "#facet-eng", path: "/search" },
                    {
                      seq: 1,
                      action: "fill",
                      selector: "#q",
                      value: "remote",
                      path: "/search",
                    },
                    { seq: 2, action: "smart_scroll", selector: null, count: 40, path: "/search" },
                  ],
                  baseline: { name: 1, salary: 1 },
                  lastOk: Date.now() - 3 * DAY,
                  failCount: 0,
                  ...(over.variant || {}),
                },
              },
            },
          },
        },
      },
    };
  }

  // Rows where the salary column has stopped being populated: the layout
  // change a stored baseline exists to catch.
  const salaryGone = (state) =>
    Array.from({ length: 12 }, (_, i) => ({
      name: `Agent ${state.page}-${i}`,
      salary: null,
    }));

  await test("P27 a good extract is learned, and a later extract with no spec replays it", async () => {
    await withRecipeServer({}, async ({ srv, ext, store }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      const first = jsonOf(await call(srv, "browser_extract", { ...LIVE_SPEC }));
      assert.strictEqual(first.rows.length, 12, JSON.stringify(first).slice(0, 300));
      assert.strictEqual(
        first.learned_recipe,
        "name-url/default",
        `nothing was learned: ${JSON.stringify(first).slice(0, 300)}`,
      );

      // No spec at all. The record selector has to come from the store.
      const second = jsonOf(await call(srv, "browser_extract", {}));
      assert.deepStrictEqual(
        second.rows,
        first.rows,
        "a hydrated replay returned different records",
      );
      const last = ext.extracts[ext.extracts.length - 1];
      assert.strictEqual(last.record, ".card", JSON.stringify(last));
      assert.deepStrictEqual(Object.keys(last.fields).sort(), ["name", "url"]);
      assert.deepStrictEqual(
        Object.keys(store().recipes["/search"]),
        ["name-url"],
        JSON.stringify(store().recipes),
      );
    });
  });

  await test("P28 the result says which recipe it used", async () => {
    await withRecipeServer({}, async ({ srv }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_extract", { ...LIVE_SPEC });
      const out = jsonOf(await call(srv, "browser_extract", {}));
      // Without this the model cannot tell a replayed spec from its own, and a
      // stale recipe's rows read as a fresh extraction.
      assert.strictEqual(out.used_recipe, "name-url/default", JSON.stringify(out).slice(0, 300));
      assert.strictEqual(out.stale, undefined, "a clean replay reported stale");
    });
  });

  await test("P29 a recipe learned on /search is not used on /jobs", async () => {
    await withRecipeServer({}, async ({ srv, ext }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_extract", { ...LIVE_SPEC });
      const before = ext.extracts.length;

      await call(srv, "browser_navigate", { url: "http://t/jobs" });
      const reply = await call(srv, "browser_extract", {});
      assert.ok(reply.result.isError, "a recipe from another page shape was replayed");
      const text = textOf(reply);
      assert.ok(/record/.test(text) && /fields/.test(text), text);
      assert.ok(/navigate/.test(text), text);
      assert.strictEqual(
        ext.extracts.length,
        before,
        "an extract was sent anyway, with no spec",
      );
    });
  });

  await test("P30 two recipes under one pattern and no name errors, listing both", async () => {
    await withRecipeServer({}, async ({ srv, ext }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_extract", { ...LIVE_SPEC });
      await call(srv, "browser_extract", {
        record: ".row",
        fields: { title: { sel: "h3", get: "text" }, pay: { sel: ".pay", get: "text" } },
      });
      const before = ext.extracts.length;

      const reply = await call(srv, "browser_extract", {});
      assert.ok(reply.result.isError, "the server guessed between two recipes");
      const text = textOf(reply);
      assert.ok(/name-url/.test(text), text);
      assert.ok(/title-pay/.test(text), text);
      assert.strictEqual(ext.extracts.length, before, "extracted anyway");

      // Naming one resolves it.
      const picked = jsonOf(
        await call(srv, "browser_extract", { recipe: "title-pay" }),
      );
      assert.strictEqual(picked.used_recipe, "title-pay/default");
      assert.strictEqual(
        ext.extracts[ext.extracts.length - 1].record,
        ".row",
        "the wrong recipe was replayed",
      );
    });
  });

  await test("P31 exactly one candidate needs no name", async () => {
    await withRecipeServer({ seed: seededStore() }, async ({ srv, ext, store }) => {
      const before = store().recipes["/search"]["name-salary"].variants.default;
      await call(srv, "browser_navigate", { url: "http://t/search" });
      const out = jsonOf(await call(srv, "browser_extract", {}));
      assert.strictEqual(out.used_recipe, "name-salary/default", JSON.stringify(out).slice(0, 300));
      assert.strictEqual(ext.extracts[ext.extracts.length - 1].record, ".card");

      // A clean replay refreshes the variant's clock. Storage replaces a
      // variant wholesale, so writing just the clock would eat the baseline
      // and the steps that were being kept fresh.
      const after = store().recipes["/search"]["name-salary"].variants.default;
      assert.deepStrictEqual(after.baseline, before.baseline, "baseline lost on a clean replay");
      assert.deepStrictEqual(after.steps, before.steps, "steps lost on a clean replay");
      assert.ok(after.lastOk > before.lastOk, "the clock was not refreshed");
    });
  });

  await test("P32 an identical spec lands as a second variant, not a second recipe", async () => {
    await withRecipeServer({}, async ({ srv, store }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_extract", { ...LIVE_SPEC });
      const out = jsonOf(
        await call(srv, "browser_extract", { ...LIVE_SPEC, remember: "agents/mobile" }),
      );
      const bucket = store().recipes["/search"];
      assert.deepStrictEqual(
        Object.keys(bucket),
        ["name-url"],
        `the same task was learned twice: ${Object.keys(bucket)}`,
      );
      assert.deepStrictEqual(
        Object.keys(bucket["name-url"].variants).sort(),
        ["default", "mobile"],
      );
      assert.strictEqual(out.learned_recipe, "name-url/mobile", JSON.stringify(out).slice(0, 300));
    });
  });

  await test("P33 navigate carries recipes_available, and nothing when there are none", async () => {
    await withRecipeServer({ seed: seededStore() }, async ({ srv }) => {
      const known = jsonOf(await call(srv, "browser_navigate", { url: "http://t/search" }));
      assert.ok(Array.isArray(known.recipes_available), JSON.stringify(known));
      assert.strictEqual(known.recipes_available.length, 1);
      const [hint] = known.recipes_available;
      assert.ok(/^name-salary /.test(hint), hint);
      assert.ok(/2 fields/.test(hint), hint);
      assert.ok(/1 variant\b/.test(hint), hint);
      assert.ok(/3d ago/.test(hint), hint);

      // A host with nothing learned must not pay for the hint, not even an
      // empty array the model has to read past.
      const cold = jsonOf(await call(srv, "browser_navigate", { url: "http://cold/x" }));
      assert.ok(
        !("recipes_available" in cold),
        `an empty hint was sent anyway: ${JSON.stringify(cold)}`,
      );
    });
  });

  await test("P34 steps flush into a recipe only when the extract earns it", async () => {
    // Two rows is below the bar qualityOk sets, so nothing may be written —
    // not the spec, and not the preamble that led to it.
    await withRecipeServer(
      { ext: { rows: () => [{ name: "a", url: "http://t/a" }, { name: "b", url: "http://t/b" }] } },
      async ({ srv, store }) => {
        await call(srv, "browser_navigate", { url: "http://t/search" });
        await call(srv, "browser_click", { selector: "#facet-eng" });
        const out = jsonOf(await call(srv, "browser_extract", { ...LIVE_SPEC }));
        assert.strictEqual(out.rows.length, 2, "the rows were withheld");
        assert.strictEqual(out.learned_recipe, undefined, "a 2-row spec was learned");
        assert.deepStrictEqual(store().recipes, {}, JSON.stringify(store().recipes));
      },
    );

    await withRecipeServer({}, async ({ srv, store }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_click", { selector: "#facet-eng" });
      await call(srv, "browser_extract", { ...LIVE_SPEC });
      const steps = store().recipes["/search"]["name-url"].variants.default.steps;
      assert.deepStrictEqual(
        steps.map((s) => s.selector),
        ["#facet-eng"],
        JSON.stringify(steps),
      );
    });
  });

  await test("P35 steps recorded under one session never reach another's recipe", async () => {
    await withRecipeServer({}, async ({ srv, store }) => {
      await call(srv, "browser_navigate", { url: "http://t/search", session: "s1" });
      await call(srv, "browser_click", { selector: "#s1-facet", session: "s1" });

      await call(srv, "browser_navigate", { url: "http://t/search", session: "s2" });
      await call(srv, "browser_extract", { ...LIVE_SPEC, session: "s2" });

      const steps = store().recipes["/search"]["name-url"].variants.default.steps;
      assert.deepStrictEqual(
        steps,
        [],
        `one task's preamble was borrowed by another: ${JSON.stringify(steps)}`,
      );
    });
  });

  await test("P36 a secret-looking fill is recorded without its value", async () => {
    await withRecipeServer(
      {
        ext: {
          fingerprints: {
            "#login-pw": { tag: "input", attrs: { type: "password" } },
            "#otp-code": { tag: "input", attrs: { type: "text" } },
            "#q": { tag: "input", attrs: { type: "text", name: "q" } },
          },
        },
      },
      async ({ srv, store }) => {
        await call(srv, "browser_navigate", { url: "http://t/search" });
        await call(srv, "browser_fill", { selector: "#login-pw", value: "hunter2" });
        await call(srv, "browser_fill", { selector: "#otp-code", value: "483920" });
        await call(srv, "browser_fill", { selector: "#q", value: "remote" });
        await call(srv, "browser_extract", { ...LIVE_SPEC });

        const steps = store().recipes["/search"]["name-url"].variants.default.steps;
        const bySel = Object.fromEntries(steps.map((s) => [s.selector, s]));
        for (const sel of ["#login-pw", "#otp-code"]) {
          assert.strictEqual(bySel[sel].redacted, true, `${sel} not marked redacted`);
          assert.strictEqual(bySel[sel].value, undefined, `${sel} kept a value`);
        }
        assert.strictEqual(bySel["#q"].value, "remote", JSON.stringify(bySel["#q"]));
        const raw = JSON.stringify(store());
        assert.ok(!raw.includes("hunter2"), "a password was written to disk");
        assert.ok(!raw.includes("483920"), "an OTP was written to disk");
      },
    );
  });

  await test("P37 a navigate to another host drops the buffered preamble", async () => {
    await withRecipeServer({}, async ({ srv, store }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_click", { selector: "#facet-eng" });
      // A flow that crossed sites is not one preamble.
      await call(srv, "browser_navigate", { url: "http://elsewhere/x" });
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_extract", { ...LIVE_SPEC });

      const steps = store().recipes["/search"]["name-url"].variants.default.steps;
      assert.deepStrictEqual(
        steps,
        [],
        `a step from before a cross-site jump survived: ${JSON.stringify(steps)}`,
      );
    });
  });

  await test("P38 a collapsed fill rate reports stale, returns the rows, and names the field", async () => {
    await withRecipeServer(
      { seed: seededStore(), ext: { rows: salaryGone } },
      async ({ srv }) => {
        await call(srv, "browser_navigate", { url: "http://t/search" });
        const out = jsonOf(await call(srv, "browser_extract", {}));
        assert.strictEqual(out.stale, true, JSON.stringify(out).slice(0, 400));
        assert.strictEqual(out.rows.length, 12, "the rows were swallowed");
        const warn = (out.warnings || []).join(" ");
        assert.ok(/salary/.test(warn), warn);
        assert.ok(/snapshot/.test(warn), warn);
      },
    );
  });

  await test("P39 a stale replay leaves the stored baseline byte-identical", async () => {
    await withRecipeServer(
      { seed: seededStore(), ext: { rows: salaryGone } },
      async ({ srv, store }) => {
        const before = JSON.stringify(
          store().recipes["/search"]["name-salary"].variants.default.baseline,
        );
        await call(srv, "browser_navigate", { url: "http://t/search" });
        await call(srv, "browser_extract", {});
        const after = store().recipes["/search"]["name-salary"].variants.default;
        // The ratchet: if a degrading site can rewrite its own baseline it walks
        // it down a little at a time and staleness never fires again.
        assert.strictEqual(JSON.stringify(after.baseline), before, "baseline was rewritten");
        assert.strictEqual(after.failCount, 1, "the miss was not counted");
      },
    );
  });

  await test("P40 zero records on a replay reports the record selector as gone", async () => {
    await withRecipeServer(
      { seed: seededStore(), ext: { rows: () => [], records_found: 0 } },
      async ({ srv }) => {
        await call(srv, "browser_navigate", { url: "http://t/search" });
        const out = jsonOf(await call(srv, "browser_extract", {}));
        assert.strictEqual(out.stale, true, JSON.stringify(out).slice(0, 400));
        const warn = (out.warnings || []).join(" ");
        assert.ok(/record selector/.test(warn), warn);
        assert.ok(/snapshot/.test(warn), warn);
      },
    );
  });

  await test("P41 three stale replays delete the variant, and the recipe with it", async () => {
    await withRecipeServer(
      { seed: seededStore(), ext: { rows: salaryGone } },
      async ({ srv, store }) => {
        await call(srv, "browser_navigate", { url: "http://t/search" });
        for (let i = 0; i < 3; i++) {
          const out = jsonOf(await call(srv, "browser_extract", {}));
          assert.strictEqual(out.stale, true, `replay ${i} did not report stale`);
        }
        assert.deepStrictEqual(
          store().recipes,
          {},
          `a dead recipe survived: ${JSON.stringify(store().recipes)}`,
        );
        // And with it gone, the next specless extract says so rather than
        // replaying a husk.
        const reply = await call(srv, "browser_extract", {});
        assert.ok(reply.result.isError, textOf(reply));
      },
    );
  });

  await test("P42 get_site_memory lists recipes as dated observations", async () => {
    await withRecipeServer({ seed: seededStore() }, async ({ srv }) => {
      const text = textOf(
        await call(srv, "browser_get_site_memory", { hostname: "t" }),
      );
      assert.ok(/12 per page/.test(text), `the notes were dropped: ${text}`);
      assert.ok(/name-salary/.test(text), text);
      assert.ok(/\/search/.test(text), text);
      assert.ok(/3d ago: click #facet-eng/.test(text), text);
      assert.ok(/3d ago: fill #q/.test(text), text);
      // Compact by construction: the field map and the record selector are what
      // make a recipe expensive to quote, and the model does not need them to
      // decide whether to use one.
      assert.ok(!/\.card/.test(text), `the record selector was dumped: ${text}`);
      assert.ok(!/a\.name/.test(text), `the field map was dumped: ${text}`);
    });
  });

  await test("P43 extract_all stores its url_template and replays it", async () => {
    await withRecipeServer({}, async ({ srv, ext, store }) => {
      const template = "http://t/agents?page={page}";
      const first = jsonOf(
        await call(srv, "browser_extract_all", {
          url_template: template,
          ...LIVE_SPEC,
          key: "url",
          limit: 12,
        }),
      );
      assert.strictEqual(first.count, 12, JSON.stringify(first).slice(0, 300));
      assert.strictEqual(first.learned_recipe, "name-url/default", JSON.stringify(first).slice(0, 300));
      const stored = store().recipes["/agents"]["name-url"];
      assert.strictEqual(stored.extract.url_template, template, JSON.stringify(stored.extract));

      const before = ext.extracts.length;
      const second = jsonOf(
        await call(srv, "browser_extract_all", {
          url_template: template,
          key: "url",
          limit: 12,
        }),
      );
      assert.strictEqual(second.used_recipe, "name-url/default", JSON.stringify(second).slice(0, 300));
      assert.strictEqual(second.count, 12, JSON.stringify(second).slice(0, 300));
      assert.strictEqual(
        ext.extracts[before].record,
        ".card",
        "the replayed spec never reached the page",
      );
    });
  });

  await test("P44 an output_file summary still says which recipe it used", async () => {
    await withRecipeServer({}, async ({ srv }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_extract", { ...LIVE_SPEC });
      const out = jsonOf(
        await call(srv, "browser_extract", { output_file: "agents.json" }),
      );
      assert.ok(out.file, JSON.stringify(out).slice(0, 300));
      assert.strictEqual(out.rows, 12, JSON.stringify(out).slice(0, 300));
      // The run that wrote to disk is exactly the run where the model cannot
      // see the rows for itself, so dropping used_recipe here hides a replay.
      assert.strictEqual(out.used_recipe, "name-url/default", JSON.stringify(out).slice(0, 300));
    });
  });
}

module.exports = groupP;
