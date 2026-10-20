// Semver guard for the move-beta-tag job in publish.yml.
// Exported function: require()d by scripts/test-move-beta-tag.js.
// CLI wrapper: called by publish.yml; reads VERSION + CURRENT_BETA from env,
// prints 'move' or 'skip' to stdout (no newline).

function semverParts(v) {
  return v.split('-')[0].split('.').map(Number);
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Returns true when the new stable version should take the @beta dist-tag.
// Full semver ordering: 1.11.0 > 1.11.0-beta.3 (stable outranks its prerelease).
function shouldMoveTag(stable, currentBeta) {
  const s = semverParts(stable);
  const b = semverParts(currentBeta);
  const baseCmp = cmp(s, b);
  return baseCmp > 0 || (baseCmp === 0 && currentBeta.includes('-'));
}

module.exports = { shouldMoveTag };

if (require.main === module) {
  const stable = process.env.VERSION;
  const currentBeta = process.env.CURRENT_BETA;
  if (!stable || !currentBeta) {
    process.stderr.write(
      'Usage: VERSION=x.y.z CURRENT_BETA=a.b.c[-beta.n] node scripts/move-beta-tag-decision.js\n'
    );
    process.exit(1);
  }
  process.stdout.write(shouldMoveTag(stable, currentBeta) ? 'move' : 'skip');
}
