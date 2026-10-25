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

No PolterTab servers, no telemetry. The MCP server talks to your AI client over
stdio; the Chrome extension connects to it over `localhost`, and that WebSocket
listens only on this machine (`127.0.0.1` and `::1`). The server refuses
connections from web pages — browser connections must come from a Chrome
extension (`chrome-extension://`) origin — and only the Chrome Web Store build
(trusted automatically) or an extension you have paired can hold that connection,
change upload settings, or read the logs. Page content is returned only to
your own MCP client. By default the running server makes one outbound request, a daily npm
version check (`registry.npmjs.org`); `poltertab setup` additionally does a
one-time Chrome Web Store version lookup (`clients2.google.com`). Turn both off
with `POLTERTAB_NO_UPDATE_CHECK=1`.

See [What leaves your machine](README.md#what-leaves-your-machine) in the README
for the full picture, including how file uploads are gated.
