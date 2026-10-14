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
