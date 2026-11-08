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
| `--setup` / `--no-setup` | Set up claude, codex and the shell without asking / don't ask ([below](#set-up-claude-codex-and-the-shell)) |
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
webterm setup --check        # are claude, codex and the shell set up?
journalctl -u webterm -f     # logs
```

`webterm update --when-idle` waits until no session is running a command; `--force-restart` restarts instead (closes all sessions). Changing the address or ports with `webterm install --domain … --https-port …` is a hot upgrade too: sessions survive. If the running agent can't be upgraded in place, the installer stops and says so rather than restarting.

Problems: [troubleshooting.md](troubleshooting.md).

## Set up claude, codex and the shell

[ADR-0055](../20-architecture/adr/0055-webterm-setup.md). Three settings in other programs' files make "waiting for you" and frequent input work fully: claude rings the bell for its notifications, codex sends its notifications, and the shell writes each command to its history as it runs. A first install asks whether to add them; any time later:

```bash
webterm setup --check   # what's set, what's missing
webterm setup           # show the changes, ask once, add them
webterm setup --yes     # add them without asking
```

| Program | File | Added |
|---|---|---|
| claude | `~/.claude/settings.json` | `"preferredNotifChannel": "terminal_bell"` (not if you chose another channel) |
| codex | `~/.codex/config.toml` | `notifications = true`, `notification_condition = "always"` under `[tui]` |
| bash / zsh | `~/.bashrc` / `~/.zshrc` | A block marked `# >>> webterm >>>` that writes history as you go |

Only what's missing is added, and only lines are inserted: the rest of each file stays as it was. Each file is copied to `<file>.webterm-bak` before its first change. Programs that aren't installed are skipped. `webterm update` never runs it.

## From a terminal over SSH

The same sessions are reachable from any terminal through the server's own sshd ([ADR-0050](../20-architecture/adr/0050-ssh-attach.md)):

```bash
ssh -t server webterm attach           # one session: attach; several: pick from a list
ssh -t server webterm attach claude    # by name (exact, else a case-insensitive substring)
ssh -t server webterm attach 2         # by position, the [n] on the tab bar
ssh -t server webterm attach --new     # a new session; the browser shows it too
ssh server webterm attach --list       # just the list
```

`-t` is required: attach needs a terminal. To detach, close the window or use ssh's escape, `Enter ~ .`; the session keeps running. Typing in a client gives the session that client's size, so the window you're typing in is the one with the right layout.

There is nothing to set up on the server: the agent serves attach on a socket in its data directory, and the server's sshd does the authentication. Two things must hold:

- **Same user.** Log in as the user the service runs as, the one who installed it. Any other user gets `webterm isn't running for this user`.
- **A new enough agent.** Attach arrived in v0.5.0; older agents answer `the running agent is too old for attach`. Upgrade with `webterm update`; sessions survive.

Attaching replaces the local terminal's scrollback with the session's history. To make `ssh server-term` land in the session list, add to `~/.ssh/config` on your laptop:

```
Host server-term
  HostName server.example.com
  RequestTTY yes
  RemoteCommand webterm attach
```

The installer puts `webterm` in `/usr/local/bin`, which ssh commands find. With `--prefix` elsewhere, give the full path (`ssh -t server ~/.local/bin/webterm attach`): ssh runs commands in a non-login shell, which usually doesn't have `~/.local/bin` on its `PATH`. Errors: [troubleshooting](troubleshooting.md#ssh-attach).

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
| `webterm setup [--check] [--yes]` | Check and add the claude, codex and shell settings webterm uses ([above](#set-up-claude-codex-and-the-shell)) |
| `webterm attach [name \| n] [--new] [--list]` | Attach this terminal to a session ([From a terminal over SSH](#from-a-terminal-over-ssh)) |
| `webterm reload [--when-idle] [-- serve …]` | Hot-upgrade to the binary on disk; after `--`, the command line the new process starts with |
| `webterm version` | Version |

## Data and backups

```
~/.local/share/webterm/
├── webterm.db    devices — back this up
├── certs/        certificates — worth backing up (re-issuing is rate-limited)
└── run/          control and attach sockets
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
