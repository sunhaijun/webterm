# Non-goals and accepted trade-offs

> Status: Accepted

This page records **what we cut, why, and what it costs**. Before proposing "let's add X", check whether X was already rejected here.

---

## 1. Things we don't do

### No SSH client

There is no SSH in the path. You install the agent on the target machine, the browser talks to the agent directly, and the agent forks the PTY.

- **No SSH in the browser or a Worker**: SSH transport encryption and authentication in JS/WASM is too much code and too much attack surface.
- **No SSH relay hub**: it would have to manage credentials for the target machines, and it adds a hop of latency.

Cost: **every machine you want to reach needs the binary.** Accepted.
Later: the agent could gain outbound SSH to hop to machines without an agent ([ADR-0001](../20-architecture/adr/0001-agent-first-no-ssh.md)). Not in v0.1.

### No tmux

The agent owns the PTYs and manages sessions itself.

- Passing tmux's window/pane model through to the web would mean inheriting its interaction model too.
- The agent handles resume itself: the ring buffer serves the incremental path, and the agent-side terminal emulator produces snapshots ([ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)) — the same screen state tmux keeps, without its window/pane model.

**Cost (important, explicitly accepted): restarting the agent process ends every session.**

The agent holds the PTY master fds; when it dies the shells get `SIGHUP`. Restarting the agent or rebooting the server loses all sessions.

Why we accept it: **network drops (several times a day) and process restarts (rare) are problems of different frequency.** The real pain is the former, and it is fully solved.

Upgrades are the exception: a hot upgrade re-execs in place and hands the PTY fds, ring buffers and emulator state to the new process, so sessions survive ([ADR-0016](../20-architecture/adr/0016-hot-reexec.md)). A real process restart still loses sessions; see [ADR-0003](../20-architecture/adr/0003-no-tmux.md).

### No Cloudflare (or any external platform)

An early design used Cloudflare Pages + Tunnel + Access. Rejected:

- It brought three external dependencies (tunnel process, Access configuration, DNS hosting) and a cross-origin auth trap: Access relies on a cookie, so a cross-site WebSocket handshake gets a 302 to the login page and fails silently.
- It made automated testing of the full path impossible.

**This doesn't burn bridges**: the agent is a plain HTTP + WebSocket service, so putting it behind Cloudflare Tunnel, Tailscale, nginx or frp is external orchestration with zero code changes. See [ADR-0002](../20-architecture/adr/0002-self-contained-binary.md).

### No multi-user

One user, many devices. No accounts, no permission model, no session ownership.

Cost: you can't give a colleague an account. Accepted — this is a personal tool, and multi-user multiplies the complexity of authentication, authorization and auditing.
Later: maybe v0.3+, which would need a data migration.

### No self-signed certificates

TLS has one production path: automatic ACME issuance. It needs a public IP with a domain pointing at it (or, since [ADR-0044](../20-architecture/adr/0044-ip-address-certificates.md), just the public IPv4 address), and port 80 or 443 reachable from the internet — HTTP-01 uses 80, TLS-ALPN-01 uses 443.

- Self-signed certificates require installing a profile on iOS, which is a poor experience and becomes a permanent source of troubleshooting noise.
- Local development doesn't need them: `http://localhost:PORT` is already a secure context, so PWA, Service Worker and the Clipboard API all work.

So TLS has exactly two code paths: `--dev` (plain HTTP on localhost) and production (ACME). See [ADR-0004](../20-architecture/adr/0004-acme-only-tls.md).

### Terminal output never touches disk

The ring buffer and the agent-side terminal emulator live only in memory. Only device and auth data are persisted; there is no command history.

Output can contain keys, tokens and sensitive log data. A session recording feature, if ever built, must be an explicit opt-in with clear disclosure. See [`../60-security/privacy-history.md`](../60-security/privacy-history.md).

---

## 2. Deferred to v0.2 (scheduled, not rejected)

| Feature | Why not in v0.1 |
|---|---|
| File browsing and upload/download | A separate feature surface; doesn't affect validating the core path |
| Split panes on desktop | High layout complexity, and the benefit is mostly on desktop — which already has a local terminal |
| Passkey / WebAuthn login | Pairing codes + long-lived cookies are enough for v0.1; passkeys are a UX improvement |

---

## 3. Properties we don't pursue

- **Full terminal feature coverage.** Sixel images, terminal audio, exotic mouse protocols and the like only with a concrete need.
- **Old browsers.** The target is current Chrome / Safari / Firefox, so `visualViewport`, `ResizeObserver` and CSS `env()` are fair game.
- **Horizontal scaling of the agent.** One agent serves one person's one machine. No cluster, no load balancer.
- **Zero-latency input.** No mosh-style local echo prediction (v0.1). On a slow link, type long input on the text page and send it in one go to avoid per-key round trips.
