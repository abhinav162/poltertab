// Test the semver guard used by the move-beta-tag job in publish.yml.
// Run: node scripts/test-move-beta-tag.js

const semverParts = (v) => v.split('-')[0].split('.').map(Number);
const cmp = (a, b) => {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

function shouldMove(stable, currentBeta) {
  const s = semverParts(stable);
  const b = semverParts(currentBeta);
  const baseCmp = cmp(s, b);
  return baseCmp > 0 || (baseCmp === 0 && currentBeta.includes('-'));
}

const cases = [
  { stable: '1.11.0', beta: '1.11.0-beta.3', expected: true,  label: 'normal release: stable outranks its own prerelease' },
  { stable: '1.10.2', beta: '1.11.0-beta.3', expected: false, label: 'hotfix: behind active major beta, skip' },
  { stable: '1.11.0', beta: '1.10.1',        expected: true,  label: 'advancement: stable past old stable beta tag' },
  { stable: '1.11.0', beta: '1.11.0',        expected: false, label: 'no-op: beta already at stable' },
];

let pass = 0, fail = 0;
for (const { stable, beta, expected, label } of cases) {
  const got = shouldMove(stable, beta);
  const ok = got === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${stable} vs ${beta}] expected=${expected} got=${got}  — ${label}`);
  if (ok) pass++; else fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
