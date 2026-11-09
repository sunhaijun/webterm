# ADR-0046 Guided install

Status: Accepted (2026-11-01). Builds on [ADR-0045](0045-install-from-the-binary.md). §1 and §2 amended by [ADR-0063](0063-installer-asks-for-the-port.md): the installer also asks for the HTTPS port (Enter = 8443), and the firewall note follows the questions.

## Context

Two setup steps can only be done by the user, outside the server: allowing inbound TCP 80/443 in the cloud firewall, and (optionally) creating a DNS record. ADR-0045 detects both but then exits, leaving the user to read the error, fix it, and start over. The installer should instead walk the user through these steps and verify them.

## Decision

The installer is guided whenever it has a terminal (`/dev/tty`); without one (automation) it checks once and fails with the same explanation.

1. **Say it up front.** A fresh install starts by stating the one thing to do outside the server: allow inbound TCP 80/443 in the cloud firewall.
2. **Ask for the address.** With no `--domain` and no previous install, it asks: Enter accepts the detected public IPv4, or type a domain (a pasted URL is trimmed to its host).
3. **DNS.** `webterm doctor --guide` shows the exact record to add (type, name, value) when the domain doesn't resolve to this server, then polls every 10 seconds (up to 30 minutes) until it does. It resolves through 1.1.1.1/8.8.8.8 first, because the local stub resolver caches the negative answer.
4. **Cloud firewall.** When the certificate request fails because Let's Encrypt can't reach the server (`agent.IsUnreachable`), doctor explains which ports to open — naming the provider's console page when DMI identifies the cloud (Alibaba, Tencent, Huawei, AWS, GCP, Azure, DigitalOcean, Hetzner, Vultr, Oracle) — and waits for Enter. Each re-check is a Let's Encrypt **staging** request into a throwaway directory, which doesn't consume production failure allowances. Once staging succeeds, doctor requests the real certificate. A user who keeps pressing Enter costs at most two failed production validations.
5. Other failures (rate limits, a CA without IP support, busy ports) are not something waiting fixes: doctor reports them and exits.

Prompts read from `/dev/tty`, not stdin: under `curl | bash` stdin is the script itself, and the handed-over child gets `/dev/null`.

## Consequences

- From a terminal, a first install runs to the pairing QR code without restarting, whatever the state of DNS and the cloud firewall.
- Staging is back, but only as an internal probe: no flag, no shared cache (compare ADR-0044 §3).
- `IssueCheck` returns `*agent.IssueError` with a ready-to-print diagnosis and an `Unreachable` flag.
