# Install

## Requirements

- Linux (x86_64 or arm64) and a regular user with `sudo` — not root
- A public IPv4 address. A domain is optional
- Inbound TCP 80 and 443 allowed by your cloud provider's firewall (security group)

## Install

On the server:

```bash
curl -fsSL https://github.com/sunhaijun/webterm/releases/latest/download/install.sh | bash
```

The installer walks you through it ([ADR-0046](../20-architecture/adr/0046-guided-install.md)):

1. **Address.** Press Enter to use the server's public IP, or type a domain.
2. **Firewall.** Opens ports 80/443 in ufw or firewalld if either is active.
3. **Certificate.** Requests a Let's Encrypt certificate. If something outside the server is missing, it stops, tells you exactly what to do, and checks again:
   - *DNS:* shows the `A` record to add and waits until it resolves to this server.
   - *Cloud firewall:* names the console page to open ports 80/443 in, and re-checks when you press Enter.
4. **Service.** Installs a systemd service running as your user and starts it.
5. **Pairing.** Prints a QR code. Scan it with your phone and you're in.

Re-running the same command later upgrades in place; open sessions survive.

### Other ways to install

```bash
# A binary you already have (no download on the server):
scp webterm server: && ssh -t server ./webterm install

# Skip the address question:
curl -fsSL …/install.sh | bash -s -- --domain term.example.com
```

`ssh -t` is required: the installer needs a terminal for `sudo` and its questions. Without a terminal it never prompts: it uses the public IP and fails with an explanation instead of waiting.

### Installer options

| Option | Meaning |
|---|---|
| `--domain <name or IPv4>` | Address to serve. Default: the previous install's, else ask |
| `--https-port <n>` | Use another HTTPS port when 443 is taken |
| `--channel dev` | Install the rolling build of `main` |
| `--version <tag>` | Install a specific release |
| `--dry-run` | Show what would happen |
| `--force` | Continue even if the certificate check fails |

All options: `install.sh --help` or `webterm install --help`.

## Pair more devices

Run `webterm pair` (on the server, or in a session on a device that's already paired) and scan the QR code. If you can't scan, open `https://<address>/pair` and type the 16 digits. Codes expire after 5 minutes and work once. On a phone, "Add to Home Screen" installs webterm as an app.

## Day to day

```bash
webterm                      # status: service, address, certificate, devices
webterm update               # upgrade; sessions survive
webterm devices              # list or revoke devices
journalctl -u webterm -f     # logs
```

`webterm update --when-idle` waits until no session is running a command; `--force-restart` restarts instead (closes all sessions).

Problems: [troubleshooting.md](troubleshooting.md).

## IP or domain

| | IP | Domain |
|---|---|---|
| DNS | none | one `A` record |
| Certificate | 6 days, renewed every ~4 days | 90 days, renewed 30 days ahead |
| Port 80 | must stay open | can close after issuance |
| Moving servers | devices pair again | update the record |

To switch, reinstall with `--domain <new address>`; every device must pair again (it's a different origin to the browser). IPv6-only servers need a domain with an `AAAA` record.

## Non-standard ports

When 443 is taken (by Xray, another web server, …): `--https-port 8443`. Pairing links and redirects include the port automatically. Certificates are still validated on port 80, so keep 80 free. With both ports above 1024, no capability is needed.

## Reverse proxy or tunnel

Let nginx, Caddy, cloudflared or frp terminate TLS and run webterm on loopback:

```bash
webterm serve --domain term.example.com --bind 127.0.0.1 --no-tls --http-port 8080 --trust-proxy
```

- Forward the WebSocket upgrade headers (`Upgrade`, `Connection`).
- Raise the read timeout (nginx: `proxy_read_timeout 3600s`).
- Keep `--domain`: the Origin check uses it.
- Use `--trust-proxy` only behind a proxy.

Service unit for this setup: [systemd.md](systemd.md#reverse-proxy-or-tunnel).

## Behind NAT

If the public IP isn't on this machine (home routers, some VPS providers), either forward ports 80/443 to it — many ISPs block 80, which the installer will report — or use a tunnel or reverse proxy (above).

## Try it locally

```bash
./webterm serve --dev        # http://127.0.0.1:8080, prints a pairing link
```

## Manual install

```bash
sudo install -m755 webterm /usr/local/bin/webterm
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/webterm
webterm doctor --domain term.example.com --acme --guide    # checks, and obtains the certificate
webterm serve --domain term.example.com
```

To run it as a service, see [systemd.md](systemd.md).

## Security notes

- Run webterm as a regular user. Whoever runs the agent is who an attacker becomes; as root, that's a root shell on the internet.
- Binding ports below 1024 relies on a file capability (`setcap`). It's lost whenever the binary is replaced; the installer and `webterm update` re-apply it.
- Use `sudo` inside a session when you need root.

See [the threat model](../60-security/threat-model.md).

## Certificates

Renewal is automatic as long as the service runs:

| | Domain | IP |
|---|---|---|
| Lifetime | 90 days | ~6 days |
| Renewed | 30 days before expiry | ~53 hours before expiry |
| Needs reachable | port 80 or 443 | port 80 |

A yellow certificate line in `webterm` means renewal keeps failing; check the logs.

## Configuration

`~/.config/webterm/config` holds the address and ports (written by the installer) and any other `webterm serve` flag without the leading `--`:

```ini
domain     = term.example.com
https-port = 8443
log-level  = info
```

Command-line flags override the file; unknown keys are an error with the line number. `dev` and `config` can't be set in the file.

### `webterm serve` flags

| Flag | Default | |
|---|---|---|
| `--domain` | | Domain or public IPv4 (required in production) |
| `--dev` | false | Local mode: `127.0.0.1:8080`, plain HTTP, no certificate |
| `--data-dir` | `~/.local/share/webterm` | Data directory |
| `--http-port` | 80 | Certificate validation and redirects |
| `--https-port` | 443 | HTTPS |
| `--bind` | `0.0.0.0` | Listen address |
| `--no-tls` | false | Plain HTTP; only with a loopback or private `--bind` |
| `--trust-proxy` | false | Trust `X-Forwarded-For` (only behind a proxy) |
| `--max-sessions` | 20 | Session limit |
| `--max-conns` | 16 | WebSocket connection limit |
| `--ring-bytes` | 262144 | Per-session ring buffer for resuming after disconnects |
| `--session-env` | | Extra `KEY=VAL` for sessions; repeatable |
| `--no-altscreen-compat` | false | Don't keep AI CLIs on the main screen ([ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md)) |
| `--no-login-shell` | false | Start shells without `-l` |
| `--shell` | `bash` | Session shell |
| `--log-level` | `info` | `debug`, `info`, `warn`, `error` |

### Other commands

| Command | |
|---|---|
| `webterm install` | Install or upgrade using this binary |
| `webterm update` | Upgrade to the latest release |
| `webterm pair [--wait]` | Print a pairing code and QR code |
| `webterm devices [list \| revoke <id> \| revoke-all]` | Manage devices |
| `webterm doctor [--acme] [--guide]` | Check prerequisites; `--acme` obtains the certificate, `--guide` waits for you to fix things |
| `webterm reload [--when-idle]` | Hot-upgrade to the binary on disk |
| `webterm version` | Version |

## Data and backups

```
~/.local/share/webterm/
├── webterm.db    devices — back this up
├── certs/        certificates — worth backing up (re-issuing is rate-limited)
└── run/          control socket
```

```bash
sqlite3 ~/.local/share/webterm/webterm.db ".backup webterm-backup.db"
```

## Uninstall

```bash
sudo systemctl disable --now webterm
sudo rm /etc/systemd/system/webterm.service /usr/local/bin/webterm
sudo systemctl daemon-reload
rm -rf ~/.local/share/webterm ~/.config/webterm
```

## Build from source

Requires Go 1.27+ and Node 22+:

```bash
make build      # ./webterm
make release    # release/: binaries for amd64 and arm64, install.sh, SHA256SUMS
```
