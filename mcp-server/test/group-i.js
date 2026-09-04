const {
  AGENT_FIELDS,
  agentCard,
  assert,
  path,
  recEl,
  recordSandbox,
  test,
} = require("./harness.js");

async function groupI() {
  console.log("\nI. record-scoped extraction");

  await test("I1 a record missing an optional field does NOT shift later records", async () => {
    const s = recordSandbox([
      agentCard({ name: "Ann", path: "/agent/ann", phone: "111" }),
      agentCard({ name: "Dani", path: "/agent/dani" }), // no phone — the shifter
      agentCard({ name: "Cal", path: "/agent/cal", phone: "333" }),
    ]);
    const res = await s.send("extract", {
      record: ".agent-card",
      fields: AGENT_FIELDS,
    });
    assert.strictEqual(res.success, true, res.error);
    const rows = res.data.rows;
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[0].phone, "111");
    assert.strictEqual(rows[1].phone, null, "missing field must be null");
    assert.strictEqual(
      rows[2].phone,
      "333",
      "phone shifted up — every later record is now mis-assigned",
    );
    assert.strictEqual(rows[1].name, "Dani", "name/phone came from different records");
  });

  await test("I2 a too-narrow record root is reported, not silently empty", async () => {
    const s = recordSandbox([
      agentCard({ name: "Ann", path: "/agent/ann", socials: ["http://fb/ann"] }),
      agentCard({ name: "Cal", path: "/agent/cal", socials: ["http://fb/cal"] }),
    ]);
    // .agent-card-info is the container that LOOKS like the card. Socials are
    // its sibling, so this scope cannot see them.
    const res = await s.send("extract", {
      record: ".agent-card-info",
      fields: {
        name: { sel: "a.agent-card-name", get: "text" },
        socials: { sel: "a.agent-card-social-button", get: "href", many: true },
      },
    });
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(res.data.fill_rates.socials, 0);
    const warn = res.data.warnings.join(" ");
    assert.ok(
      /socials: 0\/2 within record scope, but 2 matches page-wide/.test(warn),
      `no loosening probe — an empty column reads as "these agents have no socials": ${warn}`,
    );
    assert.ok(/too narrow/.test(warn), warn);
  });

  await test("I3 a wrong selector is distinguished from a wrong boundary", async () => {
    const s = recordSandbox([agentCard({ name: "Ann", path: "/agent/ann" })]);
    const res = await s.send("extract", {
      record: ".agent-card",
      fields: {
        name: { sel: "a.agent-card-name", get: "text" },
        license: { sel: "span.nope", get: "text" },
      },
    });
    const warn = res.data.warnings.join(" ");
    assert.ok(/no matches for "span.nope" anywhere/.test(warn), warn);
    assert.ok(!/too narrow/.test(warn), `misdiagnosed as a boundary problem: ${warn}`);
  });

  await test("I4 anchor drops placeholder records and counts them", async () => {
    const s = recordSandbox([
      agentCard({ name: "Ann", path: "/agent/ann" }),
      agentCard({ name: "", path: null }), // phantom card, page 10 of kw.com
      agentCard({ name: "", path: null }),
      agentCard({ name: "Cal", path: "/agent/cal" }),
    ]);
    const res = await s.send("extract", {
      record: ".agent-card",
      fields: AGENT_FIELDS,
      anchor: "url",
    });
    assert.strictEqual(res.data.count, 2);
    assert.strictEqual(res.data.dropped, 2, "phantoms emitted as null rows");
    assert.strictEqual(res.data.records_found, 4);
    assert.deepStrictEqual(
      res.data.rows.map((r) => r.name),
      ["Ann", "Cal"],
    );
  });

  await test("I5 fill_rates count real values, not row slots", async () => {
    const s = recordSandbox([
      agentCard({ name: "Ann", path: "/agent/ann", phone: "111", email: "a@x" }),
      agentCard({ name: "Cal", path: "/agent/cal", email: "c@x" }),
    ]);
    const res = await s.send("extract", {
      record: ".agent-card",
      fields: AGENT_FIELDS,
    });
    assert.deepStrictEqual(res.data.fill_rates, {
      name: 2,
      url: 2,
      phone: 1,
      email: 2,
    });
  });

  await test("I6 get:'text' works where attribute:'textContent' returned nulls", async () => {
    const s = recordSandbox([agentCard({ name: "Ann", path: "/agent/ann" })]);
    const ex = await s.send("extract", {
      record: ".agent-card",
      fields: { name: { sel: "a.agent-card-name", get: "text" } },
    });
    assert.strictEqual(ex.data.rows[0].name, "Ann");

    // Same trap via scrape's attribute param, which is where it was found.
    const sc = await s.send("scrape", {
      selector: "a.agent-card-name",
      attribute: "textContent",
      multiple: true,
    });
    assert.deepStrictEqual(sc.data, ["Ann"], "attribute:textContent still nulls");
  });

  await test("I7 href comes back absolute and strip removes the scheme", async () => {
    const s = recordSandbox([
      agentCard({ name: "Ann", path: "/agent/ann", phone: "555-1234" }),
    ]);
    const res = await s.send("extract", {
      record: ".agent-card",
      fields: AGENT_FIELDS,
    });
    assert.strictEqual(res.data.rows[0].url, "http://t/agent/ann");
    assert.strictEqual(res.data.rows[0].phone, "555-1234");
  });

  await test("I8 many:true keeps each record's list to itself", async () => {
    const s = recordSandbox([
      agentCard({
        name: "Ann",
        path: "/agent/ann",
        socials: ["http://fb/ann", "http://li/ann"],
      }),
      agentCard({ name: "Cal", path: "/agent/cal", socials: ["http://fb/cal"] }),
    ]);
    const res = await s.send("extract", {
      record: ".agent-card",
      fields: {
        name: { sel: "a.agent-card-name", get: "text" },
        socials: { sel: "a.agent-card-social-button", get: "href", many: true },
      },
    });
    assert.deepStrictEqual(res.data.rows[0].socials, [
      "http://fb/ann",
      "http://li/ann",
    ]);
    assert.deepStrictEqual(res.data.rows[1].socials, ["http://fb/cal"]);
  });

  await test("I9 a field with no sel reads the record root itself", async () => {
    const s = recordSandbox([agentCard({ name: "Ann", path: "/agent/ann" })]);
    const res = await s.send("extract", {
      record: "a.agent-card-name",
      fields: { name: { get: "text" }, url: { get: "href" } },
    });
    assert.strictEqual(res.data.rows[0].name, "Ann");
    assert.strictEqual(res.data.rows[0].url, "http://t/agent/ann");
  });

  await test("I10 truncation is reported instead of silently cutting", async () => {
    const s = recordSandbox([
      recEl("div", {
        cls: "card",
        children: [recEl("p", { cls: "bio", text: "x".repeat(400) })],
      }),
    ]);
    const res = await s.send("extract", {
      record: ".card",
      fields: { bio: { sel: "p.bio", get: "text" } },
      max_text: 50,
    });
    assert.strictEqual(res.data.rows[0].bio.length, 50);
    assert.ok(
      /truncated at max_text=50: bio/.test(res.data.warnings.join(" ")),
      res.data.warnings.join(" "),
    );
  });

  await test("I11 a record selector matching nothing says so", async () => {
    const s = recordSandbox([agentCard({ name: "Ann", path: "/agent/ann" })]);
    const res = await s.send("extract", {
      record: ".listing-row",
      fields: { name: { sel: "a", get: "text" } },
    });
    assert.strictEqual(res.data.count, 0);
    assert.strictEqual(res.data.records_found, 0);
    assert.ok(/no matches for ".listing-row"/.test(res.data.warnings.join(" ")));
  });

  await test("I12 scrape fields:['meta','jsonld'] skips the 50KB body", async () => {
    const s = recordSandbox([
      recEl("meta", { attrs: { property: "og:title", content: "Ann | NJ" } }),
      recEl("script", {
        attrs: { type: "application/ld+json" },
        text: '{"@type":"RealEstateAgent","name":"Ann"}',
      }),
      recEl("script", {
        attrs: { type: "application/ld+json" },
        text: "{ not json",
      }),
      recEl("a", { attrs: { href: "/x" }, text: "x" }),
    ]);
    const res = await s.send("scrape", { fields: ["meta", "jsonld"] });
    assert.strictEqual(res.data.meta["og:title"], "Ann | NJ");
    assert.strictEqual(res.data.jsonld.length, 1, "malformed blob broke the scrape");
    assert.strictEqual(res.data.jsonld[0].name, "Ann");
    assert.ok(res.data.title, "title should always come along");
    assert.strictEqual(res.data.bodyText, undefined, "body text was not asked for");
    assert.strictEqual(res.data.links, undefined);
  });

  await test("I13 get_text flags a cut instead of hiding it", async () => {
    const s = recordSandbox([recEl("p", { id: "long", text: "y".repeat(300) })]);
    const cut = await s.send("get_text", { selector: "#long", max_text: 100 });
    assert.strictEqual(cut.data.truncated, true);
    assert.strictEqual(cut.data.full_length, 300);
    const whole = await s.send("get_text", { selector: "#long" });
    assert.strictEqual(whole.data.truncated, undefined);
  });
}

module.exports = groupI;
