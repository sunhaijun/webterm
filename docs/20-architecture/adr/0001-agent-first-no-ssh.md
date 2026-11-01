# ADR-0001 Agent-first, no SSH in the path

Status: Accepted (2026-09-06).

## Context

The original request was "SSH into a remote server from the browser". SSH is an existing tool, not the requirement. The requirement is a shell on the remote machine, in a browser.

## Decision

Run the webterm agent on the target machine. The agent forks the PTY itself; there is no SSH hop.

```
browser ──WSS──> agent ──PTY──> bash
```

Rejected alternatives:

- **An SSH client in the browser or in a Cloudflare Worker** (Workers can open TCP via `cloudflare:sockets`). This means implementing the SSH transport, encryption and auth in JS/WASM: too much code and attack surface. Workers also have CPU-time limits and per-duration billing, a poor fit for long-lived streams of small packets. And it goes against a minimal stack.
- **One hub running the agent, SSH from there to other machines.** Target machines stay untouched, but the hub must store and protect credentials for every target (where, how encrypted, what a leak costs). It adds a hop of latency and a single point of failure, and the hub's CWD and environment differ from the target's, so shell integration would have to carry OSC sequences across SSH.

## Consequences

Positive:

- Lowest latency: one hop from browser to PTY.
- No SSH keys or passwords stored anywhere. Credential management disappears.
- Dotfiles, environment variables and CWD are the target machine's real state.
- The whole system can start inside CI for end-to-end tests.

Negative:

- **Every machine you want to reach needs the binary.** This is the main cost, and it is accepted: copying one static binary and running it is cheap.
- No central inventory or discovery of machines. Single-user, single-machine v0.1 doesn't need it.

Future: to reach machines without an agent, add outbound SSH inside the agent (`golang.org/x/crypto/ssh`) and use it as a jump host:

```
browser ──WSS──> agent ──SSH──> machine without an agent
```

On the Go side this only requires turning `session.PTY` into an interface with a local-PTY and an SSH-channel implementation. It layers cleanly on top of this ADR without overturning it. Not in v0.1.
