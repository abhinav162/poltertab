# Bridge Architecture Design

**Date:** 2026-02-26
**Status:** Approved

## Problem

The browser bridge has two repos with diverged code, a buggy custom WebSocket implementation, and unclear ownership of the bridge server. This causes Chrome handshake failures and a confusing developer experience.

## Decision

- **Bridge server lives in ZeroClaw repo only** (`zeroclaw/bridge-server/server.js`)
- **Extension repo is Chrome extension only** (`poltertab/chrome-extension/`)
- Bridge server uses `ws` npm package (auto-installed) + Node built-in `http` (no Express)
- ZeroClaw auto-spawns the bridge server on first browser tool use
- Dependencies install to `~/.zeroclaw/bridge-deps/` (persistent across restarts)

## Architecture

```
ZeroClaw binary
  → include_str!("bridge-server/server.js")
  → Writes to ~/.zeroclaw/bridge-server/server.js
  → Spawns: node ~/.zeroclaw/bridge-server/server.js
  → server.js auto-installs ws to ~/.zeroclaw/bridge-deps/
  → REST API on :7823, WebSocket on :7822

Chrome Extension (loaded by user)
  → background.js connects to ws://localhost:7822
  → Routes commands to Chrome APIs / content_script.js
```

## Changes

### zeroclaw repo (bridge-server/server.js)
- Rewrite: ws + built-in http, auto-install ws to ~/.zeroclaw/bridge-deps/
- Update browser.rs: write to ~/.zeroclaw/bridge-server/ instead of /tmp/

### poltertab repo
- Remove bridge-server/ directory entirely
- Keep: chrome-extension/, zc-browser.sh, README.md
- Update README to reflect new setup

## Non-Goals
- Standalone bridge server usage outside ZeroClaw
- Zero-dependency custom WebSocket implementation
- Express framework for REST API
