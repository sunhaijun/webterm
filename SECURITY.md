# Security

webterm puts a shell on the internet, so we take reports seriously.

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on this repository. Please don't open a public issue.

Include the version (`webterm version`), what an attacker can do, and steps to reproduce. You'll get an acknowledgment within a week; fixes for confirmed issues ship as a new release, and we credit reporters unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes. `webterm update` upgrades in place without closing sessions.

## Scope

In scope, for example:

- Reaching a shell, the WebSocket or any authenticated route without a paired device
- Pairing-code or session-cookie weaknesses (guessing, leakage, replay)
- Cross-origin attacks on the WebSocket or HTTP API
- Terminal input or output written to disk or logs
- The installer weakening the host (permissions, capabilities, services)

Out of scope:

- Anything that requires an already-paired device: a paired device is the user, with a full shell by design
- Running webterm as root against the documentation's advice
- Denial of service by flooding the public ports

The design is documented in the [threat model](docs/60-security/threat-model.md) and [authentication](docs/60-security/) docs.
