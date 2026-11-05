# Threat model

> Status: Accepted

## What we protect

webterm exposes a server's shell to the internet. **Compromising webterm = every permission that user has on that machine** (plus everything sudo can reach).

This is the project's biggest risk, so the security design comes before the features, not after.

## Assets

| Asset | Impact if compromised |
|---|---|
| Shell access | Total compromise: read/write files, start processes, move laterally |
| Session cookie | Equivalent to shell access |
| Pairing code (unused, unexpired) | Equivalent to shell access |
| Terminal output | May contain keys, tokens, sensitive log data (**hence kept only in memory**: ring buffer and terminal emulator) |
| TLS private key | Man-in-the-middle |

## Trust boundaries

```
        Untrusted                       │           Trusted
                                        │
  Any request from the internet         │  Browsers on paired devices
  Unauthenticated WebSocket handshakes  │  The agent process
  Requests with a mismatched Origin     │  The user account running the agent
                                        │
  ──────── authentication first ────────┤
                                        │
  Other users on the same machine       │
  (partly untrusted)                    │
```

**Explicitly outside the trust boundary**:
- Other local users on the same machine → hence the db is `0600`, the control socket is `0600`, nothing goes in `/tmp`, and a port bound to localhost rather than `0.0.0.0` is not assumed to be protected
- Browser extensions → can't be defended against; out of scope

**Explicitly inside the trust boundary**:
- The user account running the agent. The agent doesn't try to sandbox its own shell — that would be self-deception (the user already has a shell on this machine)

## Threats and mitigations

### T1 Unauthorized access (highest risk)

**Attack surface**: port 443 is open to the whole internet.

| Mitigation | Implementation |
|---|---|
| Authentication before everything | Everything except `/pair`, static assets and `/healthz` requires a valid cookie, **including the WebSocket upgrade** (AC-1.7) |
| No default credentials | Pairing codes are generated randomly every time. **There is no default password anywhere in the code** |
| High-entropy pairing codes | The URL code is 32 bytes of `crypto/rand`, base64url; brute force is infeasible. The hand-typed digit code is 16 decimal digits (≈53 bits) and relies on rate limiting: at most 50 guesses from anywhere during its 5-minute life (a circuit breaker trips at 50 failures per hour), for a hit probability of 5 × 10⁻¹⁵ ([ADR-0017](../20-architecture/adr/0017-numeric-pairing-code.md)) |
| Short-lived, single-use codes | 5-minute TTL, void once used (AC-1.4) |
| Rate limiting and backoff | 5 per minute per IP, then exponential backoff returning 429 (AC-1.6) |
| Constant-time comparison | `subtle.ConstantTimeCompare`, against timing side channels |
| Minimal attack surface | The only routes reachable without authentication: static assets, `POST /auth/pair`, `GET /healthz`. No other dynamic entry point |
| Optional local-only binding | `--bind 127.0.0.1` lets the user reach it only through an SSH tunnel |

**Residual risk**: port 443 itself is exposed. That's the price of dropping Cloudflare Tunnel ([ADR-0002](../20-architecture/adr/0002-self-contained-binary.md)). Accepted; mitigated by the measures above, and users can put their own tunnel in front.

### T2 Pairing code leak

**Scenario**: the pairing code ends up in logs, browser history, the Referer header or chat history.

| Mitigation | Implementation |
|---|---|
| Passed in the URL **fragment** | `https://x/pair#<code>`. The fragment isn't sent to the server, so it **never reaches access logs or Referer** (AC-1.5). The frontend JS reads it and submits it with `POST` |
| Fragment cleared right after submission | `history.replaceState` erases it so it doesn't stay in browser history |
| Single use + 5-minute TTL | Even if it leaks, the window is tiny |
| Never logged | Pairing codes are redacted in logs (AC-8.5) |
| Delivered by QR code | Scanning bypasses the clipboard and chat apps |

### T3 Session cookie theft

| Mitigation | Implementation |
|---|---|
| `HttpOnly` | Not readable from JS, so XSS can't steal it (AC-1.9) |
| `Secure` | HTTPS only (except under `--dev`) |
| `SameSite=Strict` | CSRF protection; cross-site requests don't carry the cookie |
| Only the hash is stored | A leaked DB yields no usable cookie (AC-1.10) |
| Revocable | Revoke one device or all of them from the device list (AC-1.3) |
| Revocation is immediate | Established WebSockets are cut within 5 seconds (AC-1.11) |

**Immediate revocation**: every 2 seconds the agent checks whether the device behind each active connection has been revoked; if so, it sends `notice` + `error{unauthorized}` and closes the connection. Checking only at the handshake isn't enough — a long-lived connection can stay open for days.

### T4 CSRF / cross-site attacks

| Mitigation | Implementation |
|---|---|
| `SameSite=Strict` cookie | Cross-site requests carry no credentials |
| WebSocket `Origin` check | Must exactly equal the configured domain; a mismatch returns 403 (AC-1.8) |
| Every mutation uses a non-GET method | REST writes use only `POST`/`PATCH`/`DELETE` |

**Why the WebSocket checks `Origin` separately**: the WebSocket handshake **is not protected by CORS**. Modern browsers don't send `SameSite=Strict` cookies on a cross-site WS handshake either, but this behavior has varied historically. The Origin check is a necessary second line of defense.

### T5 XSS

**Scenario**: content in the terminal output gets rendered as HTML.

| Mitigation | Implementation |
|---|---|
| Rendering by xterm.js (default DOM renderer) | Writes `textContent` cell by cell; terminal output is **never parsed as HTML** |
| No automatic HTML in `linkHandler` | Hyperlinks (OSC 8) allow only `http`/`https`; anything else isn't clickable |
| Metadata such as session name / CWD | Set through `textContent`, never `innerHTML` |
| CSP | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://<domain>; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` |

Session name and CWD are the only server data that reaches the DOM (tab bar, session drawer). Always use `textContent`, and check this specifically in review.

### T6 Denial of service

| Threat | Mitigation |
|---|---|
| Many unauthenticated connections | Pre-auth work is minimal (look up the cookie hash); pairing is rate-limited |
| Sessions exhausting memory | Session limit 20; per session a 256 KiB ring buffer + a 2000-line terminal emulator (< 1 MiB) → about 25 MiB at most |
| Connections exhausting memory | At most 16 concurrent connections (`--max-conns`), 4 MiB write queue each → 64 MiB at most. **This limit is mandatory** — the protocol lets one device open any number of tabs |
| A slow client stalling sessions | The connection write queue is bounded (4 MiB); when it's full, **that connection is dropped** instead of blocking the PTY ([protocol §5.6](../30-protocol/websocket-protocol.md#56-bounded-queues-both-directions)) |
| A stuck shell stalling the whole connection | The session input queue is bounded (256 KiB); when it's full, reply `input_stalled` and **drop that connection**, never blocking the connection's read loop (same section) |
| Memory amplification through huge frames | Frames are capped at 256 KiB; anything larger disconnects |
| Output flood | The agent-side emulator runs at about 20 MB/s per core and backpressures PTY reads, so nothing piles up without bound; history is fixed at 2000 lines |
| Input queue growth | The client-side `pending` is capped at 256 KiB, the agent's per-session input queue |

**Note**: without Cloudflare there's no DDoS protection ([ADR-0002](../20-architecture/adr/0002-self-contained-binary.md)). Mitigation is limited to the application layer. Network-layer volumetric attacks are out of scope for this project — a user facing them should put a tunnel or CDN in front (the architecture supports that).

### T7 TLS

| Threat | Mitigation |
|---|---|
| autocert abused to issue certificates for arbitrary domains | `HostPolicy` is restricted to the value of `--domain`, **never a wildcard** ([ADR-0004](../20-architecture/adr/0004-acme-only-tls.md)). In IP mode a handshake never triggers issuance ([ADR-0044](../20-architecture/adr/0044-ip-address-certificates.md)) |
| Private key leak | `certs/` directory is `0700` |
| Downgrade to HTTP | HSTS `max-age=31536000`; `:80` answers everything except ACME challenges with a 301 |
| Weak TLS | `MinVersion: tls.VersionTLS12`, TLS 1.3 preferred |

### T8 Log leaks

| Mitigation |
|---|
| Never log pairing codes, cookie tokens or user input (AC-8.5) |
| Never log terminal output, under any circumstances |
| IP and User-Agent are logged on purpose (for the device list and rate limiting) |
| `IT-privacy-2` verifies this with a canary string |

## Out of scope

| Measure | Why not |
|---|---|
| Sandboxing the shell / restricting which commands can run | Self-deception. The user already has shell access on this machine; webterm shouldn't pretend it can restrict that |
| Per-command auditing and alerts | A single-user tool; there's nobody to audit |
| Re-authentication before dangerous commands | Pure annoyance. The real protection is keeping unauthorized people out |
| Multi-factor authentication (v0.1) | A pairing code + a long-lived cookie is enough for a single user. Passkeys come in v0.2 (a UX improvement that also happens to improve security) |
| End-to-end encryption beyond TLS | There's no extra trust boundary that would need it |

## Security review checklist (every PR)

If a change touches any of the following, the PR description must state its security impact:

- [ ] A new route reachable without authentication
- [ ] Changes to cookie attributes, the auth middleware or the Origin check
- [ ] New data written to disk (especially anything that could contain terminal output)
- [ ] New fields written to logs
- [ ] Changes to how sessions are started (shell arguments, injected environment variables)
- [ ] New code that puts server data into the DOM
- [ ] Changes to the CSP or TLS configuration
- [ ] A new unbounded buffer / queue / collection
