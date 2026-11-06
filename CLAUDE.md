# webterm conventions

These apply to every change, by people and coding agents alike. [CONTRIBUTING.md](CONTRIBUTING.md) has the human-friendly version.

## Docs first

`docs/` is the source of truth; code implements it. Always:

```
change docs → write tests from the docs → implement → tests pass → PR
```

- Protocol changes start in `docs/30-protocol/websocket-protocol.md`. Frontend and agent follow it; neither side changes first.
- A new architectural decision gets its own `docs/20-architecture/adr/NNNN-*.md`. Check every open branch for the next free number.
- Requirement changes go in `docs/10-requirements/` and update `docs/70-testing/e2e-scenarios.md`.
- If you can't write an acceptance criterion for it, it isn't ready to build.

## Branches

One branch (and worktree) per milestone, named after the docs section it lands in:

```
feat/<docs-number>-<topic>      e.g. feat/30-protocol-core
```

`git worktree add` → work → tests pass → PR to `main` → delete the worktree after merging. Never work on `main` directly. Milestones: `docs/90-roadmap/milestones.md`.

## Tests every PR must pass

- Go: `go test ./...`; new logic has unit tests.
- Frontend: `npm test`.
- E2E: `npm run e2e` locally. Changes to the protocol, reconnects, input or layout add or update scenarios in `docs/70-testing/e2e-scenarios.md`. E2E doesn't run automatically in CI, so the local run is the gate; if it can't run, fix the environment first (`docs/80-ops/development.md`, "E2E setup"). For a CI run: `gh workflow run E2E --ref <branch>`.
- Resume changes must pass both: **byte-level continuity** on the incremental path (the terminal buffer after cutting the WebSocket mid-output serializes byte-for-byte like an uninterrupted run) and **screen-level consistency** on the snapshot path (xterm fed the snapshot and then the following bytes equals xterm fed everything, cell by cell; [ADR-0026](docs/20-architecture/adr/0026-agent-holds-terminal-state.md) §10).
- Session state changes (`internal/session` fields, ringbuf, `internal/vterm`) must pass `TestHandoffByteLevelContinuity`; check whether new fields belong in the `internal/handoff.Session` snapshot.
- Connection-layer changes must keep both the read and write queues non-blocking: one WebSocket carries every session, so blocking either side stalls them all.

## Invariants

1. **One binary.** No cgo, no runtime dependencies. `GOOS=linux GOARCH=amd64 go build` produces the release binary.
2. **Same origin.** The agent serves the frontend via `go:embed`; there is no separate frontend host.
3. **Output stays in memory.** Terminal output lives only in the ring buffer and emulator. Only devices and authentication data go to disk.
4. **Contiguous sequence numbers.** The byte-stream sequence number sent to clients equals the session's cumulative PTY output. The agent never rewrites output; `SNAPSHOT` frames are agent-generated rendering instructions and don't count toward `seq` ([protocol §3](docs/30-protocol/websocket-protocol.md)).
5. **Authenticate first.** Every route except `/pair`, static assets and the health check — including the WebSocket upgrade — requires a valid device session. The local Unix sockets (`run/agent.sock`, `run/attach.sock`) are authenticated by file permissions and the peer's uid instead ([ADR-0050](docs/20-architecture/adr/0050-ssh-attach.md)).

## Stack

- Go 1.27+: `creack/pty` · `coder/websocket` · `modernc.org/sqlite` (pure Go) · `golang.org/x/crypto/acme` · `tuios.dev/vt` (pure-Go terminal emulator, pinned, used only through `internal/vterm`)
- Frontend: TypeScript, Vite, Preact, xterm.js
- Tests: `go test`, Vitest, Playwright
- Language: English everywhere — docs, comments, UI and CLI text, commit messages.
