# ADR-0065 `webterm uninstall`

Status: Accepted (2026-11-09). Builds on [ADR-0045](0045-install-from-the-binary.md) §1 and [ADR-0034](0034-system-service-oom-priority.md).

## Context

Removing webterm meant copying five commands from [install.md](../../80-ops/install.md#uninstall). They assumed the default prefix, missed an old user service (ADR-0034) and the directory of sent files ([ADR-0051](0051-send-files-to-a-session.md)), and said nothing about what the installer had changed elsewhere: the local firewall, lingering, and claude's and codex's settings.

## Decision

1. **`webterm uninstall` runs the embedded install.sh with `--uninstall`.** The installer already knows every path it wrote (ADR-0045 §1: one place for that logic). `install.sh --uninstall` works too, for example with `curl … | bash -s -- --uninstall` when the binary is gone; it never downloads anything.
2. **What goes:**
   - the system service, only if its unit runs `<prefix>/webterm` as this user, and an old user service;
   - the binary at the prefix in `install-state` (its capability goes with the file);
   - `~/.config/webterm`: the config, `install-state`, `commands.json`;
   - the data directory: devices, certificates, the ACME account (`$XDG_DATA_HOME/webterm` or `~/.local/share/webterm`, and the config's `data-dir` if it holds `webterm.db`);
   - `<temp>/webterm-<uid>`: files sent to sessions.
3. **One question.** It lists what it will remove, says every session closes, and asks `[y/N]`. `--yes` skips the question; without a terminal and without `--yes` it removes nothing. `--dry-run` prints the plan. `--keep-data` keeps the config and data directories, so a later install has the same settings, paired devices and certificate.
4. **Left alone, with the command to undo each:** the ufw or firewalld rules for the two ports (something else may use them), lingering for the user, and the notification settings `webterm setup` added to claude and codex.
5. **It can run inside webterm.** Over SSH, the service is stopped first and then the files are removed. Inside a webterm session, stopping the service ends that session and the script with it, so the order is reversed: disable the service and remove its unit (it keeps running), remove the binary and the files, print what was left alone, and stop the service last. It says that the session will close before that step.
6. **Not as root**: the paths are the user's, and the installer refuses root too.

## Consequences

- One command removes everything webterm put on the machine except what other software may rely on, and says what that is.
- `--keep-data` is a reinstall path: devices stay paired and the certificate is reused, so Let's Encrypt isn't asked again.
- install.md's Uninstall section becomes `webterm uninstall`, with the manual steps kept for a machine without the binary.
- Tests: UT-uninstall (a real run in a sandbox with fake `sudo` and `systemctl`: what is removed, `--keep-data`, a unit of another prefix left alone, the order inside and outside a session, no terminal without `--yes`, `--dry-run` changes nothing).
