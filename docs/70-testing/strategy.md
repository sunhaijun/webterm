# Test strategy

> Status: Accepted

## Principles

**Testability is an architectural property.** The deciding reason [ADR-0002](../20-architecture/adr/0002-self-contained-binary.md) rejected the Cloudflare approach was that it made end-to-end testing impossible. So:

- The whole system starts in CI with one command (single binary + `--dev`).
- Tests of the core feature (resume after disconnect) can **control exactly when the connection drops**.
- `Session` knows nothing about WebSockets and can be unit-tested without a network.

## Layers

| Layer | Tool | Covers | Target runtime |
|---|---|---|---|
| Go unit | `go test` | Ring buffer, terminal emulator wrapper (`internal/vterm`), protocol encoding, storage, auth logic | < 10s |
| Go integration | `go test -tags=integration` | Real PTY, real SQLite, real HTTP, real WebSocket (in-process) | < 60s |
| Frontend unit | Vitest | seq accounting, resend queue, snapshot frame assembly, replay gate, keymap and extra keys, text page, backoff; screen-level consistency of snapshots (`@xterm/headless` as the judge) | < 30s |
| E2E | Playwright | Real binary + real browser, full user flows | < 5min |

## Two standards ([ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §10)

Output takes one of two paths, and each has its own standard:

| Path | Standard | Tests |
|---|---|---|
| **Incremental** (short disconnect, short time away) | **Byte-level**: the serialized terminal after a disconnect and reconnect is byte-identical to one that never disconnected | The next section, E2E-2 |
| **Snapshot** (first open, refresh, fell out of the window, column change) | **Screen-level**: xterm fed the snapshot and then the later bytes matches, cell by cell, xterm fed all the bytes (characters, widths, colors, attributes, cursor, modes; except soft-wrap flags and the three known differences listed in ADR-0026) | "Screen-level consistency" below, E2E-30 / 31 / 36 |

## Key test: byte-level continuity (AC-2.1) ★

The single most important test in the project. It verifies the core "never disconnects" promise.

### How

```
1. Start the agent (--dev), pair, open a WebSocket
2. Create a session and run a deterministic output script
   (fixed content, fixed order, with ANSI colors, CJK, long lines; ~2 MB total)
3. Serialize the xterm buffer at the end (@xterm/addon-serialize) → baseline
4. Run the same script again, but force-drop the WebSocket at 30% and again at 60% of the output
5. Wait for the reconnect and for the output to finish
6. Serialize → compare BYTE FOR BYTE with the baseline
```

### Why it works

It doesn't test "can it reconnect" (too weak); it tests **whether the final screen state is identical to never having disconnected**. Any seq accounting error, slice offset, duplicate replay, or dropped frame makes the two results differ.

### Variants

| Variant | How it disconnects | Verifies |
|---|---|---|
| E2E-2a | Playwright route interception cuts the WS | Basic resume |
| E2E-2b | Disconnected for 5 seconds (buffer doesn't overflow) | Incremental replay is correct |
| E2E-2c | Output during the disconnect > `ring_bytes` | Snapshot path: **screen-level** match (not byte-level), later output correct |
| E2E-2d | 10 quick disconnects in a row | No accumulated drift |
| E2E-3 | Typing in the terminal while disconnected | Input not lost, not duplicated, in order |

E2E-2c is the only variant that doesn't require a byte-level match: a snapshot is a picture the agent redraws, not the original bytes. It requires the **picture** to match, and later output to continue correctly.

## Key test: screen-level consistency (AC-2.21) ★

The gatekeeper for the snapshot path. It reuses the method of the [offline experiment](../20-architecture/adr/0026-agent-holds-terminal-state.md#offline-experiment-2026-10-30) behind ADR-0026:

```
1. Record fixtures: run real programs in a pseudo-terminal (claude in both render modes, codex, vim, tmux,
   less, top, python, long logs, colored CJK output) and record the raw output bytes as
   internal/vterm/testdata/rec/*.bin
2. Go test: for each recording, pick a set of cut points (evenly spaced + random; the random ones land
   inside escape sequences and multibyte characters), build a snapshot with internal/vterm at each cut
   point, and write it to a snapshot file under testdata
3. Vitest: @xterm/headless (unicode11) as the judge
     reference = feed all the raw bytes
     candidate = a fresh terminal fed the snapshot at the cut point, then the raw bytes after it
   compare cell by cell; every write goes through a streaming TextDecoder first (xterm drops characters
   from split UTF-8 when written a Uint8Array)
```

Only what's visible is compared: the foreground color of blank cells is normalized, and soft-wrap flags on the alternate screen aren't compared. The three known differences listed in ADR-0026 (top's reversed last cell, SGR 53, how the cursor x is recorded with autowrap off) are an allowlist in the test; any new difference requires changing the ADR first.

## Go unit tests

### `internal/ringbuf` (see [`../50-backend/ring-buffer.md`](../50-backend/ring-buffer.md#required-tests))

`UT-ring-1, 2, 5–10`. `UT-ring-8` (fuzzing random Append/Slice sequences against the invariants) is the most valuable test in this module: ring buffer bugs live almost entirely at the edges.

### `internal/vterm`

- The same bytes fed in any chunking produce byte-identical snapshots (chunking-independent)
- `export state → import` produces byte-identical snapshots before and after (for hot upgrade)
- After a column change, snapshot rows are as wide as the new column count; a row-only change leaves history rows alone
- The emulator's query replies are dropped and never written to the PTY

### `internal/protocol`

- Binary frame encode/decode round trips (including edges: `seq = 0`, `seq = MaxUint64`, `sid = 0`, a 1-byte `payload`)
- Invalid frame detection (too short, empty payload, oversized payload)
- Control message JSON round trips
- **Test vectors**: run `testdata/vectors.json`, the same fixture the frontend uses (guards against implementation drift, protocol §9)

### `internal/store`

- Migration idempotence: running migrations twice gives the same result; `0003` drops the `commands` table from old databases
- Device and pairing queries
- Permissions: the file is `0600` after creation

### `internal/auth`

- `UT-pair-1..4`: single use, expiry, entropy, constant-time comparison
- `UT-auth-1`: the database stores the hash, not the raw token

### `internal/session`: OOM priority when starting a shell ([ADR-0034](../20-architecture/adr/0034-system-service-oom-priority.md) §3)

- `UT-oom-1`: inject the `oom_score_adj` reads and writes. With self < 0 the order is "write 0 → start shell → write self back", and the shell sees 0 when it starts; with self ≥ 0 nothing is written; a failed write of 0 still starts the shell; a failed write-back only logs, without returning an error

### `scripts/install.sh`

- `UT-install-unit`: the system unit printed by `install.sh --print-unit` has `User=` / `Group=` (the current user), `OOMScoreAdjust=-900`, `OOMPolicy=continue`, a **literal UID** (not `%U`) in `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS`, `Wants=` / `After=user@<uid>.service`, and an `ExecStart` with the port flags; no network, no sudo
- `UT-install-embed`: the script embedded in the binary is exactly `scripts/install.sh` (byte-identical); `webterm install --help` runs it (prints install.sh's usage)
- `UT-install-handover`: with `--base-url file://…` pointing at a fake binary + `SHA256SUMS`, install.sh downloads and verifies it, then runs `<fake binary> install <original args>`; when the fake binary doesn't know `install`, the script aborts with "version too old" and installs nothing. No network, no sudo
- `UT-install-default-addr`: without `--domain`, an existing `install-state` is reused (command-line flags override matching keys); otherwise the public IP is used (injected via `WEBTERM_PUBLIC_IP`, no network); checked through `ExecStart` in `--print-unit`
- `UT-install-config-sync`: with an existing config file, reinstalling rewrites `domain` / the ports, deletes the port line when the port goes back to its default, and leaves other keys untouched

### `internal/agent`: IP certificates ([ADR-0044](../20-architecture/adr/0044-ip-address-certificates.md))

- `UT-ipcert-1`: renewal time = `NotAfter - lifetime/3`; retry an hour after a failure
- `UT-ipcert-2`: IPv6 literals and non-IP addresses don't enter IP mode / are rejected; `IsIPAddress` classification
- `UT-ipcert-3`: no `shortlived` in the CA directory → the error says plainly that this CA doesn't issue IP certificates
- `UT-config-removed-key`: `acme-staging` in the config file is reported as removed, with its line number, rather than a generic "unknown option"
- `UT-status-cert`: expiry warning threshold `min(10 days, lifetime/4)` — a 90-day certificate with 11 days left isn't flagged, with 9 days left it is; a freshly issued 160-hour certificate isn't flagged, with 30 hours left it is
- `UT-doctor-ip`: IP mode skips the DNS check; when the public IP differs from `--domain`, the output explains NAT / IP change
- `UT-pair-wait`: `--wait` prints no pairing code before the probe succeeds; on timeout it points to the logs and prints the code anyway
- `UT-doctor-guide-1..4` (ADR-0046): an unreachable CA leads to firewall instructions, a wait for Enter, staging probes in a temp directory, then one production request into `certs/`; EOF on the terminal gives up with the diagnosis; `--guide` without a terminal never prompts; a missing `A` record shows the record and polls until it resolves
- `UT-issue-unreachable`: `IssueCheck` flags a challenge that can't get in as unreachable, and a CA without IP support as not

## Go integration tests

Real PTY + real SQLite + in-process HTTP server.

| ID | Covers |
|---|---|
| `IT-session-1..6` | Session independence, limits, auto naming (CWD from `/proc`), buffer and emulator kept after exit, close kills the process group, terminal title as auto name (owned by the foreground process group, ADR-0043) |
| `IT-resume-1..4` | Sessions keep running while disconnected, incremental replay doesn't resend, input resend neither loses nor duplicates (`in_ack` survives reconnects), mismatched `instance_id` → `gone` |
| `IT-snapshot-1..3` | Falling out of the window / `out_seq == 0` takes the snapshot path and later OUTPUT continues from the snapshot's `seq`; a column change resends a snapshot to every subscriber, a row-only change doesn't; a snapshot over the frame size limit is split with `MORE` |
| `IT-auth-1..4` | Route auth matrix (**including `/ws`**), Origin check, cookie attributes, revocation takes effect immediately |
| `IT-pair-1..3` | QR code output, pairing codes never in logs, rate limiting |
| `IT-tls-1..3` | Against a local fake ACME CA (`internal/acmetest`): a certificate really is issued and completes a handshake; `--dev` never contacts the CA; a challenge that can't get in gives a readable diagnosis (AC-1.13). See [Why not pebble](#why-not-pebble) below |
| `IT-tls-4..6` | IP mode (AC-1.16): the fake CA receives an order with an `ip` identifier + the `shortlived` profile, the issued certificate has an IP SAN, and a **handshake without SNI** verifies against the CA root; a restart reads the cache and doesn't contact the CA; a lifetime short enough to trigger renewal gets a new certificate |
| `IT-doctor-acme-1..2` | Issuance core of `doctor --acme`: when the fake CA can validate, a certificate is issued, stored in the given cert directory, and the port is released; **a second run uses the cache and the CA gets no new order**; a challenge that can't get in gives a readable diagnosis. Both domain and IP modes |
| `IT-privacy-1..2` | A canary string never appears in the data directory / logs |
| `IT-embed-1` | With `web/dist` deleted, the binary still serves the frontend (proves it's really embedded) |
| `IT-resize-1` | A `resize` message takes effect via the PTY's `TIOCSWINSZ` (verified with `stty size` in the session) |
| `IT-hb-1` | A connection with no frames for 60 seconds is closed |
| `IT-queue-1` | Session input queue full → `input_stalled`, enqueueing doesn't block, other sessions are unaffected (m1) |
| `IT-queue-2` | Connection write queue full → that connection is closed instead of blocking the Session (m2, needs the connection layer) |
| `IT-sub-1` | Unsubscribed sessions keep buffering and feeding the emulator; `subscribe{out_seq}` catches up incrementally or with a snapshot |
| `IT-handoff-1` | Across a hot upgrade: the incremental path is byte-continuous and a session's snapshot is byte-identical (`TestHandoffByteLevelContinuity`) |
| `IT-order-1` | Session order (AC-4.13): new sessions go last, closed ones are removed; `session.move` moves before `before` / to the end for `null`, an unknown `before` means last, an unknown `sid` returns `unknown_session`; on success `session.order` is broadcast to every connection (`req_id` only to the requester); `welcome.sessions[]` is in order; order survives a hot upgrade |
| `IT-oom-1` | Real `/proc`, real PTY, no root: set the child target to "self + 100" (raising needs no privilege, and writing self back doesn't go below the floor) and start several sessions concurrently; every shell's `oom_score_adj` is the target, and the agent ends up back at self (ADR-0034 §3) |

### Why not pebble

The original plan was [pebble](https://github.com/letsencrypt/pebble). Two problems came up:

1. pebble pulls in a whole new tree of module dependencies (gorilla/mux, miekg/dns…). It's test-only, but it still lands in `go.sum`.
2. **pebble's VA does real DNS resolution** to validate HTTP-01. The test domain would have to resolve to localhost, which means editing `/etc/hosts` or giving pebble a custom DNS server — both depend on the CI environment.

`internal/acmetest` is an in-process RFC 8555 server of about 300 lines: no new dependencies, no network, no DNS (the test supplies the validation target address directly). The three tests together take just over a second.

It **deliberately doesn't verify JWS signatures**; that contributes nothing to what these tests prove.

What they prove is **our wiring**: autocert is configured correctly, the challenge handler on `:80` really is reachable (including `HostPolicy`'s check of the `Host` header), warm-up at startup really obtains a certificate and stores it under 0700, the certificate really completes a TLS handshake, and failures produce a readable diagnosis.

They do **not** prove protocol compatibility with Let's Encrypt — that's `golang.org/x/crypto/acme`'s job, and upstream has its own tests. Real issuance can still only be checked with the [manual checklist](manual-checklist.md).

> These tests caught a real bug the day they landed: autocert tries every challenge type and finally
> returns `no viable challenge type found`, but the diagnosis only matched `Invalid response`, so
> **the most common real failure (a security group blocking the port) never reached it**.
> Manual checks alone would never have covered that.

**Session integration tests need a real shell.** They run a controlled `.bashrc` (by pointing `HOME` at a temp directory) for determinism.

## Frontend unit tests (Vitest)

| ID | Covers |
|---|---|
| `UT-seq-1` | `out_seq` accounting: consecutive frames, gap detection, duplicate detection; after a SNAPSHOT `out_seq` jumps to the snapshot's `seq` |
| `UT-snapshot-1` | SNAPSHOT frames: `MORE` assembly, applied only when complete, applying resets and switches to a fresh UTF-8 decoder |
| `UT-utf8-1` | Output split at arbitrary bytes and written loses no CJK punctuation (。…—“”) (AC-2.23) |
| `UT-touch-1` | Touch vertical drag to wheel: one event per full row height, remainder carried to the next frame, direction, at most 3 per touchmove with the excess dropped, 10px threshold and vertical dominance, converts and calls `preventDefault` only with mouse tracking on (AC-3.21) |
| `UT-input-1..3` | Text page: Enter semantics (with text = paste the text then Enter / empty Enter sends `\r`), nothing sent during composition, textarea attributes |
| `UT-textinput-2` | Text page follows the session: each session keeps its own page and draft, new sessions get the keys page and an empty draft, closed sessions are forgotten; switching sessions swaps drafts, focus lands on the new session's input, blur first when switching mid-composition (AC-3.22 / AC-4.8) |
| `UT-keymap-1` | Control key mapping table (checked against [`../40-frontend/keymap.md`](../40-frontend/keymap.md)) |
| `UT-look-1` | Appearance defaults: xterm font size 14px, font is the system monospace stack; `Ctrl+Shift+,` isn't an app shortcut (AC-5.3) |
| `UT-close-1` | Close confirmation (AC-4.11, ADR-0038): a `running` session enters `closing` without sending `session.close`, an `exited` one sends it directly; confirm sends, cancel doesn't; focus returns to the input before confirming; `closing` clears when the session leaves the list; a closing session sends no input or `resize`, its `unknown_session` shows no toast, and neither does one for a sid the client doesn't have |
| `UT-order-1` | Ordering (AC-4.13, ADR-0040): `moveBefore` moves before an item / to the end, an unknown `before` means last; insertion index from the pointer position (swap only past the midline); the store lists sessions in the agent's order, new sessions go last, `session.order` replaces the whole order (unknown sids hold their slot, and a late-arriving session lands there), `[n]` follows |
| `UT-swipe-1` | Row swipe (AC-4.12, ADR-0039): 10px threshold and horizontal dominance, offset clamped to 0…−216, release past halfway opens otherwise springs back, swipe right closes an open row; swipe-down-to-close only takes over when vertical dominates |
| `UT-prefs-1` | The two preferences (AC-5.3, ADR-0037): theme defaults to system, `light` / `dark` set `data-theme` and `color-scheme`, system removes them; font size defaults to 14, accepts only integers 10–24, falls back to the default otherwise; when `localStorage` throws, defaults are used and nothing throws; changing font size via the controller switches every instance and sends a `resize` (even if the container didn't change), changing theme updates the xterm theme |
| `UT-reconnect-1` | Exponential backoff sequence, jitter range, immediate retry on the `online` event |
| `UT-hb-1` | Heartbeat interval, pong timeout declares the connection dead |
| `UT-hb-2` | Immediate liveness probe while believing it's online: `online` / page becomes visible → send `ping`; no `pong` within 2 seconds → close the connection; a `pong` keeps it open (AC-2.20) |
| `UT-replay-2` | Replay gate: `onData` during the dispatch of a user input event passes; `onData` from `message` / timers during replay (incremental catch-up, snapshot) is dropped (AC-2.15) |
| `UT-raw-2` | Fallback composition reset: `blur` and a `keydown` with `isComposing === false` both set `composing` back to false (AC-3.3) |
| `UT-resize-1` | resize debounce |
| `UT-fit-1` | Rows/cols = available size ÷ stable cell size, rounded down, minimum 2 columns × 1 row; measured numbers at 900px wide (cell width 8.4287px, 877px available) give 104 columns regardless of the current column count (AC-3.11) |
| `UT-name-1` | Session auto naming rules (home → `~`, `/` → `/`, manual name wins) |
| `UT-name-2` | Terminal title cleanup (control characters, surrounding whitespace, 64 characters); the emulator reports the title and the write count (writing the same title again still counts) |
| Protocol vectors | Run `internal/protocol/testdata/vectors.json` (the same file as the Go side) |

## E2E

Scenario details are in [`e2e-scenarios.md`](e2e-scenarios.md).

## CI

Two workflows (`.github/workflows/`):

```yaml
ci.yml   # PULL REQUESTS ONLY, one job:
  check:   gofmt · doc links · go vet · frontend typecheck and unit tests
           · npm run build · go test ./... -race · single-binary assertions (AC-8.1/8.2)

e2e.yml  # NOT run automatically in CI: manual trigger only, see below
```

### Why one job, and why only on pull requests

**Actions bills each job rounded up to the minute.** Five separate jobs (`go` / `web` / `static` / `fmt` / `docs`) measured 3.6 / 0.7 / 1.9 / 0.3 / 0.1 minutes, so rounding alone wasted two minutes, and `go` and `static` each ran `npm ci && npm run build`. One job builds once and reuses the result.

Three savings, none of which reduce coverage:

1. **Five jobs merged into one** (no rounding waste, no duplicate builds). Cheap checks run first: the earlier gofmt / broken links / typecheck fail, the fewer minutes a run burns.
2. **Only the `-race` run of `go test`.** Running once plain and once with `-race` ran the whole suite twice; `-race` already runs every test. This project is goroutine-heavy (`session` / `wsconn` / `ringbuf`), so the duplicate run is what goes, not race detection.
3. **No rerun after merging to main.** The `pull_request` event already runs the **merge ref** (main with the PR merged), so a run on main would test the same tree a second time. `Release` still runs on main (dev prereleases are unaffected) and does its own full build and embed assertions.

Two more guards against waste: `concurrency` cancels superseded runs on the same branch immediately (several quick pushes don't burn in parallel), and `timeout-minutes` caps the job — the Actions default is **360 minutes**, and one stuck job can burn a month's quota.

The cost: **main has no CI result of its own**. This relies on the [CLAUDE.md](../../CLAUDE.md) rule of never developing directly on `main`: every change goes through a PR, and the PR run tests the merged tree.

**E2E doesn't run in CI; it runs locally.** One run takes about 6 minutes (install browsers + build + 90 cases), and Actions minutes are limited. The automatic triggers (merge to main, PR label) were removed; `e2e.yml` keeps only `workflow_dispatch`. When you want a CI result, run `gh workflow run E2E --ref <branch>` by hand; otherwise it costs nothing.

So **a green local `make e2e` is a hard gate for every PR** ([CLAUDE.md](../../CLAUDE.md)), with no CI safety net:

- If E2E won't run locally (missing libraries, no browser), **don't open the PR**; fix the environment first — see [development.md §E2E setup](../80-ops/development.md#e2e-setup)
- E2E requires a full build first (`npm run build` → `go build`), which proves the `go:embed` paths really work; the local run takes exactly that path
- What we give up is the net for "differences that only show up in the CI environment". It caught two in the past: the Go job didn't build the frontend → `go:embed` of an empty directory → `GET /` returned 503; and focus still on body right after a sheet opened → Esc couldn't close it ([ADR-0018](../20-architecture/adr/0018-one-drawer-primitive.md)). **This is an informed trade-off**: from now on such differences are caught only by a manual run, which is worth doing before merging when a change touches the protocol / reconnect / input / layout, or changes the E2E suite or the build itself
- `ci.yml` coverage is unchanged: `go vet` / `go test -race` / frontend typecheck and unit tests / single-binary assertions / gofmt / doc links run on every push to every PR (not again after merging to main, for the reasons above)

## Coverage

No hard coverage threshold (it encourages meaningless tests). But these modules **must have near-complete branch coverage**, checked by hand in review:

- `internal/ringbuf`
- `internal/vterm` (snapshots and state export)
- `internal/protocol`
- `web/src/conn` (seq accounting, snapshot frames, resend queue)

Together these four are the entire implementation of resume. If they're wrong, the product's core promise is false.

## Manual tests

Some things can't be automated: real IMEs, real on-screen keyboards, real network switches, real certificate issuance.
The full list is in [`manual-checklist.md`](manual-checklist.md); **run it before every release**.
