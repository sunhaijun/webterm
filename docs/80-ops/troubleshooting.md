# Troubleshooting

Start with `webterm` (status overview) and `webterm doctor`. They cover most of what follows.

## Certificates and TLS

### Stuck getting a certificate

```bash
sudo systemctl stop webterm
webterm doctor --acme --guide     # checks address and ports, requests the certificate, explains failures
sudo systemctl start webterm
```

| Symptom | Cause | Fix |
|---|---|---|
| `no viable challenge type found`, `Invalid response from http://…` | Let's Encrypt can't reach the server | Allow inbound TCP 80/443 in the **cloud firewall** (most common), then `ufw status`. From another machine: `curl -sI http://<address>/` must not time out |
| DNS points elsewhere | Record missing, wrong, or not propagated | Use an `A`/`AAAA` record, not a CNAME; wait for the TTL |
| Cloudflare proxy (orange cloud) | Cloudflare intercepts the challenge | Set the record to DNS only |
| `rateLimited` | Let's Encrypt limits | Failed validations: 5 per hour, wait ~15 minutes. Issued certificates: 50 per domain/IP and 5 duplicates per week — usually from deleting `certs/` repeatedly; wait |
| `doesn't issue IP certificates` / `shortlived` | Custom ACME directory without IP support | Use Let's Encrypt, or a domain |
| `only IPv4 is supported` | `--domain` is an IPv6 literal | Use a domain with an `AAAA` record |
| `public IP is …, not …` | Wrong IP, IP changed, or behind NAT | Reinstall with `--domain <ip>`; devices must pair again |
| `bind: address already in use` | Another server holds 80/443 | Stop it, use [another port](install.md#non-standard-ports), or a [reverse proxy](install.md#reverse-proxy-or-tunnel) |
| `bind: permission denied` | No capability for low ports | `sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/webterm` |
| `setcap` not found | libcap missing | `sudo apt install libcap2-bin`, or ports above 1024 |

### `TLS handshake error` in the logs

Logged at debug level only (`--log-level debug`): the ports face the internet and scanners produce these constantly. `remote error: tls: unknown certificate` means the client rejected the certificate. If that's your own device, inspect what's being served:

```bash
echo | openssl s_client -connect <host>:<port> -servername <host> 2>/dev/null | openssl x509 -noout -issuer -dates
```

An issuer containing `STAGING` is a leftover from the removed `--acme-staging` flag: autocert reuses cached certificates regardless of issuer. Delete it:

```bash
sudo systemctl stop webterm && rm -f ~/.local/share/webterm/certs/<host>* && sudo systemctl start webterm
```

### Certificate doesn't renew

Domain certificates renew 30 days before expiry and need port 80 **or** 443 reachable from the internet. IP certificates renew ~53 hours before expiry and need **port 80**. A yellow certificate line in `webterm` means renewal has failed for a while:

```bash
journalctl -u webterm --since "2 days ago" | grep -iE 'acme|certificate'
ss -lntp | grep -E ':(80|443)\b'
```

Typical causes: port 80 closed in IP mode, the server moved behind NAT, the IP changed, or a Cloudflare proxy.

## Connections

### The page won't load

```bash
systemctl status webterm
curl -I https://<address>/healthz
journalctl -u webterm -n 50
```

### The terminal keeps reconnecting

Check the WebSocket status in the browser's dev tools:

| Status | Meaning |
|---|---|
| `401` | Not authorized: cookie lost or device revoked; pair again |
| `403` | Origin mismatch: `--domain` and `--https-port` must match the address bar exactly |
| `503` | More than `--max-conns` connections |
| closes with `protocol_unsupported` | Frontend and agent versions differ; reload the page |

Behind a reverse proxy, make sure it forwards `Upgrade` and `Connection`.

### Disconnects every 60 seconds

A proxy read timeout (nginx defaults to 60 s). webterm pings every 30 s, so raise the proxy timeouts:

```nginx
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

### The screen redraws after switching back or reconnecting

Output during the gap exceeded the ring buffer (256 KiB), so the agent sent a snapshot instead of the missing bytes ([ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)). Nothing is lost. Reloads and width changes always use a snapshot. A bigger buffer makes short gaps incremental: `--ring-bytes 1048576` (costs sessions × ring size of memory).

### Connections drop under heavy output or input

A bounded queue tripped ([protocol §5.6](../30-protocol/websocket-protocol.md)):

| Log | Meaning |
|---|---|
| `conn queue full` | The client can't keep up with output; it reconnects and catches up |
| `input_stalled` | A session's program stopped reading input; press `Ctrl+C` there or close it |

### The service stops when you log out

It's still an old user service without lingering. Migrate once, over SSH: `webterm update --force-restart` ([systemd.md](systemd.md#migrating-from-a-user-service)).

### `Failed to connect to bus` from `systemctl --user` in a session

- No lingering: `sudo loginctl enable-linger $USER && sudo systemctl start user@$(id -u).service`
- A hand-written unit without `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS`: add them with the literal UID ([systemd.md](systemd.md#the-unit)), then restart.

## Sessions

### All sessions are gone

Sessions die only when the agent process does; hot upgrades keep them ([ADR-0016](../20-architecture/adr/0016-hot-reexec.md)).

```bash
systemctl show webterm -p NRestarts -p ExecMainStartTimestamp
sudo journalctl -u webterm | grep -iE 'oom|Main process exited|Stopping'
```

| Log | Cause |
|---|---|
| `Stopping webterm.service` | A restart or `update --force-restart`. Use `webterm update` to keep sessions |
| `reload` said "the agent restarted … sessions were lost" | The new binary failed after taking over and systemd started it again. File a bug with the log around it |
| `oom-kill` | Out of memory. If `systemctl cat webterm` lacks `OOMScoreAdjust=-900`, it's an old user service: migrate. Otherwise the machine needs more memory |
| `code=killed` without OOM | A crash: please file a bug with 200 lines of log |

### Scrolling back doesn't work

Full-screen programs (vim, less, htop) use the alternate screen, which has no scrollback anywhere. webterm keeps known AI CLIs on the main screen so their output scrolls (AC-7.8). To check: `env | grep CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` in the session, and `__webterm.altScreen()` in the browser console (`false` = main screen). After a reload, up to 2000 lines come back from the snapshot. To turn the compatibility off: `--no-altscreen-compat`.

### Tab name doesn't follow claude's title

Session names prefer the title set by the foreground program ([ADR-0043](../20-architecture/adr/0043-terminal-title-as-auto-name.md)). Inside tmux, forward pane titles:

```
set -g set-titles on
set -g set-titles-string '#T'
```

Titles set by the shell at the prompt are ignored on purpose; at the prompt the name is the directory.

### Stuck after scrolling inside tmux

With `mouse on`, one wheel event over a pane whose program doesn't track the mouse puts tmux in copy-mode, and keys go to copy-mode, not the program. Look for `[12/340]` in the pane's corner. Press `q` or `Esc`. To avoid it: `tmux set -g mouse off`, or `--no-altscreen-compat`.

### Typing does nothing

While it's stuck, run `__webterm.inputStats()` in the browser console. Its `verdict` says where input stops: not reaching the page, not focused on the terminal, stuck in xterm, not sent (check the connection banner), or not acknowledged (switching the tab away and back re-checks the connection). If every stage works, the program itself isn't reading input — often tmux copy-mode (above).

### Programs keep running after closing a session

Closing hangs up every job in the session. Programs started with `nohup` (they ignore the hangup), `setsid` or `systemd-run` (they left the session) keep running on purpose (`ps -eo pid,sid,cmd`). Anything else is a bug.

### `another webterm agent is already running with this data directory`

A second `webterm serve` (say `--dev` on a server that runs the service) would share the service's data directory and control socket. Give it its own: `webterm serve --dev --data-dir /tmp/webterm-dev`.

### "Session limit reached"

Close sessions you don't use, or raise `--max-sessions`.

## Mobile

- **The keyboard hides the input on iPhone:** prefer the home-screen app (PWA) over a browser tab; report the iOS version and model ([layout.md](../40-frontend/layout.md) explains the viewport handling).
- **IME candidates in the wrong place:** for long CJK text, use the text page (a native text field).
- **Can't add to home screen:** requires HTTPS. `http://<LAN IP>` isn't a secure context.

## Output looks wrong

In dev tools → Network → WS, binary frames starting with `01` are raw output, `03` snapshots.

| Symptom | Likely cause |
|---|---|
| Only after switching back, reconnecting, reloading or rotating | The snapshot path; report the program and `webterm version` |
| Wrong without any reconnect | Raw output; compare with a local xterm-compatible terminal of the same size |
| Wrong rows after the on-screen keyboard opens or closes | Row-only resizes don't resend a snapshot; redraws once the program handles SIGWINCH |
| CJK punctuation (。…—) occasionally missing | Split UTF-8 sequences; the frontend must decode with a streaming `TextDecoder` |

## Data

```bash
sqlite3 ~/.local/share/webterm/webterm.db 'SELECT id, name, last_seen_at, revoked_at FROM devices;'
```

All devices revoked: run `webterm pair` on the server.

## Filing a bug

Include:

```bash
webterm version
webterm doctor
journalctl -u webterm -n 200 --no-pager
```

plus the browser console errors, device, OS and browser. For input problems, `__webterm.inputStats()` taken while it's stuck. Logs never contain pairing codes, cookies, input or terminal output.
