// Test the beta-N counter used by the Compute beta version step in beta-from-pr.yml.
// Run: node scripts/test-next-beta-n.js
// Exercises the same module the workflow calls, so logic drift is caught here.

const { nextBetaN } = require('./next-beta-n');

const cases = [
  { base: '1.11.0', all: [],                                             expected: 1,  label: 'first beta, no prior publishes' },
  { base: '1.11.0', all: ['1.11.0-beta.1', '1.11.0-beta.2'],            expected: 3,  label: 'sequential: next after 2' },
  { base: '1.11.0', all: ['1.11.0-beta.1', '1.11.0-beta.10'],           expected: 11, label: 'non-sequential: uses max' },
  { base: '1.11.0', all: ['1.10.0-beta.5', '1.11.0-beta.2'],            expected: 3,  label: 'ignores earlier base versions' },
  { base: '1.11.0', all: ['1.11.0-beta.1', '1.11.0-rc.1', '1.11.0'],   expected: 2,  label: 'ignores non-beta tags for same base' },
];

let pass = 0, fail = 0;
for (const { base, all, expected, label } of cases) {
  const got = nextBetaN(base, all);
  const ok = got === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${base}] expected=${expected} got=${got}  — ${label}`);
  if (ok) pass++; else fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
