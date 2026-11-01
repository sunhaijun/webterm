# Contributing

Thanks for helping. Bug reports, fixes and ideas are all welcome.

## Reporting a bug

Open an issue with:

- `webterm version` and the output of `webterm doctor`
- What you did, what you expected, what happened
- Server OS; client device, OS and browser
- `journalctl -u webterm -n 200 --no-pager` (logs never contain input, output, cookies or pairing codes)
- For input problems: `__webterm.inputStats()` from the browser console, taken while it's stuck

Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Proposing a change

For anything beyond a small fix, open an issue first. webterm is opinionated: check [non-goals](docs/00-overview/non-goals.md) and the [ADRs](docs/20-architecture/overview.md) — your idea may have been considered already, and the record says why.

## How we work

The full rules are in [CLAUDE.md](CLAUDE.md). In short:

- **Docs first.** `docs/` is the source of truth. Change the relevant document (and acceptance criteria) before the code. Protocol changes start in [websocket-protocol.md](docs/30-protocol/websocket-protocol.md); architectural decisions get a new ADR.
- **Branch per topic**, named `feat/<docs-number>-<topic>`. Pull requests target `main`.
- **Invariants:** a single static binary (no cgo), the frontend embedded in it, terminal output never written to disk, authentication on every route except pairing and static assets.

## Development setup

[docs/80-ops/development.md](docs/80-ops/development.md) covers building, the test suites, E2E setup and frontend hot reload.

```bash
make build                     # frontend + ./webterm
make check                     # Go and frontend tests, gofmt, doc links
make e2e                       # Playwright against the real binary
./webterm serve --dev          # http://127.0.0.1:8080
```

## Pull requests

- `make check` and `make e2e` pass locally (CI runs everything except E2E).
- New behavior has tests; reconnect, session-state and connection-layer changes have extra required tests listed in [CLAUDE.md](CLAUDE.md).
- Docs updated in the same PR.
- Commit messages: imperative summary line, then the why.
- Write everything in English: code, comments, UI text, docs.

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
