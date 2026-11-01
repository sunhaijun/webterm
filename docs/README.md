# webterm documentation

`docs/` is the source of truth: code implements these documents, not the other way round.

## Start here

1. [Vision](00-overview/vision.md) — what webterm is, and why it isn't another ttyd
2. [Non-goals](00-overview/non-goals.md) — what we deliberately don't do, and the trade-offs we accept
3. [User stories](10-requirements/user-stories.md)
4. [Architecture](20-architecture/overview.md) — components and data flow
5. [WebSocket protocol](30-protocol/websocket-protocol.md) ★ — the client/agent contract

## Layout

| Directory | Contents |
|---|---|
| [00-overview](00-overview/) | Vision, non-goals, glossary |
| [10-requirements](10-requirements/) | User stories, acceptance criteria, device and layout matrix |
| [20-architecture](20-architecture/) | Architecture overview and decision records (ADRs) |
| [30-protocol](30-protocol/) | WebSocket protocol ★, HTTP API |
| [40-frontend](40-frontend/) | Layout, input (extra keys, text page, IME), session UX, shortcuts |
| [50-backend](50-backend/) | Session manager, PTY and terminal emulator, ring buffer, storage |
| [60-security](60-security/) | Threat model, authentication and pairing, privacy |
| [70-testing](70-testing/) | Test strategy, E2E scenarios, manual checklist |
| [80-ops](80-ops/) | Install, troubleshooting, systemd, development |
| [90-roadmap](90-roadmap/) | Milestones and roadmap |

★ The contract between frontend and agent: change the document first.

## Rules

- **Protocol first.** Any change to `/ws` messages starts in `30-protocol/websocket-protocol.md`; then both sides change together.
- **One decision, one ADR.** Architectural choices go in `20-architecture/adr/NNNN-*.md`, including rejected options and why. Accepted ADRs aren't rewritten; a new ADR supersedes an old one.
- **Testable requirements.** Every acceptance criterion maps to a concrete test in `70-testing/`. A requirement you can't test isn't ready.
- **Keep them in sync.** A requirement change updates the acceptance criteria, which update the E2E scenarios.

Each document states its status: `Draft` (under discussion, don't build on it), `Accepted`, or `Superseded by …`.
