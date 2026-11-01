# systemd

The installer sets this up for you. This page is for hand-written units and for understanding what it did.

webterm runs as a **system service under your own user** ([ADR-0034](../20-architecture/adr/0034-system-service-oom-priority.md)): root is only needed to install. A system service rather than a user service because of OOM priority — a user service can't go below `oom_score_adj` 100, so under memory pressure the agent, and every session with it, would die before your SSH login.

## The unit

`/etc/systemd/system/webterm.service` (template: [`deploy/webterm.service`](../../deploy/webterm.service)). Replace `alice` and `1000` with your user name and `id -u`. The UID must be literal: `%U` in a system unit is PID 1's UID (0).

```ini
[Unit]
Description=webterm — browser terminal agent
After=network-online.target user@1000.service
Wants=network-online.target user@1000.service

[Service]
Type=simple
User=alice
Group=alice
ExecStart=/usr/local/bin/webterm serve --domain term.example.com
Restart=on-failure
RestartSec=3
# systemctl --user, journalctl --user and D-Bus tools inside sessions
Environment=XDG_RUNTIME_DIR=/run/user/1000
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
# The agent is the OOM killer's last choice; sessions run at 0
OOMScoreAdjust=-900
OOMPolicy=continue
# Hot upgrade (ADR-0016)
ExecReload=/bin/kill -USR2 $MAINPID
KillSignal=SIGTERM
TimeoutStopSec=15
KillMode=mixed
SyslogIdentifier=webterm

[Install]
WantedBy=multi-user.target
```

```bash
sudo install -m755 webterm /usr/local/bin/webterm
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/webterm   # again after every binary replacement
sudo systemctl daemon-reload
sudo systemctl enable --now webterm
sudo loginctl enable-linger $USER
```

Lingering isn't needed for the service itself, but it keeps your user manager running after you log out, so `systemctl --user` and the session bus keep working inside webterm.

`ProtectHome`, `ProtectSystem`, `NoNewPrivileges` and `PrivateTmp` are deliberately off: they would confine the shells you open, and `NoNewPrivileges` breaks `sudo`. Running as a regular user is the hardening that counts ([threat model](../60-security/threat-model.md)).

## OOM priority

| | `oom_score_adj` |
|---|---|
| agent | -900 |
| session shells and everything they start | 0, like an SSH login |
| a user service (old installs) | 200 |

`OOMPolicy=continue` keeps the unit running when one process in a session is OOM-killed. Check:

```bash
cat /proc/$(systemctl show webterm -p MainPID --value)/oom_score_adj   # -900
cat /proc/self/oom_score_adj                                          # 0, inside a session
```

## Logs

```bash
journalctl -u webterm -f            # the agent's own log, no sudo needed
sudo journalctl -u webterm          # plus systemd's records: starts, stops, OOM kills
```

Logs never contain pairing codes, cookies, input or terminal output.

## Upgrades

`webterm update`, or rerun the installer. By hand:

```bash
sudo install -m755 webterm-new /usr/local/bin/webterm
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/webterm
webterm reload                      # or: sudo systemctl reload webterm
```

`reload` re-execs the new binary in place and keeps sessions. If its preflight fails, the old version keeps running; `sudo systemctl restart webterm` restarts and closes all sessions.

## Migrating from a user service

Installs from before ADR-0034 run a user service (`~/.config/systemd/user/webterm.service`). `webterm update` hot-upgrades it and suggests migrating. To migrate:

```bash
webterm update --force-restart      # over SSH, not inside webterm
```

It removes the user unit and installs the system unit, closing all sessions once (handoff can't cross systemd managers). The installer refuses to run it from inside a webterm session, which would be killed halfway.

## Without sudo

No system service and no low ports. Run behind a reverse proxy with a user service and accept the weaker OOM priority:

```ini
# ~/.config/systemd/user/webterm.service
[Service]
ExecStart=%h/.local/bin/webterm serve --domain term.example.com --bind 127.0.0.1 --no-tls --http-port 8080 --trust-proxy
Restart=on-failure
OOMScoreAdjust=100
OOMPolicy=continue
ExecReload=/bin/kill -USR2 $MAINPID
KillMode=mixed

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now webterm
```

Without lingering (an admin must enable it) the service stops when you log out.

## Reverse proxy or tunnel

```ini
ExecStart=/usr/local/bin/webterm serve --domain term.example.com --bind 127.0.0.1 --no-tls --http-port 8080 --trust-proxy
```

No `setcap` needed. Proxy requirements: [install.md](install.md#reverse-proxy-or-tunnel).
