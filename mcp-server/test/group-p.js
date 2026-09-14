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

  await test("P20 deriveName is deterministic, and two specs never share a name", () => {
    const fields = { Name: 1, "Job Title": 1, salary: 1, url: 1 };
    const name = recipes.deriveName(fields, ".card");
    assert.ok(/^name-job-title-salary-[0-9a-f]{4}$/.test(name), name);
    assert.strictEqual(recipes.deriveName(fields, ".card"), name, "not deterministic");
    assert.ok(
      /^name-title-salary-[0-9a-f]{4}$/.test(
        recipes.deriveName({ name: 1, title: 1, salary: 1 }, ".card"),
      ),
      recipes.deriveName({ name: 1, title: 1, salary: 1 }, ".card"),
    );
    assert.ok(/^default-[0-9a-f]{4}$/.test(recipes.deriveName({})), recipes.deriveName({}));
    assert.ok(/^default-[0-9a-f]{4}$/.test(recipes.deriveName(undefined)));

    // The readable stem still stops at three fields, so {title, company, link,
    // salary} and {title, company, link} share it. The digest is what stops the
    // three-field spec from being written over the four-field recipe's
    // `extract` — which lost `salary` from the stored spec and its baseline
    // with nothing said.
    const four = { title: 1, company: 1, link: 1, salary: 1 };
    const three = { title: 1, company: 1, link: 1 };
    assert.notStrictEqual(
      recipes.deriveName(four, ".card"),
      recipes.deriveName(three, ".card"),
      "two different specs derived one name",
    );
    // The record selector is part of a spec's identity too.
    assert.notStrictEqual(
      recipes.deriveName(three, ".card"),
      recipes.deriveName(three, ".row"),
    );
    // And the same spec IS the same task: that collision is the intended one,
    // or two runs accumulate near-duplicate recipes.
    assert.strictEqual(
      recipes.deriveName({ title: 1, company: 1, link: 1 }, ".card"),
      recipes.deriveName(three, ".card"),
    );
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
        // The real extension echoes back the value it typed, which is what
        // P56 checks the server strips for a redacted fill.
        if (m.value !== undefined) data.value = m.value;
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

  const ROW_SPEC = {
    record: ".row",
    fields: {
      title: { sel: "h3", get: "text" },
      pay: { sel: ".pay", get: "text" },
    },
  };

  // The names the server derives for those two specs. Pinning the literal
  // digest here would assert the hash rather than the rule; what the rule
  // promises is that one spec always lands on one name and two specs never
  // land on the same one, which P20 and P51 assert directly.
  const LIVE_NAME = recipes.deriveName(LIVE_SPEC.fields, LIVE_SPEC.record);
  const ROW_NAME = recipes.deriveName(ROW_SPEC.fields, ROW_SPEC.record);

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
        `${LIVE_NAME}/default`,
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
        [LIVE_NAME],
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
      assert.strictEqual(
        out.used_recipe,
        `${LIVE_NAME}/default`,
        JSON.stringify(out).slice(0, 300),
      );
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
      await call(srv, "browser_extract", { ...ROW_SPEC });
      const before = ext.extracts.length;

      const reply = await call(srv, "browser_extract", {});
      assert.ok(reply.result.isError, "the server guessed between two recipes");
      const text = textOf(reply);
      assert.ok(text.includes(LIVE_NAME), text);
      assert.ok(text.includes(ROW_NAME), text);
      assert.strictEqual(ext.extracts.length, before, "extracted anyway");

      // Naming one resolves it.
      const picked = jsonOf(
        await call(srv, "browser_extract", { recipe: ROW_NAME }),
      );
      assert.strictEqual(picked.used_recipe, `${ROW_NAME}/default`);
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
        [LIVE_NAME],
        `the same task was learned twice: ${Object.keys(bucket)}`,
      );
      assert.deepStrictEqual(
        Object.keys(bucket[LIVE_NAME].variants).sort(),
        ["default", "mobile"],
      );
      assert.strictEqual(
        out.learned_recipe,
        `${LIVE_NAME}/mobile`,
        JSON.stringify(out).slice(0, 300),
      );
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
      // And the slice is filed under the preamble that produced it, not under
      // "default" — see P48 for what sharing "default" cost.
      const variants = store().recipes["/search"][LIVE_NAME].variants;
      assert.deepStrictEqual(
        Object.keys(variants),
        ["click.facet-eng"],
        JSON.stringify(Object.keys(variants)),
      );
      const steps = variants["click.facet-eng"].steps;
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

      const steps = store().recipes["/search"][LIVE_NAME].variants.default.steps;
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

        const variants = store().recipes["/search"][LIVE_NAME].variants;
        assert.deepStrictEqual(
          Object.keys(variants),
          ["fill.login-pw+fill.otp-code+fill.q"],
          JSON.stringify(Object.keys(variants)),
        );
        const steps = Object.values(variants)[0].steps;
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

      const steps = store().recipes["/search"][LIVE_NAME].variants.default.steps;
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

  await test("P40 zero records on a replay reports stale and names the causes", async () => {
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
      assert.strictEqual(
        first.learned_recipe,
        `${LIVE_NAME}/default`,
        JSON.stringify(first).slice(0, 300),
      );
      const stored = store().recipes["/agents"][LIVE_NAME];
      assert.strictEqual(stored.extract.url_template, template, JSON.stringify(stored.extract));

      const before = ext.extracts.length;
      const second = jsonOf(
        await call(srv, "browser_extract_all", {
          url_template: template,
          key: "url",
          limit: 12,
        }),
      );
      assert.strictEqual(
        second.used_recipe,
        `${LIVE_NAME}/default`,
        JSON.stringify(second).slice(0, 300),
      );
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
      assert.strictEqual(
        out.used_recipe,
        `${LIVE_NAME}/default`,
        JSON.stringify(out).slice(0, 300),
      );
    });
  });

  console.log("\nP. variant identity, name collisions, and what a replay says");

  await test("P45 deriveVariant keys a slice on its preamble, in seq order", () => {
    const eng = [
      { seq: 0, action: "click", selector: "#facet-eng" },
      { seq: 1, action: "click", selector: "#facet-remote" },
    ];
    assert.strictEqual(
      recipes.deriveVariant(eng),
      "click.facet-eng+click.facet-remote",
      recipes.deriveVariant(eng),
    );
    assert.strictEqual(recipes.deriveVariant(eng), recipes.deriveVariant(eng), "not deterministic");

    // A task with no preamble genuinely has one slice.
    assert.strictEqual(recipes.deriveVariant([]), "default");
    assert.strictEqual(recipes.deriveVariant(undefined), "default");

    // Read in seq order, never in arrival order, or one slice mints a second
    // variant depending on how its steps happened to be buffered.
    assert.strictEqual(
      recipes.deriveVariant([{ ...eng[1] }, { ...eng[0] }]),
      recipes.deriveVariant(eng),
    );

    // Two preambles are two slices.
    assert.notStrictEqual(
      recipes.deriveVariant(eng),
      recipes.deriveVariant([{ seq: 0, action: "click", selector: "#facet-design" }]),
    );
    // Same selector, different action: a fill on #q and a click on #q leave
    // the page in different states, so they are not one slice.
    assert.notStrictEqual(
      recipes.deriveVariant([{ seq: 0, action: "fill", selector: "#q" }]),
      recipes.deriveVariant([{ seq: 0, action: "click", selector: "#q" }]),
    );
  });

  await test("P46 deriveVariant ignores fill values and scroll counts", () => {
    const term = (value) => [{ seq: 0, action: "fill", selector: "#q", value }];
    // Keying on the value would make variants unbounded: every search term
    // typed into one box would mint a slice and churn the cap.
    assert.strictEqual(
      recipes.deriveVariant(term("remote")),
      recipes.deriveVariant(term("onsite")),
      "every search term minted its own variant",
    );
    // And a redacted fill has no value to key on in the first place.
    assert.strictEqual(
      recipes.deriveVariant([{ seq: 0, action: "fill", selector: "#q", redacted: true }]),
      recipes.deriveVariant(term("remote")),
    );

    const scroll = (count) => [{ seq: 0, action: "smart_scroll", selector: null, count }];
    assert.strictEqual(
      recipes.deriveVariant(scroll(5)),
      recipes.deriveVariant(scroll(40)),
      "scrolling further was treated as a different slice of the task",
    );
  });

  await test("P47 a preamble past the label cap is truncated but stays distinct", () => {
    const long = (tail) =>
      Array.from({ length: 12 }, (_, i) => ({
        seq: i,
        action: "click",
        selector: `#facet-number-${i}${i === 11 ? tail : ""}`,
      }));
    const a = recipes.deriveVariant(long("a"));
    const b = recipes.deriveVariant(long("b"));
    assert.ok(a.length <= recipes.VARIANT_LABEL_CAP + 8, `${a.length}: ${a}`);
    assert.strictEqual(a, recipes.deriveVariant(long("a")), "not deterministic past the cap");
    assert.notStrictEqual(
      a,
      b,
      "two long preambles sharing a prefix collapsed into one variant",
    );
  });

  await test("P48 two preambles over one spec are two variants with two baselines", () => {
    const host = "p48.example";
    const ctx = { host, pattern: "/search", hydrated: false };
    const spec = {
      record: ".card",
      fields: {
        title: { sel: "h3", get: "text" },
        salary: { sel: ".pay", get: "text" },
      },
    };
    const seen = (fill_rates) => result({ fill_rates });

    // Slice one: the eng+remote facets, where salary is filled on 11 of 12.
    recipes.noteStep("p48", { action: "click", selector: "#facet-eng", path: "/search" });
    recipes.noteStep("p48", { action: "click", selector: "#facet-remote", path: "/search" });
    const eng = recipes.observe({
      action: "extract",
      args: { ...spec },
      result: seen({ title: 12, salary: 11 }),
      ctx,
      targetKey: "p48",
    });

    // Slice two: an IDENTICAL spec behind different facets, where salary is
    // barely populated at all.
    recipes.noteStep("p48", { action: "click", selector: "#facet-design", path: "/search" });
    recipes.noteStep("p48", { action: "click", selector: "#facet-onsite", path: "/search" });
    const design = recipes.observe({
      action: "extract",
      args: { ...spec },
      result: seen({ title: 12, salary: 1 }),
      ctx,
      targetKey: "p48",
    });

    assert.notStrictEqual(
      eng.learned_recipe,
      design.learned_recipe,
      "the second slice was written over the first",
    );
    const bucket = memory.getRecipes(host, "/search");
    const names = Object.keys(bucket);
    assert.strictEqual(names.length, 1, `one spec became ${names.length} recipes: ${names}`);
    const variants = bucket[names[0]].variants;
    assert.strictEqual(
      Object.keys(variants).length,
      2,
      `two slices shared one variant: ${JSON.stringify(Object.keys(variants))}`,
    );
    assert.deepStrictEqual(
      Object.values(variants)
        .map((v) => v.baseline.salary)
        .sort(),
      [1 / 12, 11 / 12],
      "one slice's baseline overwrote the other's",
    );

    // The point of keeping them apart: judged against its OWN bar, the eng
    // slice can still report salary collapsing. Under a shared "default" the
    // 8% baseline won, and collapsed() skips any baseline below 0.5 — so
    // salary on this recipe could never be reported stale again.
    const engEntry = variants[eng.learned_recipe.split("/")[1]];
    assert.deepStrictEqual(
      recipes.collapsed(engEntry.baseline, { title: 1, salary: 0.08 }, 0.5),
      ["salary"],
      JSON.stringify(engEntry.baseline),
    );
  });

  await test("P49 a replay drains the step buffer instead of lending it forward", () => {
    memory.putRecipe("p49.example", "/search", "titles", recipe("click.facet-eng", 10));
    recipes.noteStep("p49", { action: "click", selector: "#facet-eng", path: "/search" });
    const patch = recipes.observe({
      action: "extract",
      args: {},
      result: result(),
      ctx: {
        host: "p49.example",
        pattern: "/search",
        name: "titles",
        variant: "click.facet-eng",
        baseline: { name: 1 },
        hydrated: true,
      },
      targetKey: "p49",
    });
    assert.strictEqual(patch.used_recipe, "titles/click.facet-eng");
    assert.deepStrictEqual(
      recipes.takeSteps("p49"),
      [],
      "a replay's steps survived to be merged into the next slice's preamble",
    );
  });

  await test("P50 a replay's preamble does not follow the next slice into the store", async () => {
    await withRecipeServer({}, async ({ srv, store }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_click", { selector: "#facet-eng" });
      await call(srv, "browser_extract", { ...LIVE_SPEC });

      // A replay in between, with a click of its own. Both have already served
      // their purpose by the time it returns.
      await call(srv, "browser_click", { selector: "#page-size-100" });
      const replay = jsonOf(await call(srv, "browser_extract", {}));
      assert.strictEqual(
        replay.used_recipe,
        `${LIVE_NAME}/click.facet-eng`,
        JSON.stringify(replay).slice(0, 300),
      );

      await call(srv, "browser_click", { selector: "#facet-design" });
      await call(srv, "browser_extract", { ...LIVE_SPEC });

      const variants = store().recipes["/search"][LIVE_NAME].variants;
      assert.deepStrictEqual(
        Object.keys(variants).sort(),
        ["click.facet-design", "click.facet-eng"],
        JSON.stringify(Object.keys(variants)),
      );
      assert.deepStrictEqual(
        variants["click.facet-design"].steps.map((s) => s.selector),
        ["#facet-design"],
        `a replay's preamble was attributed to the next slice: ${JSON.stringify(
          variants["click.facet-design"].steps,
        )}`,
      );
    });
  });

  await test("P51 a spec and its three-field prefix are two recipes, not one", async () => {
    const three = {
      record: ".card",
      fields: {
        title: { sel: "h3", get: "text" },
        company: { sel: ".co", get: "text" },
        link: { sel: "a", get: "href" },
      },
    };
    const four = {
      record: ".card",
      fields: { ...three.fields, salary: { sel: ".pay", get: "text" } },
    };
    await withRecipeServer({}, async ({ srv, store }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_extract", { ...four });
      await call(srv, "browser_extract", { ...three });

      const bucket = store().recipes["/search"];
      const names = Object.keys(bucket);
      assert.strictEqual(names.length, 2, `two specs collapsed onto one name: ${names}`);
      const stored = names.map((n) => Object.keys(bucket[n].extract.fields).sort().join(","));
      // The three-field spec used to be written straight over the four-field
      // recipe's `extract`, and `salary` was gone from the spec and from the
      // baseline with nothing said about it.
      assert.ok(
        stored.includes("company,link,salary,title"),
        `the four-field spec lost a field: ${JSON.stringify(stored)}`,
      );
      assert.ok(stored.includes("company,link,title"), JSON.stringify(stored));
    });
  });

  await test("P52 an explicit remember name cannot destroy the recipe under it", () => {
    const host = "p52.example";
    const ctx = { host, pattern: "/search", hydrated: false };
    const fields = {
      title: { sel: "h3", get: "text" },
      company: { sel: ".co", get: "text" },
      link: { sel: "a", get: "href" },
    };
    const four = { record: ".card", fields: { ...fields, salary: { sel: ".pay", get: "text" } } };
    const three = { record: ".card", fields };

    const first = recipes.observe({
      action: "extract",
      args: { ...four, remember: "jobs" },
      result: result(),
      ctx,
      targetKey: "p52",
    });
    assert.strictEqual(first.learned_recipe, "jobs/default", JSON.stringify(first));

    const second = recipes.observe({
      action: "extract",
      args: { ...three, remember: "jobs" },
      result: result(),
      ctx,
      targetKey: "p52",
    });
    const bucket = memory.getRecipes(host, "/search");
    assert.deepStrictEqual(
      Object.keys(bucket.jobs.extract.fields).sort(),
      ["company", "link", "salary", "title"],
      "an explicit name overwrote another spec's recipe",
    );

    // Stored beside it, and the model told where to find it — a name it cannot
    // have is more useful said out loud than silently honoured.
    assert.ok(second.learned_recipe.startsWith("jobs-"), second.learned_recipe);
    const alt = second.learned_recipe.split("/")[0];
    assert.ok(bucket[alt], `${alt} was not stored: ${Object.keys(bucket)}`);
    assert.deepStrictEqual(
      Object.keys(bucket[alt].extract.fields).sort(),
      ["company", "link", "title"],
    );
    assert.ok(
      (second.warnings || []).some((w) => /already describes a different extract spec/.test(w)),
      JSON.stringify(second.warnings),
    );
    assert.ok(
      (second.warnings || []).some((w) => w.includes(alt)),
      "the warning never names what to replay instead",
    );
  });

  await test("P53 variants are capped per recipe, evicting the stalest slice", () => {
    // lastOk ascending, so v0 is the stalest slice and v11 the freshest.
    for (let i = 0; i < 12; i++)
      memory.putRecipe("p53.example", "/jobs", "titles", recipe("v" + i, 1000 + i));
    const keys = Object.keys(
      memory.getRecipe("p53.example", "/jobs", "titles").variants,
    );
    assert.strictEqual(memory.VARIANTS_CAP, 8);
    // evictRecipes counts recipes, not variants: without this cap one site
    // with many facet combinations grows one recipe without bound.
    assert.strictEqual(keys.length, memory.VARIANTS_CAP, `cap not enforced: ${keys}`);
    assert.ok(!keys.includes("v3"), `a stale slice survived eviction: ${keys}`);
    assert.ok(keys.includes("v4"), `evicted one too many: ${keys}`);
    assert.ok(keys.includes("v11"), "the freshest slice was evicted");
  });

  await test("P54 noteRecipeFail reports what it deleted", () => {
    const fail = () => memory.noteRecipeFail("p54.example", "/jobs", "titles", "remote");
    memory.putRecipe("p54.example", "/jobs", "titles", recipe("remote", 10));
    memory.putRecipe("p54.example", "/jobs", "titles", recipe("onsite", 20));
    assert.deepStrictEqual(fail(), { variant: false, recipe: false, fails: 1 });
    fail();
    // The slice goes; the recipe survives on its other one.
    assert.deepStrictEqual(fail(), { variant: true, recipe: false, fails: 3 });

    const onsite = () => memory.noteRecipeFail("p54.example", "/jobs", "titles", "onsite");
    onsite();
    onsite();
    assert.deepStrictEqual(onsite(), { variant: true, recipe: true, fails: 3 });
    // A miss against something that was never learned reports nothing gone,
    // rather than throwing on the extract path.
    assert.deepStrictEqual(onsite(), { variant: false, recipe: false, fails: 0 });
  });

  await test("P55 a recipe forgotten after three stale replays says so", async () => {
    await withRecipeServer(
      { seed: seededStore(), ext: { rows: salaryGone } },
      async ({ srv, store }) => {
        await call(srv, "browser_navigate", { url: "http://t/search" });
        const outs = [];
        for (let i = 0; i < 3; i++) outs.push(jsonOf(await call(srv, "browser_extract", {})));

        const early = (outs[0].warnings || []).join(" ");
        assert.ok(!/forgotten/.test(early), `announced before it happened: ${early}`);

        // Unsaid, the model expects a recipe to be there next time and gets an
        // error instead of reaching for a snapshot.
        const last = (outs[2].warnings || []).join(" ");
        assert.ok(/forgotten/.test(last), last);
        assert.ok(/name-salary/.test(last), last);
        assert.ok(/snapshot/.test(last), last);
        assert.deepStrictEqual(store().recipes, {}, "the recipe outlived the warning");
      },
    );
  });

  await test("P56 a redacted fill's echoed value is stripped, a plain one's is not", async () => {
    await withRecipeServer(
      {
        ext: {
          fingerprints: {
            "#login-pw": { tag: "input", attrs: { type: "password" } },
            "#q": { tag: "input", attrs: { type: "text", name: "q" } },
          },
        },
      },
      async ({ srv }) => {
        await call(srv, "browser_navigate", { url: "http://t/search" });
        // Keeping the password out of the store is no use if the echo puts it
        // in the model's context and from there into the transcript.
        const secret = jsonOf(
          await call(srv, "browser_fill", { selector: "#login-pw", value: "hunter2x" }),
        );
        assert.ok(
          !JSON.stringify(secret).includes("hunter2x"),
          `the value was echoed back: ${JSON.stringify(secret)}`,
        );

        // A plain fill echoing its value is worth reading, so only a redacted
        // one loses it.
        const plain = jsonOf(
          await call(srv, "browser_fill", { selector: "#q", value: "remote" }),
        );
        assert.strictEqual(plain.value, "remote", JSON.stringify(plain));
      },
    );
  });

  await test("P57 a zero-record replay names the preamble, not just the selector", async () => {
    await withRecipeServer(
      { seed: seededStore(), ext: { rows: () => [], records_found: 0 } },
      async ({ srv }) => {
        await call(srv, "browser_navigate", { url: "http://t/search" });
        const out = jsonOf(await call(srv, "browser_extract", {}));
        const warn = (out.warnings || []).join(" ");
        // The likelier cause is a page that was never put back into the state
        // the recipe was learned in, and the spec is perfectly correct. Naming
        // only the selector sent the model off rewriting a spec that was fine.
        assert.ok(/preamble/.test(warn), warn);
        assert.ok(/get_site_memory/.test(warn), warn);
        assert.ok(/record selector/.test(warn), warn);
      },
    );
  });

  // One spec, several slices of it — the shape the store is in once two facet
  // combinations have been learned under one recipe.
  function seedVariants(host, names) {
    for (const name of names)
      memory.putRecipe(host, "/search", "titles", {
        extract: { record: ".card", fields: { name: { sel: "h3", get: "text" } } },
        variants: {
          [name]: { steps: [], baseline: { name: 1 }, lastOk: Date.now(), failCount: 0 },
        },
      });
  }

  // The clicks a caller issued on this target, as index.js would have recorded
  // them before calling hydrate.
  function clicked(targetKey, host, selectors) {
    recipes.clearSteps(targetKey);
    for (const selector of selectors)
      recipes.noteStep(targetKey, { action: "click", selector, path: "/search", host });
  }

  const hydrateOn = (host, targetKey, args = {}) =>
    recipes.hydrate("extract", args, { host, path: "/search" }, targetKey);

  await test("P58 the steps just issued pick the slice, with no `variant` argument", () => {
    const host = "p58.example";
    seedVariants(host, ["click.facet-eng+click.facet-remote", "click.facet-design"]);
    clicked("p58", host, ["#facet-eng", "#facet-remote"]);

    // The server was holding these two clicks itself. Demanding the caller type
    // back a string it had just produced by acting is why "extract with no spec
    // at all" stopped working the moment a second slice existed.
    const ctx = hydrateOn(host, "p58");
    assert.strictEqual(ctx.variant, "click.facet-eng+click.facet-remote", ctx.variant);

    // observe owns draining. A read here that consumed the buffer would leave
    // the next extract in this page state with no preamble at all.
    assert.strictEqual(
      recipes.takeSteps("p58").length,
      2,
      "hydrate drained the buffer observe still needs",
    );
  });

  await test("P59 an exact match wins over a slice that is only a prefix", () => {
    const host = "p59.example";
    seedVariants(host, ["click.facet-eng", "click.facet-eng+click.facet-remote"]);
    clicked("p59", host, ["#facet-eng", "#facet-remote"]);
    assert.strictEqual(
      hydrateOn(host, "p59").variant,
      "click.facet-eng+click.facet-remote",
    );

    // A slice still counts when nothing matches the whole buffer and only one
    // occurs in it: the caller may have done the recorded preamble and then
    // some.
    const other = "p59b.example";
    seedVariants(other, ["click.facet-eng+click.facet-remote", "click.facet-design"]);
    clicked("p59b", other, ["#facet-eng", "#facet-remote", "#facet-senior"]);
    assert.strictEqual(
      hydrateOn(other, "p59b").variant,
      "click.facet-eng+click.facet-remote",
    );
  });

  await test("P60 two slices matching the buffer errors rather than guessing", () => {
    const host = "p60.example";
    seedVariants(host, [
      "click.facet-remote+click.facet-senior",
      "click.facet-senior",
    ]);
    clicked("p60", host, ["#facet-eng", "#facet-remote", "#facet-senior"]);
    // Both runs end on the same click, so neither is the more recent one.
    // Picking either returns the other slice's records as if they were the
    // ones asked for.
    assert.throws(() => hydrateOn(host, "p60"), /2 variants: /);
  });

  await test("P61 a buffer matching no slice errors, listing the slices", () => {
    const host = "p61.example";
    seedVariants(host, ["click.facet-eng", "click.facet-remote"]);
    clicked("p61", host, ["#facet-design"]);
    assert.throws(() => hydrateOn(host, "p61"), /click\.facet-eng, click\.facet-remote/);

    // And an explicit `variant` still overrules whatever is buffered.
    assert.strictEqual(
      hydrateOn(host, "p61", { variant: "click.facet-remote" }).variant,
      "click.facet-remote",
    );
  });

  await test("P62 a slice is not matched across a segment boundary", () => {
    const host = "p62.example";
    seedVariants(host, ["click.facet-eng", "click.facet-design"]);
    clicked("p62", host, ["#facet-english", "#facet-remote"]);
    // "click.facet-eng" IS a string prefix of "click.facet-english+...", and
    // matching it would replay the wrong slice's baseline. Segments, not bytes.
    assert.throws(() => hydrateOn(host, "p62"), /2 variants: /);
  });

  await test("P63 a replay follows the clicks the caller just made, and says so", async () => {
    await withRecipeServer({}, async ({ srv, store }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_click", { selector: "#facet-eng" });
      await call(srv, "browser_extract", { ...LIVE_SPEC });

      await call(srv, "browser_click", { selector: "#facet-design" });
      await call(srv, "browser_extract", { ...LIVE_SPEC });
      assert.deepStrictEqual(
        Object.keys(store().recipes["/search"][LIVE_NAME].variants).sort(),
        ["click.facet-design", "click.facet-eng"],
      );

      // Two slices now exist, and this is the call that used to be refused.
      await call(srv, "browser_click", { selector: "#facet-eng" });
      const out = jsonOf(await call(srv, "browser_extract", {}));
      assert.strictEqual(out.used_recipe, `${LIVE_NAME}/click.facet-eng`, JSON.stringify(out).slice(0, 300));
      // Which slice it got, and why, or the choice is invisible to the caller.
      const chosen = out.variant_chosen_from_steps || "";
      assert.ok(/click\.facet-eng/.test(chosen), chosen);
      assert.ok(/steps recorded/.test(chosen), chosen);
    });
  });

  await test("P64 two extracts in one page state share the preamble that produced them", async () => {
    await withRecipeServer({}, async ({ srv, store }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_click", { selector: "#facet-eng" });
      await call(srv, "browser_click", { selector: "#facet-remote" });
      await call(srv, "browser_extract", { ...LIVE_SPEC });
      // Nothing between the two: the second recipe needs exactly the same two
      // clicks to reproduce, and used to be learned with steps: [] — which
      // then sent a stale replay to read a preamble that was not there.
      await call(srv, "browser_extract", { ...ROW_SPEC });

      const key = "click.facet-eng+click.facet-remote";
      const bucket = store().recipes["/search"];
      assert.deepStrictEqual(Object.keys(bucket[LIVE_NAME].variants), [key]);
      assert.deepStrictEqual(Object.keys(bucket[ROW_NAME].variants), [key]);
      assert.deepStrictEqual(
        bucket[ROW_NAME].variants[key].steps.map((s) => s.selector),
        ["#facet-eng", "#facet-remote"],
        JSON.stringify(bucket[ROW_NAME].variants[key].steps),
      );
    });
  });

  await test("P65 a click between two extracts discards the retained preamble", async () => {
    await withRecipeServer({}, async ({ srv, store }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_click", { selector: "#facet-eng" });
      await call(srv, "browser_extract", { ...LIVE_SPEC });

      await call(srv, "browser_click", { selector: "#facet-design" });
      await call(srv, "browser_extract", { ...ROW_SPEC });

      // The moment a new step arrives the page is no longer in the state the
      // first extract was taken in, so the second slice gets its own steps and
      // nothing else — the four-click merge P50 exists to stop.
      const variants = store().recipes["/search"][ROW_NAME].variants;
      assert.deepStrictEqual(Object.keys(variants), ["click.facet-design"]);
      assert.deepStrictEqual(
        variants["click.facet-design"].steps.map((s) => s.selector),
        ["#facet-design"],
        JSON.stringify(variants["click.facet-design"].steps),
      );
    });
  });

  await test("P66 a cross-host navigate drops the retained preamble too", async () => {
    await withRecipeServer({}, async ({ srv, store }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_click", { selector: "#facet-eng" });
      await call(srv, "browser_extract", { ...LIVE_SPEC });

      await call(srv, "browser_navigate", { url: "http://elsewhere/x" });
      await call(srv, "browser_navigate", { url: "http://t/search" });
      await call(srv, "browser_extract", { ...ROW_SPEC });

      // Retention obeys the same invalidation the buffer does: a flow that
      // crossed sites is not one preamble, drained or not.
      assert.deepStrictEqual(
        Object.keys(store().recipes["/search"][ROW_NAME].variants),
        ["default"],
      );
    });
  });

  await test("P67 a retained preamble older than the TTL is not reused", () => {
    recipes.clearSteps("p67");
    recipes.noteStep("p67", { action: "click", selector: "#facet-eng", path: "/search" });
    assert.strictEqual(recipes.drainSteps("p67").length, 1);
    // Still the same page state a moment later.
    assert.strictEqual(recipes.drainSteps("p67").length, 1, "the drained preamble was not retained");
    // Ten minutes on it belongs to work the user has moved on from, exactly as
    // an open buffer of the same age does.
    assert.deepStrictEqual(
      recipes.drainSteps("p67", Date.now() + recipes.STEP_TTL_MS + 1),
      [],
      "a retained preamble outlived the buffer TTL",
    );
    assert.deepStrictEqual(recipes.drainSteps("p67"), [], "the expired copy was not dropped");
  });

  await test("P68 a zero-record replay of a recipe with no preamble says so", async () => {
    await withRecipeServer(
      {
        seed: seededStore({ variant: { steps: [] } }),
        ext: { rows: () => [], records_found: 0 },
      },
      async ({ srv }) => {
        await call(srv, "browser_navigate", { url: "http://t/search" });
        const out = jsonOf(await call(srv, "browser_extract", {}));
        const warn = (out.warnings || []).join(" ");
        // Sending the model to browser_get_site_memory for a preamble that was
        // never recorded lands it on an empty list, which trains it to ignore
        // the warning entirely.
        assert.ok(!/get_site_memory/.test(warn), warn);
        assert.ok(/no preamble/.test(warn), warn);
        assert.ok(/record selector/.test(warn), warn);
      },
    );
  });

  await test("P69 a caller who switched slices gets the one it switched TO", () => {
    const host = "p69.example";
    seedVariants(host, [
      "click.facet-eng+click.facet-remote",
      "click.facet-design+click.facet-onsite",
    ]);
    // Opened one slice, then switched to another without extracting in
    // between. Matching the buffer's head returned every design-onsite record
    // labelled as the eng-remote slice, reported a healthy page stale against
    // the wrong baseline, and charged the eng-remote variant a failure it
    // never earned. The most recent actions are what put the page here.
    clicked("p69", host, [
      "#facet-eng",
      "#facet-remote",
      "#facet-design",
      "#facet-onsite",
    ]);
    assert.strictEqual(
      hydrateOn(host, "p69").variant,
      "click.facet-design+click.facet-onsite",
    );

    // The same rule with one slice contained in the other: after the second
    // click the page is no longer in the one-click slice.
    const nested = "p69b.example";
    seedVariants(nested, ["click.facet-eng", "click.facet-eng+click.facet-remote"]);
    clicked("p69b", nested, ["#facet-eng", "#facet-remote", "#facet-senior"]);
    assert.strictEqual(
      hydrateOn(nested, "p69b").variant,
      "click.facet-eng+click.facet-remote",
    );
  });

  await test("P70 a scroll before an extract is not part of the slice", () => {
    // A scroll loads more of the slice on screen; it never selects one. Keying
    // on it would split one slice in two, and leave the matcher to be lenient
    // about a trailing step instead of matching exactly.
    const preamble = [
      { seq: 0, action: "click", selector: "#facet-eng" },
      { seq: 1, action: "click", selector: "#facet-remote" },
    ];
    const key = "click.facet-eng+click.facet-remote";
    assert.strictEqual(recipes.deriveVariant(preamble), key);
    assert.strictEqual(
      recipes.deriveVariant([
        ...preamble,
        { seq: 2, action: "smart_scroll", selector: null, count: 40 },
        { seq: 3, action: "scroll", selector: null },
      ]),
      key,
      "a scroll minted a second variant for one slice",
    );
    // A step with no selector rendered a bare trailing dot in the key.
    assert.ok(
      !/scroll|\.(\+|$)/.test(recipes.deriveVariant([...preamble, { seq: 2, action: "scroll" }])),
      recipes.deriveVariant([...preamble, { seq: 2, action: "scroll" }]),
    );

    const host = "p70.example";
    seedVariants(host, [key, "click.facet-design+click.facet-onsite"]);
    clicked("p70", host, ["#facet-eng", "#facet-remote"]);
    recipes.noteStep("p70", { action: "smart_scroll", selector: null, path: "/search", host });
    assert.strictEqual(hydrateOn(host, "p70").variant, key);
  });

  await test("P71 an unrelated earlier click does not hide the slice", () => {
    const host = "p71.example";
    seedVariants(host, [
      "click.facet-eng+click.facet-remote",
      "click.facet-design+click.facet-onsite",
    ]);
    // The search box was opened first. A slice that occurs anywhere in what
    // was issued still describes the page; only where it ENDS decides.
    clicked("p71", host, ["#search-toggle", "#facet-eng", "#facet-remote"]);
    assert.strictEqual(
      hydrateOn(host, "p71").variant,
      "click.facet-eng+click.facet-remote",
    );
  });

  await test("P72 half a preamble is not a slice", () => {
    const host = "p72.example";
    seedVariants(host, [
      "click.facet-eng+click.facet-remote",
      "click.facet-design+click.facet-onsite",
    ]);
    clicked("p72", host, ["#facet-eng"]);
    // Neither slice has been reached yet. Returning the one whose first click
    // matches would hand back records from a filter the page is not showing.
    assert.throws(
      () => hydrateOn(host, "p72"),
      /click\.facet-eng\+click\.facet-remote, click\.facet-design\+click\.facet-onsite/,
    );
  });

  await test("P73 a preamble past the cap is cut at a segment boundary", () => {
    const long = (tail) =>
      Array.from({ length: 12 }, (_, i) => ({
        seq: i,
        action: "click",
        selector: `#facet-number-${i}${i === 11 ? tail : ""}`,
      }));
    const a = recipes.deriveVariant(long("a"));
    assert.ok(a.length <= recipes.VARIANT_LABEL_CAP, `${a.length}: ${a}`);
    // This string is what the matcher echoes back for a reader to check its
    // reasoning against. Cutting mid-token left "#facet-onsite" as "face" —
    // broken inside the very step that decided the outcome.
    for (const segment of a.split("+")) {
      assert.ok(
        /^click\.facet-number-\d+[ab]?$/.test(segment) || /^\d+-more-[0-9a-f]{6}$/.test(segment),
        `partial token in ${a}: ${segment}`,
      );
    }
    assert.ok(/^\d+-more-[0-9a-f]{6}\+/.test(a), `it does not say how many were dropped: ${a}`);
    // The steps kept are the ones that decided the match. Keeping the head
    // showed a reader the slice that was not chosen.
    assert.ok(a.endsWith("click.facet-number-11a"), a);
    assert.strictEqual(a, recipes.deriveVariant(long("a")), "not deterministic past the cap");
    assert.notStrictEqual(
      a,
      recipes.deriveVariant(long("b")),
      "two long preambles sharing a prefix collapsed into one variant",
    );
  });

  await test("P74 a healthy replay of the slice on screen costs it no failure", async () => {
    // Two slices with different baselines, and a page showing the second one.
    // Measured against the first's baseline a healthy page reads stale, and
    // three such replays evict a variant that never failed.
    const variant = (selectors, baseline) => ({
      steps: selectors.map((selector, seq) => ({
        seq,
        action: "click",
        selector,
        path: "/search",
      })),
      baseline,
      lastOk: Date.now(),
      failCount: 0,
    });
    const ENG = "click.facet-eng+click.facet-remote";
    const DESIGN = "click.facet-design+click.facet-onsite";
    const seed = {
      "t.json": {
        notes: [],
        selectors: {},
        recipes: {
          "/search": {
            [LIVE_NAME]: {
              extract: { record: LIVE_SPEC.record, fields: LIVE_SPEC.fields },
              variants: {
                [ENG]: variant(["#facet-eng", "#facet-remote"], { name: 1, url: 0.92 }),
                [DESIGN]: variant(["#facet-design", "#facet-onsite"], {
                  name: 1,
                  url: 1 / 12,
                }),
              },
            },
          },
        },
      },
    };
    // The design-onsite listing: one row in twelve carries a link.
    const sparseUrls = () =>
      Array.from({ length: 12 }, (_, i) => ({
        name: `Agent ${i}`,
        url: i === 0 ? "http://t/a/0" : null,
      }));

    await withRecipeServer({ seed, ext: { rows: sparseUrls } }, async ({ srv, store }) => {
      await call(srv, "browser_navigate", { url: "http://t/search" });
      for (const selector of ["#facet-eng", "#facet-remote", "#facet-design", "#facet-onsite"])
        await call(srv, "browser_click", { selector });

      const out = jsonOf(await call(srv, "browser_extract", {}));
      assert.strictEqual(out.used_recipe, `${LIVE_NAME}/${DESIGN}`, JSON.stringify(out).slice(0, 300));
      assert.ok(!out.stale, `a healthy page read stale: ${(out.warnings || []).join(" ")}`);

      const variants = store().recipes["/search"][LIVE_NAME].variants;
      assert.strictEqual(variants[DESIGN].failCount, 0);
      assert.strictEqual(
        variants[ENG].failCount,
        0,
        "a slice that was never replayed was charged a failure",
      );
    });
  });
}

module.exports = groupP;
