# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for
anything exploitable.

- **Preferred:** open a private report through GitHub Security Advisories —
  **[Report a vulnerability](https://github.com/abhinav162/poltertab/security/advisories/new)**
  (the repository's **Security** tab → **Report a vulnerability**). Only the
  maintainers can see it.
- If that is unavailable, open a minimal public issue asking a maintainer to
  open a private channel — **without** exploit details.

Please include the version (`poltertab --version`), your OS and Node version,
and the minimal steps to reproduce. We aim to acknowledge a report within a few
days and will keep you posted on a fix and disclosure timeline.

## Supported versions

PolterTab follows semantic versioning and ships one active line at a time.
Security fixes land in the latest release on npm, installed with
`npm install -g poltertab`.

| Version                   | Supported           |
| ------------------------- | ------------------- |
| latest (`@latest` on npm) | ✅                  |
| older releases            | ❌ — upgrade to the latest |

## What leaves your machine

PolterTab runs locally — there is no PolterTab server, account, or telemetry.
The MCP server talks to your AI client over stdio and to the Chrome extension
over a WebSocket bound to `localhost`; page content is returned only to your own
MCP client. The one thing that leaves your machine by default is an optional
version check to `registry.npmjs.org` and the Chrome Web Store update service
(`clients2.google.com`), which you can turn off with `POLTERTAB_NO_UPDATE_CHECK=1`.

See [What leaves your machine](README.md#what-leaves-your-machine) in the README
for the full picture, including how file uploads are gated.
