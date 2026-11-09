# ADR-0064 A new address keeps the rest of the install

Status: Accepted (2026-11-09). Amends [ADR-0045](0045-install-from-the-binary.md) §3 and [ADR-0063](0063-installer-asks-for-the-port.md) §4.

## Context

A server installed on its IP address with HTTPS on 8443 was switched to a domain with `webterm install --domain X`, the way [install.md](../../80-ops/install.md#ip-or-domain) says to switch. The installer replayed the previous install's arguments (`install-state`) only when `--domain` wasn't given (ADR-0045 §3), so this run started from the defaults: HTTPS on 443, and the channel and prefix back to theirs too. The upgrade went to 443 instead of 8443 and failed.

The failed run also left the wrong values behind. The config file and `install-state` were written before the service step, so both now said "X on 443", and `webterm update`, which replays `install-state`, would try 443 again. `install-state` is meant to be the last install that worked.

## Decision

1. **`install-state` is replayed whenever it has an address**, also when `--domain` is given. The saved arguments come first and the command line second, so the command line wins. A new `--domain` changes the address only: the HTTPS and HTTP ports, `--channel`, `--prefix` and `--no-service` stay. To change a port, pass it (`--https-port 443` for URLs without a port).
2. **A trial isn't carried over.** An `install-state` without an address (`--dev`, or `--no-service` without `--domain`) is replayed only when `--domain` isn't given, as before, so `webterm install --domain X` after a trial is a first install, and it asks for the port (ADR-0063). `--dev` never replays.
3. **The settings are saved once the install worked.** The config file's address and ports, and `install-state`, are written after the service is running (or, with `--no-service`, after the binary is installed). An install that fails leaves both as they were, so `webterm update` and the next `webterm install` start from the last install that worked.

## Consequences

- Switching between IP and domain, or between domains, is `webterm install --domain <new>` and nothing else; the port, channel and prefix stay.
- Going back to 443 after an install on another port takes an explicit `--https-port 443`.
- Step order in the installer's output: the service is step 5, saving the settings step 6.
- Tests: UT-install-default-addr (a new `--domain` keeps the port and channel; the command line still wins; a trial isn't replayed), UT-install-saved-after (a failed service step leaves config and `install-state` unchanged).
