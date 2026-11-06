# ADR-0050 Attach to a session over SSH

Status: Accepted (2026-11-05). Adds a local endpoint to the [protocol](../../30-protocol/websocket-protocol.md#local-attach-endpoint) and sets who decides a session's size (§5). [ADR-0001](0001-agent-first-no-ssh.md) still holds: SSH stays out of the browser's path.

## Context

Sessions live in the agent, which holds their PTYs ([ADR-0003](0003-no-tmux.md)). At a laptop with a real terminal, the user wants to get into a running session (the claude the phone was driving a minute ago) with plain `ssh`. Today the only way is to run tmux inside the session and `tmux attach` over SSH, which brings back the model ADR-0003 dropped.

sshd on port 22 can't reach the agent's PTYs. Something on the server has to connect sshd's PTY to the agent.

A second kind of client also exposes a gap in the size rules. A session has one size. The last `subscribe` or `resize` sets it, and a browser sends `resize` only when its own container changes. So with two clients of different sizes, typing in one doesn't bring the session back to its size: the client you are using keeps drawing the other one's layout.

## Decision

### 1. `webterm attach`, run through sshd

```bash
ssh -t host webterm attach            # one session: attach; several: pick from a list
ssh -t host webterm attach claude     # by name
ssh -t host webterm attach 2          # by position, the [n] on the tab bar
ssh -t host webterm attach --new      # a new session, which the browser shows too
ssh host webterm attach --list        # print the list and exit; needs no terminal
```

sshd does the authentication and carries the bytes. webterm opens no port and adds no credential.

### 2. A local socket that speaks the existing protocol

- **`<data-dir>/run/attach.sock`**, mode `0600`, inside the `0700` run directory. Each agent process creates its own on start and removes it on exit, like the control socket ([ADR-0016](0016-hot-reexec.md)); after a hot upgrade the new process creates it again.
- **Same protocol, same code.** The socket serves `GET /ws`, which upgrades to the WebSocket protocol, version 2, unchanged. The agent runs these connections through the same connection layer as the browser's: `hello`/`welcome`, `subscribe`, input accounting, bounded queues, heartbeat. They count toward `--max-conns`, get the shutdown notice, and close on `SIGTERM` like every other connection.
- **Authentication is the kernel's.** File permissions and the peer's uid (`SO_PEERCRED`), which must equal the agent's. There is no cookie and no `Origin` check, because no browser is involved. This is the rule the control socket already follows: whoever can open the socket is already this user on this machine, and could read the agent's memory anyway. Invariant 5 governs network routes; the local sockets are authenticated by the kernel ([threat model](../../60-security/threat-model.md)).

A protocol of its own would have been a second contract to keep in step. The attach client needs exactly what a browser needs: choose a session, get a snapshot, follow output, send input with resend, and resize.

### 3. The attach client

- **Needs a terminal** on stdin and stdout (`ssh -t`). Without one it exits with a message, except for `--list`.
- **Raw mode** while attached; the original terminal settings are restored on exit.
- **Always a snapshot, never incremental.** The client subscribes with `out_seq: 0`, and reconnects with `resume: [{sid, out_seq: 0}]`. Incremental catch-up would replay old terminal queries (DA, DSR, …) into the local terminal, and its answers would arrive on stdin. A browser can tell those answers from keystrokes ([ADR-0020](0020-input-never-silently-dropped.md)); a process reading a tty can't. A snapshot contains no queries.
- **Before every snapshot**, the client writes RIS (`ESC c`) and `CSI 3 J` (clear scrollback), then the snapshot. Afterwards the local scrollback holds the session's history (up to 2000 lines), and a later snapshot (column change, reconnect) replaces it instead of adding a second copy. So attaching clears whatever the local terminal had in its scrollback.
- **Output goes to stdout unchanged.** A native terminal decodes UTF-8 that is split across writes; the browser's streaming-decoder workaround (protocol §5.2) isn't needed.
- **The window title is saved and restored**: `CSI 22;0 t` on start, `CSI 23;0 t` on exit, so a session's title (claude's `✳ …`) doesn't stay on the window after detaching.
- **Exit reset.** Before exiting, the client turns off the modes a program may have left on: alternate screen, mouse tracking and its encodings, focus events, bracketed paste, application cursor keys and keypad, kitty keyboard flags, modifyOtherKeys, synchronized output, the scroll region, origin mode, hidden cursor, SGR attributes, and the G0 character set. Then it moves the cursor to the bottom row and writes a newline. The screen's content stays where it is.
- **Detaching** means closing ssh, or ssh's own escape (`Enter ~ .`). There is no detach key: every key belongs to the program in the session, and the session keeps running in the agent anyway. `SIGHUP` and `SIGTERM` end the client.
- **Reconnects.** If the socket connection drops (a hot upgrade, a full write queue), the client reconnects with the same `client_id` every 250 ms for up to 30 seconds and resends unacknowledged input (protocol §5.4). A session reported `gone` (agent restarted, or the session was closed elsewhere) ends the client with one line saying so.
- **When the session's shell exits** while attached, the client writes the same line the browser does, `[Exited (code N) · Enter to close]`. `Enter` closes the session and exits. Any other key exits and leaves the session `exited`, still visible in the browser.
- **Attaching to the session you are in is refused.** Inside a webterm session (`WEBTERM_SESSION` is set), attaching to that same session would feed its output back into itself.

### 4. Choosing a session

Sessions are listed in display order (`welcome.sessions[]`, [ADR-0040](0040-session-order-drag.md)) and numbered from 1, like the tab bar's `[n]`.

| Argument | Result |
|---|---|
| none | No sessions → create one. One → attach. Several → the list and a prompt `[1-N, n = new]` |
| a number | The session at that position |
| anything else | An exact name match first; otherwise a case-insensitive substring match, so `claude` finds `✳ Claude Code`. One match → attach; several → the list narrowed to them; none → an error followed by the full list |
| `--new` | Create a session (`cwd` = home) and attach |

A list line is `N  name  cwd` (cwd shortened to `~` like the browser, protocol §4.2), followed by `exited` for exited sessions. The session the command runs in is marked `(this session)` and can't be picked.

### 5. The size follows the client in use

Every client draws at its own size. A client smaller than the session wraps lines, and full-screen programs draw garbage on it. A client larger than the session just has unused space. So the session should take the size of the client the user is actually using.

The agent's rule stays as it is: the latest `subscribe` with a size, or `resize`, sets the size. What changes is **when clients send them**:

- **A client claims the size** by sending `resize` (or `subscribe` with a size), and only when there are signs it is in use: it opens or switches to the session, **the user types** into it (automatic terminal replies don't count), it gains focus or becomes visible, or its own size changes while it has focus. After a reconnect it claims only if it has focus.
- **The agent tells every connection the session's size**: whenever it changes, `session.updated{cols, rows}` goes to every connection. A client that already holds the size skips the claim.
- **The attach client can't see focus.** It claims on attach, on `SIGWINCH`, and on input that isn't a terminal report. Reports are cursor position (CPR), device attributes (DA), mode reports (DECRPM), focus in/out, kitty keyboard flags, window reports, and OSC/DCS replies. Its reconnects don't claim.

Claims come only from user actions, so two clients never fight. Both terminals answer the same live queries, but answers never claim. Switching between two clients of different widths costs a snapshot to every subscriber, the same as a resize does today.

Not done: rendering a client that isn't in use at the session's size, clipped or scaled. That client shows wrapped output until the user touches it; then it claims and redraws.

## Alternatives considered

- **An SSH server inside the agent** (`golang.org/x/crypto/ssh`, `ssh -p 2222 claude@host`, with the user name picking the session). It looks the most direct, but port 22 belongs to sshd, so it means another port to open. It also needs a second authentication system (host keys, authorized keys) and adds attack surface ([T1](../../60-security/threat-model.md#t1-unauthorized-access-highest-risk)). sshd already does all of this well.
- **tmux inside the session.** It works today with no changes, but brings back tmux's session model and its own size and copy-mode problems (ADR-0003).
- **A detach key** (tmux's prefix-d, dtach's `Ctrl+\`). It takes a key away from the program, and closing ssh already detaches.
- **Incremental resume for attach.** It would replay old queries into the local terminal, whose answers would become keystrokes (§3).
- **The agent picks the size owner from INPUT frames.** Both terminals answer live queries, so automatic replies would bounce the size between clients. Only the client knows which input is the user's (ADR-0020). Marking user input with a frame flag would change the binary frame for something `resize` already expresses.
- **The agent tracks every subscriber's size and falls back to the previous owner when one leaves.** That needs per-subscriber state in the agent. Claiming on use covers the same cases from the client side.

## Consequences

- `ssh -t host webterm attach` reaches any session from any terminal, with the same sessions, names and order as the browser.
- No new port, no new credential, no protocol version bump. `session.updated` gains `cols`/`rows` updates, an addition protocol §8 allows.
- Attaching replaces the local terminal's scrollback with the session's history.
- SSH has no resume. A dropped ssh link ends the client; running it again redraws from a snapshot. On a flaky network the browser remains the better path.
- When two clients of different sizes share a session, the one in use is right and the other wraps until it is used.
- Tests: IT-attach-1..7 drive the real client through a PTY against a real agent; IT-size-1 covers the broadcast; UT-attach-pick and UT-attach-report cover choosing and classifying; UT-claim-1 covers the browser's claim rules; E2E-47 covers a browser and an attach client sharing one session.
