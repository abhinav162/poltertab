// Test the semver guard used by the move-beta-tag job in publish.yml.
// Run: node scripts/test-move-beta-tag.js
// Exercises the same module publish.yml calls, so logic drift is caught here.

const { shouldMoveTag } = require('./move-beta-tag-decision');

const cases = [
  { stable: '1.11.0', beta: '1.11.0-beta.3', expected: true,  label: 'normal release: stable outranks its own prerelease' },
  { stable: '1.10.2', beta: '1.11.0-beta.3', expected: false, label: 'hotfix: behind active major beta, skip' },
  { stable: '1.11.0', beta: '1.10.1',        expected: true,  label: 'advancement: stable past old stable beta tag' },
  { stable: '1.11.0', beta: '1.11.0',        expected: false, label: 'no-op: beta already at stable' },
];

let pass = 0, fail = 0;
for (const { stable, beta, expected, label } of cases) {
  const got = shouldMoveTag(stable, beta);
  const ok = got === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${stable} vs ${beta}] expected=${expected} got=${got}  — ${label}`);
  if (ok) pass++; else fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
