# Releasing PolterTab

Two lanes: **normal** (feature work on `main`) and **hotfix** (patch-only,
skips beta). Both use release-please; no local `npm version`, no hand-moved tags.

---

## Normal lane

```
feat: / fix: commits land on main
        ↓
release-please opens (or updates) the release PR  →  version N.M.0 (or N.M.P)
        ↓
beta-from-pr.yml fires on every push to the release PR:
  - publishes poltertab@N.M.0-beta.<next> to npm (@beta)
  - creates a GitHub prerelease v<ver>-beta.<next> with the extension zip
  - posts a PR comment: version, shasum, head sha
        ↓
Andy tests the beta.  God says SHIP.
        ↓
Human merges the release PR
        ↓
publish.yml fires (release: published):
  - publishes poltertab@N.M.0 to npm (@latest)
  - attaches extension zip to the release
  - moves @beta to @latest (only if N.M.0 is semver-greater than current @beta)
```

### PR title rules

Every PR title must follow Conventional Commits (GitHub squash-merges using
the PR title).  release-please builds the CHANGELOG from those.

| Prefix | CHANGELOG | Version bump |
|--------|-----------|--------------|
| `feat:` | visible → Features | minor bump |
| `fix:` | visible → Bug Fixes | patch bump |
| `feat!:` / `fix!:` | visible | major bump |
| `perf:` | visible → Performance Improvements | patch bump |
| `revert:` | visible → Reverts | — |
| `docs:` | visible → Documentation | — |
| `chore:` | visible → Miscellaneous Chores | — |
| `refactor:`, `test:`, `build:`, `ci:` | hidden | — |

### Beta workflow guards

`beta-from-pr.yml` enforces three guards:

1. **Fork refusal** — `github.event.pull_request.head.repo.full_name ==
   github.repository` on the job `if`, so the job is skipped entirely for fork
   PRs and secrets are never exposed.
2. **Branch-name check** — `startsWith(github.head_ref,
   'release-please--branches--main')` on the same `if`, so pushes to
   unrelated PRs are skipped, not failed.
3. **Concurrency** — `group: beta-pr-<PR number>` with `cancel-in-progress:
   true`, so two pushes to the same PR can't publish the same beta.N.

---

## Hotfix lane

Use this when a fix must ship before the next planned release (e.g. a security
patch against the current `v1.10.x` while `v1.11.0` work is in progress).

```
Branch hotfix/1.10.2 from the last stable tag (e.g. v1.10.1)
        ↓
Open fix PR targeting hotfix/1.10.2 → merge
        ↓
release-please opens release PR targeting hotfix/1.10.2  →  version 1.10.2
        ↓
Human merges the hotfix release PR (no beta step required)
        ↓
publish.yml fires → poltertab@1.10.2 published to @latest
  move-beta-tag skips if 1.10.2 is NOT semver-greater than current @beta
  (e.g. 1.11.0-beta.3 stays put)
        ↓
Open merge-back PR: hotfix/1.10.2 → main
Merge it so main's pending release PR re-computes above 1.10.2.
Delete the hotfix branch.
```

### Commands

```bash
# 1. Create hotfix branch from the last stable tag
git fetch origin --tags
git checkout -b hotfix/1.10.2 v1.10.1
git push -u origin hotfix/1.10.2

# 2. Apply the fix (normal PR targeting hotfix/1.10.2)
# ... open PR, merge ...

# 3. release-please will open a release PR for hotfix/1.10.2 automatically.
# Merge it. publish.yml ships 1.10.2.

# 4. Merge back to main
git fetch origin
git checkout -b merge-hotfix-1.10.2-to-main origin/main
git merge --no-ff origin/hotfix/1.10.2
# Resolve any conflicts (expect manifest/CHANGELOG divergence)
git push -u origin merge-hotfix-1.10.2-to-main
# Open PR: merge-hotfix-1.10.2-to-main → main
```

---

## publish.yml: move-beta-tag guard

After every stable release the `move-beta-tag` job compares the new stable
version against what `@beta` currently resolves to using **full semver ordering**
(prerelease versions sort below their release):

```
new stable: 1.11.0  |  current @beta: 1.11.0-beta.3  →  MOVE  (1.11.0 > 1.11.0-beta.3)
new stable: 1.10.2  |  current @beta: 1.11.0-beta.3  →  SKIP  (1.10.2 < 1.11.0)
new stable: 1.11.0  |  current @beta: 1.10.1         →  MOVE  (advancement)
new stable: 1.11.0  |  current @beta: 1.11.0         →  SKIP  (no-op, already at stable)
```

Test the logic locally: `node scripts/test-move-beta-tag.js`

---

## Dry-run

```bash
gh workflow run publish.yml -f tag=v1.10.2 -f dry_run=true
```

Runs the full pipeline (npm ci, npm test, npm pack, extension zip) and
attaches nothing.  Check the Actions run summary for the channel and install
command that *would* have been used.

---

## Rollback

npm does not allow unpublish after 72 hours.  For a bad publish:

1. `npm deprecate poltertab@<bad> "do not use this version"`
2. Publish a patch or new beta immediately.
3. If `latest` was poisoned: `npm dist-tag add poltertab@<good> latest`
4. File a GitHub issue.

---

## Creating the RELEASE_PLEASE_TOKEN secret

release-please needs a fine-grained PAT so release PRs it opens trigger CI
under the main branch ruleset (GITHUB_TOKEN-opened PRs do not).

1. **GitHub → Settings → Developer settings → Fine-grained tokens → Generate**
2. Resource owner: this repo's owner
3. Repository access: Only select repositories → `poltertab`
4. Permissions: **Contents** read/write, **Pull requests** read/write
5. Name: `poltertab-release-please` (1-year expiry recommended)
6. **repo → Settings → Secrets → Actions → New repository secret**
   Name: `RELEASE_PLEASE_TOKEN`, value: the token

Without the secret the workflow falls back to `GITHUB_TOKEN` but CI will not
run on the release PR.

---

## Branch-protection / ruleset settings (human applies)

Required status checks for `main` (squash-only, PRs only, up-to-date not
required):

| Check name (exact) | Source |
|--------------------|--------|
| `test (node 18)` | `ci.yml` |
| `test (node 22)` | `ci.yml` |
| `version consistency` | `ci.yml` |
| `pr title` | `pr-title-check.yml` |

Add `pr title` after the first PR runs the check (so GitHub has seen the name).

---

## Excluding paths from release-please

`"exclude-paths": ["site"]` in `release-please-config.json` prevents commits
that only touch the landing page from opening or advancing a release PR.
Do not remove it.

---

## GitHub release pre-release flag

release-please sets the Pre-release flag automatically: tags with `-` (betas)
are marked Pre-release; tags without `-` (finals) are not.  No manual checkbox
needed.  The guard in `scripts/release-meta.js` that rejects a stable version
marked Pre-release on GitHub is intentional — do not remove it.
