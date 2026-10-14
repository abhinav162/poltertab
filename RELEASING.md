# Releasing PolterTab

All releases go through **release-please** and require a beta before the final.
No local `npm version`, no hand-moved tags.

## The flow

```
feat: / fix: commits land on main
        ↓
release-please opens (or updates) a release PR proposing 1.x.0-beta.1
        ↓
CI uploads tarball + extension zip as GitHub Actions artifacts
        ↓
Dwight downloads and lab-checks the artifacts (see below)  →  SHIP: merge the PR
        ↓
Tag v1.x.0-beta.1 created → GitHub (pre-)release → npm @beta published
        ↓
More fixes: beta.2, beta.3 …
        ↓
Human says "this beta is good"  →  promote to final (file-based, below)
        ↓
release-please updates the PR to 1.x.0 (final)
        ↓
Merge → v1.x.0 tagged → GitHub release (not pre-release) → npm @latest published → @beta moved to @latest
        ↓
Dwight runs registry smoke test
```

## Downloading lab-check artifacts

On a release-please PR, CI uploads the tarball and extension zip.  Download them:

```bash
# List recent runs on the PR branch to find the run ID:
gh run list --branch release-please--node--main --repo abhinav162/poltertab

# Download artifacts from a specific run:
gh run download <run-id> --name release-artifacts-<sha> --repo abhinav162/poltertab
```

## PR title rules

Every PR **title** must follow Conventional Commits — GitHub squash-merges to main
with the PR title as the commit, and release-please builds the CHANGELOG from those.

| Prefix | CHANGELOG | Version bump |
|--------|-----------|--------------|
| `feat:` | visible → Features | Yes — next beta.N on the current series |
| `fix:` | visible → Bug Fixes | Yes — next beta.N on the current series |
| `feat!:` or `fix!:` | visible | Yes — next major beta.N |
| `perf:` | visible → Performance Improvements | No |
| `revert:` | visible → Reverts | No |
| `docs:` | visible → Documentation | No |
| `chore:` | visible → Miscellaneous Chores | No |
| `refactor:`, `test:`, `build:`, `ci:` | hidden from CHANGELOG | No |

With `prerelease: true` in the config, `feat:` and `fix:` both increment the
beta counter rather than bumping minor or patch directly.  The semantic type
only matters for the eventual final: a series with `feat:` will ship as a minor
bump (e.g. `1.9.0`); a series with only `fix:` will ship as a patch (`1.8.2`).

## Beta → final promotion

When a beta is approved, open a PR that edits `release-please-config.json` to
pin the exact final version in the package entry:

```json
"packages": {
  ".": {
    "release-as": "1.9.0"
  }
}
```

Commit with a title like `chore: promote 1.9.0 to final`.  Merge to main.
release-please reads the config on the next push and opens (or updates) the
release PR showing `1.9.0` (no `-beta` suffix).

**Verify:** after merging the promotion commit, check the open release PR title.
It must read `chore(main): release 1.9.0` (no `-beta`).  If it still shows a
beta version, the config edit did not reach main — check CI for errors.

After the final ships, open a follow-up PR that removes `release-as` from the
package entry (restoring `"packages": { ".": {} }`) and commits as
`chore: remove release-as after 1.9.0 final`.  Without this cleanup every
subsequent release PR will propose 1.9.0 again.

> **Alternative — commit footer:** A commit body containing `Release-As: 1.9.0`
> also works, but **only** when the repo's squash-commit template is set to
> "PR title **and description**" (not "PR title only", which drops the body and
> silently leaves the release PR on the beta version).  Prefer the file-based
> approach above; use the footer only after confirming the squash-message setting.

## GitHub release pre-release flag

release-please sets the GitHub release's Pre-release flag automatically: tags
containing `-` (betas) are marked Pre-release; tags without `-` (finals) are
marked as regular releases.  No manual checkbox is needed.

The guard in `scripts/release-meta.js` that rejects a stable version marked
Pre-release on GitHub is intentional — it cannot fire on the automated
`workflow_call` path (where the `prerelease` input always matches the tag string),
but it catches mistakes on the manual `release: published` path.  Do not remove
it as dead code.

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

## Creating the RELEASE_PLEASE_TOKEN secret

The release-please workflow needs a fine-grained PAT so that release PRs it
opens trigger CI under the main branch ruleset (GITHUB_TOKEN-opened PRs do not).

1. Go to **GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
2. Set **Resource owner** to this repo's owner.
3. Set **Repository access** to _Only select repositories_ → `poltertab`.
4. Under **Repository permissions**, grant:
   - **Contents**: Read and write
   - **Pull requests**: Read and write
5. Name it `poltertab-release-please` and set an expiry (1 year is reasonable).
6. Copy the token value.
7. Go to **repo → Settings → Secrets and variables → Actions → New repository
   secret**.  Name: `RELEASE_PLEASE_TOKEN`, value: the copied token.

If the secret is absent the workflow falls back to `GITHUB_TOKEN` with a comment
in the run log, but CI will not run on the release PR.

## Branch-protection / ruleset settings (human applies)

The ruleset already in place: PRs only, squash only, required checks listed
below, up-to-date not required.  Add or confirm these required status checks:

| Check name (exact) | Source |
|--------------------|--------|
| `test (node 18)` | `ci.yml` |
| `test (node 22)` | `ci.yml` |
| `version consistency` | `ci.yml` |
| `pr title` | `pr-title-check.yml` |

> Add `pr title` to the ruleset **after the first PR runs the check** so GitHub
> has seen the check name.  The job id is `pr-title`; the display name (what
> appears in the ruleset picker) is `pr title`.
