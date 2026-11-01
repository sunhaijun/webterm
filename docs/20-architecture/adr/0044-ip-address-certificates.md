# ADR-0044 Deploy without a domain: Let's Encrypt IP certificates

Status: Accepted (2026-10-31). Amends [ADR-0004](0004-acme-only-tls.md): TLS still comes only from ACME; the address may now be an IP.

## Context

ADR-0004 required a domain, so every new server started with a trip to a DNS console. Since 2026-01-15 Let's Encrypt issues certificates for IP addresses ([announcement](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)), only with the `shortlived` profile (about 160 hours). `golang.org/x/crypto/acme` supports IP identifiers (`acme.IPIDs`, RFC 8738) and profiles (`WithOrderIssuanceProfile`) from v0.58.0; `autocert` still handles domains only.

## Decision

### 1. `--domain` accepts a public IPv4 address

No new flag: `--domain` is "the host in the browser's address bar", used for the certificate, the Origin check, the pairing URL and redirects alike. IPv6 literals are rejected with an explanation; listening, URL building and port checks don't handle brackets or dual stack yet.

### 2. IP mode uses its own certificate manager

autocert can't be used: it only orders `dns` identifiers and selects certificates by SNI, which browsers don't send for IP addresses. `internal/agent/ipcert.go` drives `acme.Client` directly:

| | |
|---|---|
| Order | `AuthorizeOrder(acme.IPIDs(ip), WithOrderIssuanceProfile("shortlived"))`; a directory without `shortlived` fails with "this CA doesn't issue IP certificates" |
| Challenge | HTTP-01 only, answered on `:80`; everything else there redirects to HTTPS |
| Handshake | `GetCertificate` ignores SNI and never triggers issuance, so there's nothing to abuse (the threat ADR-0004's HostPolicy guards against) |
| Cache | `certs/<ip>` in autocert's format (key PEM, then the chain), account key in `certs/acme_account+key` |
| Startup | Use the cached certificate if valid; restarts never re-issue (5 duplicates per week is the limit) |
| Renewal | When less than a third of the lifetime remains (~53 h for 160 h), like autocert; on failure retry hourly; each attempt times out after 5 minutes |

TLS-ALPN-01 for IPs (RFC 8738 §6) needs a reverse-DNS SNI and an iPAddress SAN in the challenge certificate, which x/crypto doesn't build, and it can't work with an `--https-port` other than 443. HTTP-01 is enough.

**Cost:** in IP mode port 80 must stay reachable. With a domain, renewal can fall back to 443.

### 3. No staging

`--acme-staging` is gone; a config file that still sets `acme-staging` fails to load with a clear message.

It shared `certs/` with production, and autocert doesn't check the issuer of a cached certificate: depending on the order of operations, a staging run either validated nothing or left a staging certificate that production served for ~60 days. It isn't worth fixing. Its only purpose was a dry run that doesn't spend production quota, but the install-time check (ADR-0045 §4) now requests the real certificate: success is the issuance the service uses, and failure only costs the hourly "5 failed validations per identifier per account" allowance. The weekly limits count successful issuances only.

Staging survives as an internal reachability probe during a guided install (ADR-0046), with a throwaway directory.

### 4. Expiry warning scales with lifetime

The status overview turns yellow below `min(10 days, lifetime / 4)`: 10 days for 90-day certificates, 40 hours for IP certificates (which renew at ~53 hours remaining).

### 5. doctor in IP mode

Instead of DNS checks, doctor verifies that `--domain` equals this machine's public IP (via api.ipify.org); a mismatch usually means NAT or a changed IP.

## Consequences

- A new server needs nothing outside it except an open cloud firewall; a domain is optional.
- Changing the IP, or moving from IP to a domain, changes the browser origin: cookies and PWA installs don't carry over and every device must pair again.
- HSTS is still sent; browsers ignore it for IP hosts (RFC 6797 §8.1).
- A valid certificate with an IP SAN makes a secure context, so PWA, clipboard and service workers work (to be confirmed on real devices).
- x/crypto moved from v0.56.0 to v0.58.0 (pure Go).
- Machines that once ran `--acme-staging` may still hold a staging certificate in `certs/`; the troubleshooting guide explains how to remove it.
