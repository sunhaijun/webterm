# ADR-0047 Edge cases from the full review

Status: Accepted (2026-11-03). Amends [ADR-0016](0016-hot-reexec.md), [ADR-0020](0020-input-never-silently-dropped.md) and [ADR-0045](0045-install-from-the-binary.md).

## Context

A review of the whole implementation found the main paths sound. The defects were at the edges: a hot upgrade that changes the address, a page that reconnects while its old socket is still alive on the server, two agents sharing a data directory, a session closed during a handoff. Each one loses input or sessions, or reports success when the opposite happened. This ADR fixes the rules. Where it replaces an earlier one, that is said in place.

## Decision

### 1. A hot upgrade follows the installed command line

- `webterm reload -- serve <flags>` gives the new process its command line. Without it, the agent re-execs with its own. `install.sh` passes the unit's `ExecStart` arguments, so `webterm install --domain new` takes effect without a restart.
- The control socket reports `args` and `exec_args`. An agent that predates `exec_args` is first upgraded with its old command line. The new binary it then runs takes the new command line in a second hot upgrade, and sessions are kept both times.
- The preflight passes that command line to `handoff-check`. There it is parsed together with the config file, exactly as `serve` would parse it. A flag or config key the new binary rejects aborts the upgrade, instead of crash-looping after exec. Older agents pass no arguments, and nothing extra is checked.
- `reload` treats a changed `instance_id` as a restart: the new binary died and systemd started a fresh one. It reports that sessions were lost, never "sessions are intact".
- A new request clears the previous failure (`last_error`). Otherwise the old failure would be reported as the new attempt's.
- An inherited listener is reused only if its address matches the configuration. Inherited fds that nothing adopts are closed, so they don't leak into shells. Exporting listeners reads the fd number without `File.Fd()`, which would switch the serving socket to blocking mode.
- `install.sh`:
  - A failed hot-upgrade probe stops the install with `--force-restart` as the explicit way out. It used to restart silently.
  - `--if-newer` also compares the running agent's version.
  - `--when-idle` before a restart shows its wait, and refuses to restart when the wait runs out.
  - A restart counts as done once the agent answers on its control socket, not when `is-active` says so (a simple service is active the moment it forks).
  - `--no-setcap` is remembered only for installs without a service.
- The domain is lowercased and its trailing dot dropped, in both `install.sh` and `--domain`. Browsers send the `Origin` host in lowercase.

### 2. A page has one connection, and that connection owns the page's input

- The page holds one socket at a time. `retryNow` abandons a socket that is still connecting, and giving up on a socket (pong timeout, protocol error) detaches it at once instead of waiting for `onclose`. On a dead link, `onclose` can take a minute. This amends ADR-0020.
- A new connection takes over its `client_id` at `hello`. The agent closes the page's older connections and drops the page's queued-but-unwritten input in every session; the page resends that input. When an abandoned connection finally ends, it no longer discards input the new connection queued.
- After `welcome`, pending input for running sessions that aren't in `resume` is resent as is. It starts at or before what the agent accepted, and the agent drops the duplicate prefix (protocol §3). Before, it waited until the user switched back.
- Frames enqueued before `welcome` (the catch-up `hello` asked for) don't count against the 4 MiB write-queue limit. The limit applies to everything after. Counting the catch-up closed the connection before `welcome`, again on every reconnect.
- The client's pending cap is 256 KiB, the size of the agent's input queue (was 64 KiB). Refused input is reported. The text page keeps its draft and sends no Enter after a refused paste.

### 3. The agent's own surface

- A live control socket belongs to the running agent. A second agent with the same data directory refuses to start ("needs its own `--data-dir`"). An agent removes the socket file on exit only if it is still the one it created.
- HTTP keep-alive connections are closed after 2 minutes idle.
- State-changing `/api` requests pass the same `Origin` check as the WebSocket upgrade, as a second line behind `SameSite=Strict`.
- Pairing attempts in flight count against the global budget (50 failures an hour), so a parallel burst can't overshoot it.
- `serve` prints a pairing code only when stdout is a terminal. Under systemd stdout is the journal, which conflicts with AC-8.5; the agent logs a hint to run `webterm pair` instead.

### 4. Session changes during a hot upgrade

- `Freeze` holds the sessions until `Thaw` or exec. Close, rename and move wait meanwhile; made after `Export`, they would be lost with the old process. If the upgrade goes ahead, the request dies with its connection, and the next `welcome` shows the true state.
- A session closed while frozen thaws its own loops, which `Thaw` would no longer reach.
- Input is counted and enqueued in one step under the session lock, so an export never carries a count without the bytes.
- Size changes are serialized end to end: the emulator update and `TIOCSWINSZ` happen in the same order for concurrent resizes.

### 5. Closing a session spares `nohup`

The sweep after `SIGHUP` skips processes that ignore `SIGHUP`. That is what `nohup` does; it stays in the session and only sets `SIG_IGN`. A process that catches `SIGHUP` and keeps running is still killed. Before, the docs promised that `nohup` processes survive, but the sweep killed them.

## Consequences

- Changing the address or ports with `webterm install` keeps sessions.
- Running `webterm serve --dev` next to the service now needs `--data-dir`.
- More than 64 KiB of input can be in flight. The agent's input queue was always 256 KiB, so nothing new can stall.
- Close, rename and move can be delayed by a hot upgrade, which takes well under a second.
