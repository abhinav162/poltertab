# PolterTab CLI Installer — Design Spec

## Overview

Ship a single npm package `poltertab` that serves as both the MCP server runtime and an interactive setup wizard. Users run `npm install -g poltertab && poltertab setup` to get a fully configured Claude Code + PolterTab environment.

## Target Audience

- AI tool users already running Claude Code who want browser control.
- Developers comfortable with npm and terminal workflows.

## Package Structure

```
poltertab/                  (npm package root)
├── package.json            (name: "poltertab", bin field)
├── bin/
│   ├── poltertab.js        (entry: routes to server or setup)
│   └── setup.js            (interactive wizard)
├── server/
│   └── index.js            (existing MCP server, required by bin)
├── skills/
│   └── browser-navigation-strategy.md
└── assets/
    └── claude-md-snippet.md
```

The `bin` field in package.json:
```json
{
  "bin": {
    "poltertab": "./bin/poltertab.js"
  }
}
```

## CLI Interface

### `poltertab` (no args)

Starts the MCP server over stdio. This is what goes in the Claude Code MCP config. Equivalent to the current `node mcp-server/index.js`.

### `poltertab setup`

Interactive wizard. No external dependencies — uses Node.js `readline` with ANSI colors.

## Wizard Flow

```
$ poltertab setup

  PolterTab — Browser Control for AI Agents

? Where should PolterTab be available?
  ❯ All projects (global)
    This project only

✓ Skill installed → ~/.claude/skills/poltertab/browser-navigation-strategy.md
✓ CLAUDE.md updated → ~/.claude/CLAUDE.md
✓ MCP server registered → Claude Code settings

📦 Install the Chrome extension:
   → https://github.com/abhinav162/poltertab/releases/latest

🔄 Restart Claude Code to activate.
```

### Step-by-step:

1. **Idempotency check** — if skill file exists and MCP config entry exists, report "already configured" and exit (with `--force` flag to override).

2. **Scope selection** — global or project:
   - Global: `~/.claude/skills/poltertab/`, `~/.claude/CLAUDE.md`, `~/.claude/settings.json`
   - Project: `.claude/skills/poltertab/`, `./CLAUDE.md`, `.claude/settings.json` (project-level)

3. **Copy skill file** — write `browser-navigation-strategy.md` to the chosen skills directory.

4. **Update CLAUDE.md** — append the snippet from `assets/claude-md-snippet.md`. Skip if the marker `<!-- poltertab -->` already exists in the file.

5. **Register MCP server** — shell out to the official CLI:
   ```
   claude mcp add --scope <user|project> poltertab poltertab
   ```
   **Deviation from the original draft**, which planned to hand-edit
   `~/.claude/settings.json`. That path was wrong twice over: user-scope MCP
   servers actually live in `~/.claude.json`, and that file holds ~170KB of
   unrelated Claude Code state. Rewriting it ourselves risks clobbering the
   user's history and project settings on a bad parse or a concurrent write.
   `claude mcp add` owns that file, handles both scopes, and writes `.mcp.json`
   for project scope. If the CLI is absent from PATH, the wizard prints the
   command instead of failing the whole install.

6. **Print extension link** — GitHub releases URL. Later: Chrome Web Store URL (toggled by a constant in setup.js).

7. **Print restart reminder.**

## Skill File Content

Adapted from the existing Pi agent skill. Key changes:
- Tool names use `browser_` prefix (already correct)
- Adds shadow DOM awareness (use `browser_snapshot` which now pierces shadow roots)
- Adds iframe guidance (PolterTab searches across frames automatically)
- Removes ZeroClaw references
- Adds guidance on `browser_session_create` for multi-tab workflows

## CLAUDE.md Snippet

```markdown
<!-- poltertab -->
## Browser Control (PolterTab)

You have browser automation available via PolterTab MCP tools (prefixed `browser_`).
Use the `/browser-navigation-strategy` skill when navigating complex SPAs.
Key tools: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_scrape`.
PolterTab drives the user's real Chrome profile — no headless browser needed.
```

## MCP Server Entry Point

`bin/poltertab.js` routes on first arg:

```javascript
#!/usr/bin/env node
if (process.argv[2] === 'setup') {
  require('./setup.js');
} else {
  require('../server/index.js');
}
```

## Dependencies

**Runtime (server):** `@modelcontextprotocol/sdk`, `ws` (already present).

**Wizard:** zero new dependencies. `readline` and `fs` from stdlib.

## Repo Layout Change

The publishable package lives at repo root. `chrome-extension/` is NOT part of
the npm package (users get it from GitHub Releases).

**Deviation from the original draft**, which moved `mcp-server/` to `server/`.
The rename was dropped: anyone who already set PolterTab up by hand has
`"args": ["/path/to/poltertab/mcp-server/index.js"]` in their config, and moving
the file breaks them silently on their next pull. Keeping the directory also
leaves the README, the existing test paths, and the file's git history untouched.
The rename bought nothing but churn.

What did change: `mcp-server/package.json` and its lockfile are gone, and the
root `package.json` owns the dependencies. Two package manifests declaring the
same two deps is a drift bug waiting to happen, and Node resolves
`mcp-server/index.js`'s imports from the root `node_modules` either way.

```json
{
  "files": [
    "bin/", "mcp-server/", "skills/", "assets/",
    "!mcp-server/test/", "!mcp-server/test-client.js",
    "!mcp-server/downloads/", "!mcp-server/navigation_memory/"
  ]
}
```

Verified: `npm pack` produces a 16KB tarball containing only `bin/`,
`mcp-server/index.js`, `skills/`, `assets/`, `package.json`, and `README.md`.

## Extension Distribution

- **v1:** GitHub Releases — zip of `chrome-extension/` directory, loaded as unpacked.
- **v2:** Chrome Web Store listing (pending developer account + review).

The wizard prints the appropriate link. A `EXTENSION_URL` constant in `setup.js` makes the switch trivial.

## Error Handling

- Wizard fails gracefully if it can't find/write config files (prints manual instructions instead).
- `--force` flag re-runs setup even if markers exist.
- If `~/.claude/` doesn't exist, wizard creates it.
- If CLAUDE.md doesn't exist, wizard creates it with just the snippet.

## Testing

- Unit test: wizard writes correct files to a temp directory (mock HOME).
- Unit test: idempotency — running twice doesn't duplicate content.
- Unit test: `poltertab` with no args requires server/index.js without error.
- Integration: `npm pack` → install from tarball → `poltertab setup` in temp env → verify files.

## Out of Scope (v1)

- Uninstall command (`poltertab uninstall`) — add when needed.
- Multi-tool support (Cursor, Windsurf) — v2, one more question in the wizard.
- Auto-update mechanism for the skill file.
- Extension auto-install (not possible without CWS).
