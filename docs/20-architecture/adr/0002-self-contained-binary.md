# ADR-0002 Self-contained single binary, no external platform

Status: Accepted (2026-09-06).

## Context

The first design used Cloudflare end to end: Pages for the frontend, Tunnel to reach the machine, Access for authentication. It looked like free auth with no inbound ports.

## Decision

**One Go binary is the whole service.** It embeds the frontend with `go:embed`, terminates TLS, authenticates and manages sessions. No Cloudflare, reverse proxy, external database or extra processes.

```
./webterm serve --domain term.example.com
```

Why not Cloudflare:

1. **Cross-origin auth breaks in hard-to-debug ways.** With Pages on `app.example.com` and the agent behind Tunnel on `term.example.com`, the WebSocket is cross-origin. Access authenticates via the `CF_Authorization` cookie; in a cross-site WebSocket handshake that turns into a 302 to the login page and the connection **fails silently**. Using one hostname is not an option: DNS can't point the same name at both Pages and Tunnel.
2. **It makes full end-to-end testing impossible.** Automated tests are a stated requirement, and the core feature is reconnect and resume. Testing it means controlling exactly when the WebSocket drops. With Tunnel or Access in the path, E2E tests can only cover half the link. This was decisive: **testability is an architectural property, not an add-on.**
3. **What the three services provide is easy to replace:**

| Cloudflare provides | Our replacement |
|---|---|
| Access authentication | Pairing code + long-lived device cookie, enough for a single user (see [auth-pairing.md](../../60-security/auth-pairing.md)) |
| Tunnel, no inbound ports | Port 443 must be open. A real cost, see below |
| Pages CDN for the frontend | The frontend is a few hundred KB; serving it from the agent is unnoticeable |
| WAF / DDoS protection | Lost. A real cost, see below |

## Consequences

Positive:

- **Same origin**: no CORS, no cross-site cookies, no redirected WebSocket handshakes.
- No intermediary idle timeouts or per-duration billing. Lowest latency.
- Deploying is `scp` and run. No dashboard, no DNS migration.
- **The full path starts inside CI**, so E2E tests, including killing the WebSocket to verify resume, are real.

Negative (accepted):

- **Port 443 is exposed to the internet.** Mitigations are in the [threat model](../../60-security/threat-model.md): authentication before every route, rate limiting and backoff on pairing codes, and `--bind 127.0.0.1` behind an SSH tunnel or the user's own tunnel.
- **No WAF or DDoS protection.** Mitigation: a tiny surface (static assets, a few REST endpoints, one WebSocket), no unauthenticated dynamic entry points, and very cheap handling before auth.

The decision doesn't burn bridges. The agent is an ordinary HTTP + WebSocket service, so putting it behind Cloudflare Tunnel, Tailscale, nginx or frp later is external wiring with no code changes:

```
./webterm serve --bind 127.0.0.1:8080 --no-tls   # then let the tunnel/proxy take over
```

To keep that true, `--bind` and `--no-tls` (non-public listeners only) must stay, and behind a reverse proxy the agent must handle `X-Forwarded-For` (for rate limiting) and `Origin` checks correctly.
