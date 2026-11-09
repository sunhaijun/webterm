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
| Files sent to sessions | Whatever the user sent; a screenshot can show secrets too (hence `0600` in a private directory, deleted after 24 hours) |
| Every file the user can reach | Read, written and deleted by the file browser with the user's rights ([ADR-0059](../20-architecture/adr/0059-files.md)): no more than shell access, which a paired device already has |

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
- Other local users on the same machine → hence the db is `0600`, the control and attach sockets are `0600` (the attach socket also checks the peer's uid), the only thing in `/tmp` is the private upload directory ([T9](#t9-other-local-users-and-the-shared-temp-directory)), and a port bound to localhost rather than `0.0.0.0` is not assumed to be protected
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
| SSH attach adds no network surface | `webterm attach` ([ADR-0050](../20-architecture/adr/0050-ssh-attach.md)) reaches the agent through `run/attach.sock`, a Unix socket that only the agent's uid can open and that checks the peer's uid again (`SO_PEERCRED`). Getting to it already takes a login as that user, through sshd's own authentication. No port, no credential |
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
| WebSocket `Origin` check | Must exactly equal the agent's own origin or the origin the device was paired from; a mismatch returns 403 (AC-1.8, [ADR-0062](../20-architecture/adr/0062-several-machines.md) §4) |
| Every mutation uses a non-GET method | REST writes use only `POST`/`PATCH`/`DELETE` |
| `Origin` check on every authenticated request | Any authenticated request that carries `Origin` — writes, and since ADR-0062 reads too — is refused with 403 unless it comes from the agent's own origin or the device's `origin`, in case a browser or proxy gets `SameSite` wrong, and because CORS (below) answers every origin on the site |
| CORS only within the site | `Access-Control-Allow-Origin` echoes only an origin on the agent's site (same scheme and registrable domain), with credentials; a preflight from anywhere else gets 403. CORS lets another machine's page read answers; the binding above decides whether it may act |
| Pairing refuses other sites | `POST /auth/pair` from an `Origin` off the agent's site gets `403 cross_site` before the code is checked |

**Why the WebSocket checks `Origin` separately**: the WebSocket handshake **is not protected by CORS**. Modern browsers don't send `SameSite=Strict` cookies on a cross-site WS handshake either, but this behavior has varied historically. The Origin check is a necessary second line of defense.

### T5 XSS

**Scenario**: content in the terminal output gets rendered as HTML.

| Mitigation | Implementation |
|---|---|
| Rendering by xterm.js (default DOM renderer) | Writes `textContent` cell by cell; terminal output is **never parsed as HTML** |
| No automatic HTML in `linkHandler` | Hyperlinks (OSC 8) and URLs found in text allow only `http`/`https`; anything else isn't a link. They open in a new tab with `noopener`, on Ctrl/Cmd+click or the popover's Open ([ADR-0053](../20-architecture/adr/0053-links-and-clipboard.md)) |
| OSC 52 is write-only | A program can write the clipboard, never read it (`?` is ignored, not answered); only live output of the current session counts, never replayed bytes or background sessions. A program can still put something misleading on the clipboard; the "Copied" toast or the Copy bar makes every write visible ([ADR-0053](../20-architecture/adr/0053-links-and-clipboard.md) §4) |
| Metadata such as session name / CWD | Set through `textContent`, never `innerHTML` |
| Files sent to a session ([ADR-0051](../20-architecture/adr/0051-send-files-to-a-session.md)) | Write-only: no route lists or serves the upload directory by its own name; they are ordinary files to the file browser below |
| Files served by the file browser ([ADR-0059](../20-architecture/adr/0059-files.md) §7) | `GET /api/fs/raw` answers with `Content-Security-Policy: … sandbox` (an opaque origin: no cookie, no scripts, even if the browser renders it), `Content-Disposition: attachment` for everything but non-SVG images, video and audio, `nosniff`, and a `Content-Type` from webterm's own table. The page shows text with `textContent` and SVG only through `<img>`; it renders no Markdown or HTML. A cloned repository's `.html` or `.svg` therefore never runs as a page on webterm's origin. `Cache-Control: no-store` keeps viewed files out of the browser's disk cache |
| Markdown previews ([ADR-0060](../20-architecture/adr/0060-files-maximize-and-markdown.md) §2) | The one place the page inserts HTML. markdown-it runs with raw HTML off, so tags in the file come out as text; links only to `http(s)`, `mailto`, anchors and relative paths; images only from the agent. Clicks are handled by one listener, never inline handlers, and the CSP (`script-src 'self'`) would stop any script or handler that slipped through |
| File names typed into a session ([ADR-0059](../20-architecture/adr/0059-files.md) §4) | Send to session backslash-escapes the path and never pastes one with a control character, so a name crafted to end the bracketed paste (`ESC[201~`) and press Enter can't run a command |
| CSP | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://<domain> <site sources>; img-src 'self' data: <site sources>; media-src 'self' <site sources>; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. `<site sources>` are the other machines' ([ADR-0062](../20-architecture/adr/0062-several-machines.md) §6): `https://*.<site>:* https://<site>:*`, plus the `wss://` forms in `connect-src`; empty in IP mode. Scripts still come only from `'self'` |

Session names, CWDs and file names are the server data that reaches the DOM (tab bar, session drawer, file browser). Always use `textContent`, and check this specifically in review.

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
| Uploads filling memory | The body streams to a file; the agent never holds more than a copy buffer per request |
| Uploads filling the temp directory | 20 MiB per file (`413`); 256 MiB in total, oldest deleted first; every file deleted after 24 hours. A full `/tmp` would also break other programs (on a tmpfs it is shared memory), so the cap is mandatory ([ADR-0051](../20-architecture/adr/0051-send-files-to-a-session.md) §5) |
| File browser uploads filling a disk | No cap: they go where the user puts them, which a paired device's shell can fill just as well. Bodies stream to disk; a failed write deletes the part file ([ADR-0059](../20-architecture/adr/0059-files.md) §6) |
| Huge folders | A listing returns at most 5,000 entries; reads stream with `http.ServeContent`, never buffered |

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
| Uploaded file names aren't logged; sizes only at debug level. The file browser logs no paths or names either ([ADR-0059](../20-architecture/adr/0059-files.md) §6) |

### T9 Other local users and the shared temp directory

**Scenario**: another account on the server plants a symlink or a directory at `/tmp/webterm-<uid>` before the agent creates it, to redirect uploads or read them.

| Mitigation | Implementation |
|---|---|
| Owned, private directory | `webterm-<uid>` is created `0700`; before every upload the agent checks with `lstat` that it is a directory (not a symlink), owned by its uid, and closed to group and others. If not, uploads fail with `500` and a log line; the agent never uses or repairs it |
| No following links | Files are created with `O_CREAT \| O_EXCL \| O_NOFOLLOW`, mode `0600`, under names the agent generates |

The same check tmux makes for `/tmp/tmux-<uid>`. Files in the directory are as private as the user's home directory; another local user who is root can read them anyway.

### T10 Several machines in one page

[ADR-0062](../20-architecture/adr/0062-several-machines.md): a page served by one machine also drives the other machines on its site that the device was paired with from it.

| Threat | Mitigation / accepted |
|---|---|
| A compromised machine serves a page that drives the others | **Accepted**, inherent in one page for several machines: the page's code acts with the cookies of every machine it added. It adds no network path; each machine's device list shows which devices are bound to which page (`origin`) and can revoke them |
| Another page on the same domain (a blog, a sibling subdomain) uses the cookies | `SameSite` treats it as same-site, so the cookie is sent. It still can't act or read: every authenticated request with `Origin` must come from the agent's own origin or the device's bound one (T4). Accepted: it can embed `/api/fs/raw` in an `<img>` (no `Origin`), without reading the pixels. Keep untrusted content off the domain the machines live on |
| Signing out of one machine clears the others' cookies | `Clear-Site-Data: "cookies"` is never sent: it applies to the whole registrable domain (ADR-0062 §12) |
| A device left signed in on a machine that couldn't be reached at sign-out | The signed-out page names the machine; only that machine can revoke the token (`webterm devices revoke`) |

## Out of scope

| Measure | Why not |
|---|---|
| Sandboxing the shell / restricting which commands can run | Self-deception. The user already has shell access on this machine; webterm shouldn't pretend it can restrict that |
| Fencing the file browser into a directory | The same: a paired device's shell reaches every file the fence would hide ([ADR-0059](../20-architecture/adr/0059-files.md) §6) |
| Per-command auditing and alerts | A single-user tool; there's nobody to audit |
| Re-authentication before dangerous commands | Pure annoyance. The real protection is keeping unauthorized people out |
| Multi-factor authentication (v0.1) | A pairing code + a long-lived cookie is enough for a single user. Passkeys come in v0.2 (a UX improvement that also happens to improve security) |
| End-to-end encryption beyond TLS | There's no extra trust boundary that would need it |

## Security review checklist (every PR)

If a change touches any of the following, the PR description must state its security impact:

- [ ] A new route reachable without authentication
- [ ] Changes to cookie attributes, the auth middleware, the Origin check or the CORS headers
- [ ] New data written to disk (especially anything that could contain terminal output)
- [ ] New fields written to logs
- [ ] Changes to how sessions are started (shell arguments, injected environment variables)
- [ ] New code that puts server data into the DOM
- [ ] Changes to the CSP or TLS configuration, or to the headers `GET /api/fs/raw` sends (ADR-0059 §7)
- [ ] A new unbounded buffer / queue / collection
