# ADR-0004 TLS via ACME only

Status: Accepted (2026-09-06). Amended by [ADR-0044](0044-ip-address-certificates.md) (2026-10-31): now that Let's Encrypt issues IP certificates, `--domain` also accepts a public IPv4 address, so a domain is no longer required; `--acme-staging` is removed. The rejection of the sslip.io fallback below still stands: an IP certificate is more direct than borrowing someone else's domain.

## Context

We considered three TLS tiers: (1) ACME with a domain, (2) ACME for an `sslip.io` wildcard name when there is no domain, (3) self-signed certificates for LAN-only use.

The actual deployment has a public IP, a domain, and ports 80/443 available.

## Decision

**Production supports only automatic ACME issuance (`golang.org/x/crypto/acme/autocert`). No self-signed certificates, no `sslip.io` fallback.**

There are two TLS paths:

| Mode | Command | Listens on | Notes |
|---|---|---|---|
| Production | `webterm serve --domain X` | `:80` (ACME HTTP-01 + redirect to HTTPS), `:443` | Automatic issuance and renewal |
| Production, other port | add `--https-port 8443` | `:80`, `:8443` | When another service owns 443. Issuance still uses HTTP-01 on 80; the public URL includes the port |
| Development | `webterm serve --dev` | `127.0.0.1:8080`, plain HTTP | `localhost` is already a secure context |

TLS is mandatory, and not only for transport security: **without a secure context, half the product doesn't work.**

| Feature | Needs a secure context |
|---|---|
| PWA install / Service Worker | Yes |
| Clipboard API (copy output) | Yes |
| Web Push (notify when a long command finishes, v0.2) | Yes |

`localhost` counts as a secure context; `http://192.168.1.10:8080` **does not**. So remote access needs TLS, even on a LAN.

Rejected:

- **Self-signed certificates.** iOS needs a configuration profile installed to trust them, which is a poor experience. They would be a permanent source of support noise ("why won't it open on my phone" is nine times out of ten the certificate). **Local development doesn't need them**: `http://localhost:PORT` is already a secure context.
- **sslip.io fallback.** Names like `1-2-3-4.sslip.io` resolve to the embedded IP, so Let's Encrypt can issue certificates for them. It works and is a decent way to get HTTPS without a domain. **But we had a domain**, and keeping a code path for a scenario we didn't have is pure cost. A real need would get a new ADR (it did: ADR-0044).

Implementation:

- `autocert.Manager`'s `HostPolicy` allows exactly the `--domain` value, **no wildcards**; otherwise anyone could make us request certificates for arbitrary names.
- Certificate cache: `~/.local/share/webterm/certs`, mode `0700`.
- `:80` serves `/.well-known/acme-challenge/` and 301-redirects everything else to HTTPS.
- HSTS: `Strict-Transport-Security: max-age=31536000` (not sent with `--dev`).
- **Failures produce errors a human can act on** (US-7.2 / AC-1.13). At least:
  - port 80 in use → suggest `ss -lntp` and explain that the HTTP-01 challenge needs port 80;
  - DNS doesn't point here → print the resolved addresses next to this machine's public IP;
  - Let's Encrypt rate limit → explain the rate-limit window.
- `--acme-staging` used the Let's Encrypt staging environment to debug a deployment without hitting production rate limits. **Removed by [ADR-0044](0044-ip-address-certificates.md) §3**: it shares the cache with production certificates, so it could leave the production service serving a staging certificate. The pre-install check now issues a production certificate directly.
- `--bind` and `--no-tls` stay (loopback or private addresses only) for users who put their own reverse proxy or tunnel in front. See [ADR-0002](0002-self-contained-binary.md).

## Consequences

- Deployment has hard prerequisites: **a domain that resolves to this machine, and ports 80/443 available** (ADR-0044 relaxed the first to "a domain or a public IPv4 address"). These are in the pre-flight checks of [`../../80-ops/install.md`](../../80-ops/install.md), and `webterm doctor` checks them before startup.
- Tests verify issuance against a local ACME server (pebble, IT-tls-1), never real Let's Encrypt.
