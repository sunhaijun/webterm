# webterm

Your server's shell in the browser — built for phones as much as desktops, and it doesn't lose your place when the network drops.

webterm is a single Go binary. Install it on a Linux server, scan a QR code with your phone, and you have persistent terminal sessions you can reach from any browser over HTTPS.

## Why

SSH from a phone, or over a flaky connection, is painful: sessions drop, IME input is fiddly, and scrolling back means tmux copy-mode. webterm treats the terminal as a data source and builds the interaction around it:

- **Survives disconnects.** Sessions keep running on the server. After a short drop, only the missing bytes are replayed; after a long one, or a page reload, the server-side terminal emulator sends the full screen plus 2000 lines of history.
- **Made for touch.** A full-screen terminal with two fixed rows of extra keys (Esc, Ctrl, arrows, …), a session drawer on phones and tabs on larger screens. Installable as a PWA.
- **Input you can trust.** IME composition goes straight to the terminal, a native text page handles long passages, and input typed while offline is queued, not dropped.
- **Scrollback by dragging.** AI CLIs like Claude Code stay on the main screen so their output scrolls.
- **Screenshots for your AI CLI.** The paperclip (or a paste, or a drop) sends a photo or file to the session; Claude Code and Codex attach it as `[Image #1]`.
- **Simple and self-contained.** One static binary with the frontend embedded. Automatic Let's Encrypt certificates, for a domain or just the server's IP. Devices pair with a one-time QR code; no passwords.
- **Upgrades without losing sessions.** The agent re-execs in place and hands its sessions to the new version.
- **Also from a real terminal.** `ssh -t server webterm attach` joins the same sessions from any terminal, through the server's own sshd.

## Install

You need a Linux server (x86_64 or arm64) with a public IPv4 address, a regular user with `sudo`, and inbound TCP 80 and 443 allowed by your cloud firewall. A domain is optional.

```bash
curl -fsSL https://github.com/sunhaijun/webterm/releases/latest/download/install.sh | bash
```

The installer asks for the address (Enter = the server's IP), gets a certificate, sets up a systemd service, and ends with a QR code to scan. If DNS or the cloud firewall isn't ready yet, it tells you exactly what to change and waits.

More options — a domain, other ports, reverse proxies, upgrades: [docs/80-ops/install.md](docs/80-ops/install.md).

Try it locally first:

```bash
./webterm serve --dev     # http://127.0.0.1:8080
```

## Documentation

- [Install](docs/80-ops/install.md) · [Troubleshooting](docs/80-ops/troubleshooting.md) · [systemd](docs/80-ops/systemd.md)
- [Design docs](docs/README.md): vision, requirements, architecture decisions, the WebSocket protocol
- [Security model](docs/60-security/threat-model.md)

## Status

Early (v0.x) but in daily use. Go unit and integration tests, Vitest, and Playwright end-to-end tests (including byte-level resume continuity) cover every change; real-device behavior (IMEs, on-screen keyboards, PWA install) is checked by hand before releases.

The server runs on Linux. Clients are tested with Chrome (desktop, Android) and Safari (iOS).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately: [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE)
