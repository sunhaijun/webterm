# Authentication and pairing

> Status: Accepted
>
> Single user, multiple devices. No accounts, no passwords. Threat analysis: [`threat-model.md`](threat-model.md).

## Goals

1. **No default credentials.** There is no default password anywhere in the code.
2. **No typing on the phone.** Scan a QR code and you're done.
3. **Pair once, stay signed in.** Each device pairs exactly once.
4. **Revoke at any time.** Lost your phone? Kick it out from another device with one tap.

## Pairing flow

```
Server                                          Client
──────────────────────────────────────────────────────────────
webterm serve
  │
  ├─ no authorized devices? → generate a pairing code (two keys, ADR-0017)
  │    code   = base64url(crypto/rand 32 bytes)            ← via QR code
  │    digits = 16 decimal digits (crypto/rand, rejection sampling) ← typed by hand
  │    one row stores SHA-256(code) and SHA-256(digits), TTL 5 minutes; using either key voids the row
  │
  ├─ stdout prints:
  │    https://term.example.com/pair#<code>
  │    ▄▄▄▄▄▄▄ ▄  ▄▄ ▄▄▄▄▄▄▄       ← ASCII QR code
  │    █ ▄▄▄ █ ▀▄▄▀█▄ █ ▄▄▄ █
  │    …
  │    Can't scan it? Open https://term.example.com/pair and enter the code:
  │        1234-5678-9012-3456
  │                                     phone scans → opens URL     │ or: phone opens /pair
  │                                          │                      │
  │  ←─── GET /pair (fragment not sent) ─────┤ ←────────────────────┤
  │  ───→ static page + JS                   │                      │
  │                                          ├─ JS reads the hash   │ no hash → show input box
  │                                          ├─ replaceState()      │ user types 16 digits
  │  ←─── POST /auth/pair {code} ────────────┤ ←────────────────────┤ (spaces / - accepted, server strips them)
  │
  ├─ rate limit check (5/min/IP, 429 when exceeded)
  ├─ normalize: strip spaces and -; 16 digits → compare as the digit code, otherwise as the URL code
  ├─ constant-time compare against code_hash and digits_hash, row by row
  ├─ check: exists / not expired / not used
  ├─ set used_at
  ├─ create device: id, name (inferred from UA), token_hash
  │
  ├─ Set-Cookie: webterm_session=<token>;
  │    HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000
  │
  │  ───→ 200 {device: {...}} ──────────────→ go to the main UI
```

### Why the URL fragment

`#<code>` **is never sent to the server**, so the pairing code:

- stays out of the server's access logs
- stays out of the `Referer` header
- isn't recorded by proxies along the way

The frontend JS erases it with `history.replaceState` as soon as it reads it, so it doesn't stay in browser history (AC-1.5).

### Why a QR code

Typing 43 characters of base64 on a phone is not acceptable. Scanning also bypasses the clipboard and chat apps (otherwise the code would live forever in chat history).

A pure-Go QR library renders it to stdout with half-block characters (`▀▄█`). Terminals without Unicode support fall back to a double-width `##`/`  ` version.

### Can't scan: type 16 digits (ADR-0017)

You can't scan when you're holding the phone and the terminal is on another screen, and pasting the URL into a chat app is exactly what T2 is meant to avoid. So every pairing also issues a **16-digit decimal code**, printed in the terminal as `1234-5678-9012-3456`. Opening `https://term.example.com/pair` (no fragment) in the phone's browser shows a numeric input: `inputmode=numeric`, grouped in fours as you type, submittable only at 16 digits, spaces and `-` accepted.

The digit code and the URL code are **two keys to the same pairing**: their hashes live in the same row, using either one voids the row, and both get the same 5-minute TTL and constant-time comparison. About 53 bits of entropy is enough under the existing rate limits: during a code's 5-minute life there can be at most 50 guesses from anywhere (global circuit breaker), for a hit probability of 5 × 10⁻¹⁵ — the derivation is in ADR-0017. **It doesn't replace the URL code**: there's no reason to lower the entropy of the QR path.

## Pairing more devices

`webterm pair` generates a new pairing code at any time (printing the same URL + QR code), for adding a new device.

```
$ webterm pair
Pairing code created. It is valid for 5 minutes:

  https://term.example.com/pair#kJ8x...

  ▄▄▄▄▄▄▄ ▄  ▄▄ ▄▄▄▄▄▄▄
  …
Scan the QR code with your phone to authorize it.

Can't scan it? Open  https://term.example.com/pair  in your phone's browser and enter:

      4821-0937-5566-1204
```

**Implementation note**: `webterm pair` is a separate process that writes to the same DB. SQLite's WAL mode supports access from several processes, but `SQLITE_BUSY` has to be handled (`busy_timeout = 5000`).

## Device management (AC-1.3)

`GET /api/devices`:

```json
[
  { "id": "a3f…", "name": "iPhone · Safari", "created_at": …, "last_seen_at": …, "last_ip": "1.2.3.4", "current": true }
]
```

- `current` marks the device making the request (so you don't kick yourself out by accident — the UI asks for confirmation on it)
- `name` is inferred from `User-Agent` (`iPhone · Safari` / `macOS · Chrome`) and can be changed with `PATCH`
- `DELETE /api/devices/:id` revokes one device
- `POST /api/devices/revoke-all` revokes all of them (**including the current one**, which then has to pair again)

Updates to `last_seen_at` / `last_ip` are throttled (at most one write per device per 60 seconds) so not every request hits the DB.

### Signing out (AC-1.22, [ADR-0048](../20-architecture/adr/0048-sign-out.md))

`POST /auth/logout` revokes the requesting device, exactly like revoking it from elsewhere, and on the same response clears the cookie and sends `Clear-Site-Data: "cookies", "storage", "cache"`. The cookie is `HttpOnly`, so this response is the only way the page can get rid of it; and revoking matters more than deleting: a copied token stops working too. The page then removes its own `localStorage` keys, service worker and caches, for browsers that ignore `Clear-Site-Data`. Offline it refuses: a local-only sign-out would leave a token the server still accepts.

### Revocation takes effect immediately (AC-1.11)

Checking only at the handshake isn't enough — a WebSocket can stay open for days.

Every **2 seconds** the agent scans its active connections. For each one whose device has been revoked, it sends `notice{level:"error", message:"This device has been revoked"}`, then `error{code:"unauthorized"}`, then closes the connection.

A request that carries a revoked device's cookie gets `401 {"code": "revoked"}` rather than the plain `unauthorized`, and the cookie is cleared as for any rejected one. A page opened after the revocation (the PWA from the home screen, a reload) can then say why it shows the pairing page; without it, the device would look as if it had never been paired. Only the holder of that token learns this.

The scan runs every 2 seconds rather than every 5 to leave headroom for AC-1.11's 5-second SLA — with the period equal to the SLA, the worst case would always overrun slightly.

## Session cookie

| Attribute | Value | Notes |
|---|---|---|
| Name | `webterm_session` | |
| Value | base64url(32 bytes of `crypto/rand`) | Only the SHA-256 is stored in the DB |
| `HttpOnly` | ✓ | Not readable from JS |
| `Secure` | ✓ (omitted under `--dev`) | |
| `SameSite` | `Strict` | CSRF protection |
| `Path` | `/` | |
| `Max-Age` | 31536000 (1 year) | |

**Sliding renewal**: on each request, if the cookie has less than 30 days left, it's re-issued with `Set-Cookie` (and `last_seen_at` is updated; the token itself isn't rotated). Devices in regular use never get signed out.

**No token rotation**: rotation means handling the race where concurrent requests still carry the old token, and the benefit (limiting how long a stolen token works) is marginal when revocation is immediate.

## Rate limiting (AC-1.6)

Only `POST /auth/pair` is rate-limited (every other route is either static or authenticated).

```
Per IP: 5 / minute
Exceeded → 429 + Retry-After
Consecutive failures → exponential backoff: 1s, 2s, 4s, 8s, … capped at 5 minutes
Global: 50 failures per hour across all IPs → stop accepting pairings for 10 minutes and print a warning to stdout
```

Behind a reverse proxy (`--trust-proxy`), the last hop of `X-Forwarded-For` is used as the IP. `X-Forwarded-For` is **not trusted by default**; otherwise an attacker could forge it to get around the limit.

Rate-limit state lives in memory (cleared on restart) and is never written to the DB.

## Route authentication matrix (AC-1.7)

| Route | Authentication required |
|---|---|
| `GET /` `GET /assets/*` `GET /manifest.json` `GET /sw.js` | ✗ |
| `GET /pair` | ✗ (the page itself; the code is in the fragment) |
| `POST /auth/pair` | ✗ (this is the pairing entry point, protected by rate limiting) |
| `POST /auth/logout` | ✓ (plus the `Origin` check; signs out the requesting device) |
| `GET /healthz` | ✗ (returns only `ok`, discloses nothing) |
| `GET /.well-known/acme-challenge/*` | ✗ (ACME, :80 only) |
| **`GET /ws`** | **✓** (plus the `Origin` check) |
| `POST /api/uploads` | ✓ (plus the `Origin` check, [ADR-0051](../20-architecture/adr/0051-send-files-to-a-session.md)) |
| `GET /api/fs/list` `GET /api/fs/raw` | ✓ ([ADR-0059](../20-architecture/adr/0059-files.md)) |
| `POST /api/fs/upload` `POST /api/fs/mkdir` `POST /api/fs/rename` `DELETE /api/fs` | ✓ (plus the `Origin` check, ADR-0059) |
| `/api/*` | ✓ |

**`/ws` requires authentication** is the rule most easily missed. The middleware must cover the WebSocket upgrade path, not just the REST routes.

## Why static assets aren't authenticated

The frontend JS/CSS contains no secrets (all data comes through authenticated APIs). Authenticating static assets would create a loop in which the login page itself needs authentication, and would complicate Service Worker caching.

When an unauthenticated user opens `/`, the frontend JS calls `/api/devices`, gets 401, and shows a "pairing required" page (telling the user to run `webterm pair` on the server).

## `--dev` mode

**No authentication bypass of any kind.** There is a single code path (bypasses are a classic source of security bugs).

The only differences under `--dev`:
- the cookie has no `Secure`
- `Origin` may be `http://localhost:*` / `http://127.0.0.1:*`
- no certificate is requested and no HSTS is sent

Pairing works exactly the same — startup prints `http://127.0.0.1:8080/pair#...`; open it locally.

## v0.2: Passkey / WebAuthn

Pairing codes handle first-time authorization, and cookies keep you signed in. The remaining gap: **adding a new device requires access to the server's terminal**.

Passkeys would fill that gap: after pairing one device, register a passkey; from then on any new device can sign in with Face ID or a fingerprint, with no need to SSH into the server.

Not in v0.1, because the current flow works and passkeys bring their own registration/assertion flow and credential storage.
