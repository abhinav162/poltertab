// Compute the next beta.N for a given base version.
// Exported function: require()d by scripts/test-next-beta-n.js.
// CLI wrapper: called by beta-from-pr.yml; reads BASE + ALL_VERSIONS from env,
// prints the next N (plain integer, no newline) to stdout.

function nextBetaN(base, allVersions) {
  const prefix = base + '-beta.';
  const ns = allVersions
    .filter(v => v.startsWith(prefix))
    .map(v => parseInt(v.slice(prefix.length), 10))
    .filter(n => Number.isFinite(n));
  return ns.length ? Math.max(...ns) + 1 : 1;
}

module.exports = { nextBetaN };

if (require.main === module) {
  const base = process.env.BASE;
  const raw  = process.env.ALL_VERSIONS;
  if (!base || !raw) {
    process.stderr.write(
      'Usage: BASE=x.y.z ALL_VERSIONS=\'[...]\' node scripts/next-beta-n.js\n'
    );
    process.exit(1);
  }
  process.stdout.write(String(nextBetaN(base, JSON.parse(raw))));
}
