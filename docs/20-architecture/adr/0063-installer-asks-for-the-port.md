# ADR-0063 The installer asks for the HTTPS port

Status: Accepted (2026-11-08). Amends [ADR-0046](0046-guided-install.md) §1 and §2. Builds on [ADR-0062](0062-several-machines.md).

## Context

The guided install asked one question, the address, and took 443 for HTTPS unless `--https-port` was on the command line. Typing `host:8443` at the address prompt was refused with "rerun with --https-port". In practice 443 is often already taken on a VPS (Xray, another web server), so the first run of the one-line install picks the wrong port. Several machines in one page (ADR-0062) also work best with one port everywhere: an added machine without a port gets the page's.

## Decision

1. **Ask for the port.** On a first install (no previous install state, nothing running) without `--https-port`, after the address the installer asks for the HTTPS port: Enter is **8443**, or type a number. A number that isn't 1–65535 or equals the HTTP port is asked again.
2. **A port typed with the address is taken.** `host:port` at the address prompt (or a pasted `https://host:port/`) sets the HTTPS port, and the port question is skipped.
3. **Without a terminal**, a first install without `--https-port` uses 8443 too. So does `--print-unit` and `--dry-run` on a first install.
4. **Existing installs keep their port.** A previous install's state is replayed as before: it records the HTTPS port only when it isn't 443, so an install on 443 stays on 443. `--https-port` on the command line always wins. `webterm serve` keeps 443 as its default; the installer passes `--https-port 8443` in the unit.
5. **The HTTP port isn't asked.** Let's Encrypt validates on port 80 only; `--http-port` is for setups that forward 80 to another port.
6. **The firewall note comes after the questions**, so it names the ports chosen ("allow inbound TCP 80 and 8443"), rather than first thing (ADR-0046 §1).

## Consequences

- A fresh one-line install no longer collides with whatever holds 443, and every server installed with the defaults has the same port.
- Pairing links and the QR code carry `:8443`; the address to type is a little longer. Someone who wants `https://host/` types 443 at the prompt or passes `--https-port 443`, and ports below 1024 need the capability the installer grants.
- The cloud firewall has to allow 8443 instead of 443; the installer and `webterm doctor` name the ports actually used.
