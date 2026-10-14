# Releasing PolterTab

All releases go through **release-please** and require a beta before the final.
No local `npm version`, no hand-moved tags.

## The flow

```
feat: / fix: / docs: commits land on main
        ↓
release-please opens (or updates) a release PR proposing 1.x.0-beta.1
        ↓
CI attaches the tarball + extension zip to the PR for lab check
        ↓
Dwight lab-checks the tarball   →   SHIP: merge the PR
        ↓
Tag v1.x.0-beta.1 created → GitHub (pre-)release → npm @beta published
        ↓
More fixes: beta.2, beta.3 …
        ↓
Human says "this beta is good"  →  promote to final (one commit, below)
        ↓
release-please updates the PR to 1.x.0 (final)
        ↓
Merge → v1.x.0 tagged → npm @latest published → @beta moved to @latest
        ↓
Dwight runs registry smoke test
```

## PR title rules

Every PR **title** must follow Conventional Commits — GitHub squash-merges to main
with the PR title as the commit, and release-please builds the CHANGELOG from those.

| Prefix | Effect |
|--------|--------|
| `feat:` | Minor bump (or beta.N if already pre-major) |
| `fix:` | Patch bump |
| `feat!:` or `fix!:` | Major bump |
| `docs:`, `chore:`, `ci:`, `refactor:`, `test:` | No version bump; hidden in CHANGELOG |
| `perf:`, `revert:` | Patch bump; shown in CHANGELOG |

## Beta → final promotion

When a beta is approved, add **one** commit to any branch going to main with
this footer (no other changes needed):

```
chore: promote 1.9.0-beta.x to final

Release-As: 1.9.0
```

release-please detects the `Release-As` footer and switches the open release PR
from `1.9.0-beta.x` to `1.9.0`. Review and merge as normal.

## Dry-run command

To verify what publish.yml would do against an existing tag without pushing to npm:

```bash
gh workflow run publish.yml \
  -f tag=v1.9.0-beta.1 \
  -f dry_run=true
```

This runs the full pipeline (npm ci, npm test, npm pack, extension zip) and
attaches nothing. Check the Actions run summary for the channel and install
command that *would* have been used.

## Rollback

npm does not allow unpublish after 72 hours. For a bad publish:

1. `npm deprecate poltertab@<bad-version> "do not use this version"`
2. Publish a patch or new beta immediately: `npm publish --tag beta` (or `latest`).
3. If `latest` was poisoned, move it: `npm dist-tag add poltertab@<good-version> latest`.
4. File a GitHub issue describing what shipped and what callers should do.

## Branch-protection settings (human applies)

Apply these to `main` in **Settings → Branches → Add branch protection rule**:

| Setting | Value |
|---------|-------|
| Require a pull request before merging | ✅ |
| Required approvals | 1 |
| Require status checks to pass before merging | ✅ |
| Required status checks | `test (node 18)`, `test (node 22)`, `version consistency`, `Conventional Commit title` |
| Require branches to be up to date before merging | ☐ (not required yet) |
| Do not allow bypassing the above settings | ✅ |
| Allow force pushes | ☐ |
| Allow deletions | ☐ |

> **Note:** `Conventional Commit title` comes from the `pr-title-check.yml`
> workflow job named `Conventional Commit title`.  Add it after the first PR
> runs the check so GitHub has seen the check name.
