#!/usr/bin/env node
// PolterTab regression suite. Covers both halves of the project:
//   A  source invariants that are cheap to assert and easy to regress
//   B  content_script.js injection idempotence   (the N-clicks-per-command bug)
//   C  background.js navigation load race        (the 30s hang on fast pages)
//   D  mcp-server end-to-end over stdio          (output_file, stdout purity)
//   E  shadow DOM piercing + late-element retry  (the OCI-console class of bug)
//   I  record-scoped extraction                  (the field-shift / silent-empty bugs)
//   J  the pagination loop                       (halt conditions, CSV output)
//   K  benchmark-run regressions                 (site-memory lookup, output paths)
//   L  bridge handshake origin check             (the drive-by extension takeover)
//   M  actionability gate                        (hidden/disabled/covered targets)
//   N  self-healing selectors                    (fingerprint relocation on drift)
//
// Run: node mcp-server/test/run.js
// No framework on purpose — plain asserts, one file, real processes.

const path = require("path");
const { results } = require("./harness.js");

// One file per group, run in order. Adding a group is adding a file.
const GROUPS = "abcdefghijklmn".split("");

(async () => {
  console.log("PolterTab regression suite");
  for (const letter of GROUPS) {
    await require(path.join(__dirname, `group-${letter}.js`))();
  }

  const { pass, failures } = results();
  const total = pass + failures.length;
  console.log(`\n${total ? `${pass}/${total}` : "0/0"} passed`);
  if (failures.length) {
    console.log(`failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  process.exit(0);
})();
