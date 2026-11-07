# E2E scenarios

> Status: Accepted
>
> Playwright. Each scenario lists the acceptance criteria it verifies. **Changes that touch the protocol, reconnects, input, or layout must update this list** ([CLAUDE.md](../../CLAUDE.md)).

## Fixtures

### Startup

```
1. go build the real binary (with the frontend embedded via go:embed)
2. webterm serve --dev --data-dir <temp dir> --max-sessions 5
   default ring-bytes (256 KiB): output during a disconnect window never overflows, so byte-level
   comparison on the incremental path is stable
   only E2E-2c / E2E-4 / E2E-30 / E2E-31 start a separate instance with --ring-bytes 65536, so the
   snapshot path can be tested
3. grab the pairing URL from stdout
4. Playwright opens the URL and completes pairing
```

### Deterministic output script

`e2e/fixtures/emit.sh` produces fixed output for byte-level comparison:

```bash
#!/bin/bash
# Usage: emit.sh <total lines> [per-line delay ms] [mono]
# Contains ANSI colors, CJK wide characters, very long lines; each line starts with `line NNNNN` and is 147 columns wide
# mono: a single SGR at the start and a single reset at the end (one same-colored span across many frames)
```

It must be **fully deterministic** (no timestamps, random numbers, hostnames, or `$PWD`), or byte-level comparison is meaningless.

Two easy traps:

- **The completion marker must appear only in the output.** With `echo EMIT-DONE`, the echoed command line itself contains the string, so the wait is satisfied as soon as the command is typed — you'd be testing the echo, not the output. Use `printf 'EMIT-%s\n' DONE`.
- **To test behavior during a disconnect, add a per-line delay** so the output spans the whole disconnect window. Without it, thousands of lines may all arrive before you cut the connection.

### Cutting the WebSocket

```ts
// Option 1: cut at the routing layer (preferred). Installs a controllable relay that can cut and restore at any time.
const net = await installWSControl(page)   // e2e/harness.ts
await net.goOffline()
net.goOnline()

// Option 2: CDP offline emulation
const cdp = await context.newCDPSession(page)
await cdp.send('Network.emulateNetworkConditions', { offline: true, ... })
```

**Option 1 is preferred.** CDP offline doesn't fire `onclose` right away on an **established** WebSocket: the page keeps thinking it's online until the heartbeat declares it dead 40 seconds later, so you wouldn't be testing a disconnect. Option 2 is for testing the immediate retry driven by the browser's `online` event.

---

## E2E-1 Basic round trip

> AC-1.3, AC-1.9, AC-4.1

1. Pairing succeeds and the main UI loads
2. Cookie attributes are correct (`HttpOnly` / `SameSite=Strict`)
3. A session is created automatically (or manually)
4. Click the terminal, type `echo hello-webterm`, press Enter
5. `hello-webterm` appears in the terminal
6. The output of `stty size` matches the frontend's cols/rows

---

## E2E-2 Resume after disconnect ★ core

> AC-2.1, AC-2.2, AC-2.3, AC-2.5

### E2E-2a Baseline + one disconnect

1. Run `emit.sh 2000` without disconnecting → `serialize()` → baseline
2. New session, run `emit.sh 2000` again, cut the WS at about 50% of the output
3. Wait for the UI to go "Reconnecting" → "Resumed"
4. Wait for the output to finish
5. `serialize()` is **byte-identical** to the baseline

### E2E-2b Disconnected for 5 seconds (buffer doesn't overflow)

Same as above, but after disconnecting `page.waitForTimeout(5000)` before allowing the reconnect. Assert byte-identical.

### E2E-2c Output during the disconnect exceeds ring_bytes → snapshot

> Uses the `--ring-bytes 65536` instance.

1. Baseline: `emit.sh 5000` without disconnecting → serialize **the last 2000 lines + current screen** → baseline
2. New session, disconnect, and have the session produce > 64 KiB of output while disconnected (`emit.sh 5000`)
3. Reconnect
4. Assert:
   - `resumed[].status == "snapshot"`, followed by a SNAPSHOT frame
   - **No** "history truncated" notice or anything like it
   - The serialized last 2000 lines + current screen match the baseline **line by line** (screen-level, AC-2.21). Strip trailing whitespace before comparing: the snapshot records written trailing spaces as empty cells, while `translateToString` keeps written spaces; the Vitest cell comparison normalizes the same way
   - **Output produced after the reconnect is entirely correct** (a later `echo marker-xyz` shows up normally)

### E2E-2d Rapid disconnects

Disconnect 10 times, 300ms apart. The final result is byte-identical (no accumulated drift).

### E2E-2e Cut inside a colored span

Use `emit.sh <lines> <delay> mono` to output a same-colored span across many frames, and disconnect/reconnect **in the middle of it**. Assert:

- The incremental path is taken (`status == "ok"`), and the replayed bytes are byte-identical to the baseline at the same position — the agent doesn't rewrite the output stream (AC-2.5)
- Text after the cut has the same color as in the baseline

---

## E2E-3 Input during a disconnect isn't lost

> AC-2.4

1. Set up a session, click the terminal
2. Cut the WS (don't let it reconnect right away)
3. Type three commands in the terminal: `echo A1`, `echo A2`, `echo A3`, each followed by Enter
4. The input wasn't silently swallowed: the connection banner shows "Reconnecting", and `__webterm.inputStats().unackedBytes > 0` (the bytes are in the resend queue)
5. Restore the connection
6. `A1`, `A2`, `A3` appear in the terminal **in order, with no duplicates and no losses**. **Search for substrings; don't compare whole lines**: the three commands arrive in one batch after the reconnect, and while bash runs the first, the kernel echoes the typed-ahead other two, so after readline redraws, output lines can carry leftover echo fragments (seen: `A1p`, `inA1`, `A2r`, 4 times in 12 runs on main). So pick output markers that can't appear in the echoed command (write the command as `printf "A%s-OK\n" 1`; the output is `A1-OK`, the echo only contains `A%s-OK`), and count occurrences and compare positions in the full terminal text
7. Assert **no `input_gap`** during the reconnect: `welcome.resumed[].in_ack` must be the cumulative value from before the disconnect, not 0 (AC-2.12)

Variants:

- Paste more than 256 KiB while disconnected → the UI clearly says the input is too large, instead of dropping it silently
- Paste 70 KB while online → all of it reaches the PTY (the cap is the agent's input queue, not 64 KiB) and no notice appears

### E2E-3b Input in a session switched away from

> AC-2.4, [ADR-0047](../20-architecture/adr/0047-review-fixes.md) §2

1. Two sessions A and B; A is active
2. Cut the WS, type into A a command that writes a marker file, switch to B
3. Restore the connection; `resume` lists only B
4. Within 15 seconds the marker file exists, **while B is still active**: A's pending input went out right after `welcome`, not when the user switches back

---

## E2E-4 How the snapshot path looks in the UI

> AC-2.6

See E2E-2c. Listed separately because it also verifies the UI side: the screen is cleared before the snapshot is written (the same content appears only once), the scrollback position returns to the bottom, and no "truncated" notice appears.

---

## E2E-5 Connection status

> AC-2.10

Run once on Pixel 5 (`compact`) and once at 1440×900 (`wide`).

1. Online: on `compact` no banner is visible; `conn-text` is in the DOM, reads "Online", and is visually hidden; on `wide` the `conn-dot` at the right of the tab bar has the online color
2. Cut → the banner shows "Reconnecting · retry in Ns", counting down; on `wide` the status dot changes color
3. **The banner doesn't change geometry**: the `.term` rect is identical field by field before and after the banner appears, and `__webterm.size()` and `__webterm.resizes()` don't change
4. Restore → the banner shows "Resumed · caught up N KB" (`conn-note`) and hides after 3 seconds; no toast
5. The byte count matches the actual replay size (order of magnitude is enough)
6. Page load ([ADR-0049](../20-architecture/adr/0049-connection-status-in-one-place.md)): with `/api/devices` held, the gate shows the banner "Connecting…"; once the app mounts, the banner is at the same position, pixel for pixel

---

## E2E-6 Multiple sessions and waiting for you

> AC-2.11, AC-4.3, [ADR-0052](../20-architecture/adr/0052-waiting-for-you-replaces-unread.md)

1. Create sessions A and B
2. Run `emit.sh 100 50` in A (continuous output), then switch to B
3. **Output alone lights nothing**: while A prints, A has no dot (`data-attention=false` on `open-sessions` on Pixel 5, on A's tab at 1440×900), and `__webterm.attention(A)` stays false
4. `echo in-b` in B works normally
5. Switch back to A: content is **complete** (all the output produced while away is there); A's scroll position is where it was before switching away (unless it was at the bottom, in which case it follows to the bottom)
6. **A bell lights it**: in A run `sleep 2; printf '\a'`, switch to B. Within 5 s, A gets the dot: on Pixel 5, `open-sessions` has `data-attention=true` and A's drawer row has one; at 1440×900, A's tab has `tab-<A>-attention`
7. Switch back to A: the dot clears (the page sent `session.seen`; other connections get `attention:false` too, IT-attention-1)
8. **A title going from a spinner to idle lights it**: in A run `bash -c "printf '\e]0;◐ work\a'; sleep 2; printf '\e]0;✳ done\a'; sleep 30"`, switch to B → within 5 s A has the dot; its name shows `✳ done`
9. **Looking at it means it never lights**: stay on A and ring the bell (`printf '\a'`) → after 3 s `__webterm.attention(A)` is false

---

## E2E-7 CJK IME input

> AC-3.3, AC-3.14. Composition on the text page is in E2E-40.

Playwright can dispatch composition events.

### Direct input

1. Click the terminal
2. Dispatch `compositionstart` → `compositionupdate` (data: `ni`) → `compositionupdate` (data: `你`) → `compositionend` (data: `你好`)
3. Assert: zero INPUT frames before `compositionend`; `你好` is sent **once** at `compositionend`
4. An inline preview appears at the cursor during composition

### Direct input after switching sessions (regression)

**Each session has its own xterm instance, and so its own helper textarea**, and `store.activate()` removes the previous session's host from the DOM. So switching sessions must reattach `RawIme`.

1. Create a second session and switch to it
2. Click the terminal and dispatch composition events
3. Assert: the inline preview is visible — it doesn't appear if `RawIme` wasn't reattached. **This is the effective regression check** (verified by mutation: reverting to "attach once" makes it fail)
4. Assert: zero INPUT frames before `compositionend`. Kept as a guard, but **it can't catch the heart of this bug**: synthetic `CompositionEvent`s don't trigger xterm's `onData`, so the consequence ("`isComposing` is always false → composed bytes go straight to the PTY, violating AC-3.3") can only be demonstrated with a real IME (see [automation limits](../90-roadmap/milestones.md#what-automation-cant-cover))

### Direct input: punctuation inserted directly by the on-screen keyboard (AC-3.14)

With the iPhone Chinese keyboard, "comma doesn't reach the terminal, period does": two keys on the same keyboard report different `keyCode`s, and xterm handles one but not the other (see [input.md](../40-frontend/input.md#directly-inserted-text-ac-314)).

In direct input, dispatch on the helper textarea what an on-screen keyboard does: `keydown` → insert the character → `input(insertText)` → `keyup`:

1. "，" and "！" with `keyCode: 0` → **must reach the terminal** (these were lost before the fix; this is the heart of the bug)
2. "。" with `keyCode: 229` → still reaches the terminal (xterm's diff path; don't break it)
3. "？" with `keyCode: 191` → still reaches the terminal (xterm's keydown path)
4. Commit "你好" by composition, immediately followed by "，" with `keyCode: 0` → both are there, and **each appears only once** (no duplicate sends)
5. After commit, the terminal output contains no duplicates like `，，` / `你好你好`

**A separate test case** (it can't be folded into the sequence above: step 5 asserts that `，，` must not appear, while this one requires exactly `，，`; the two only agree because that sequence has no repeated keystroke):

6. **Press the same `keyCode: 0` "，" twice (both dispatches in one `evaluate`, < 120ms apart) → the terminal must echo two "，"**. Dedup must only suppress the copy "another path already sent"; it must not eat the user's second keystroke — that would be a silent drop ([ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md)). This goes through the **on-screen keyboard direct-insert** path, where nothing else would send the second press, so eating it loses the character for good

> The real device's event sequence can't be reproduced exactly in headless mode (iOS reports the `keyCode` itself),
> but the combination "a keydown happened + insertText" is the heart of it, and synthetic events cover it precisely.

> This bug really existed (`if (ime) return` in `attachIme` attached it to the first session only),
> and it only showed up in CI: the old implementation attached by polling with `setInterval(attachIme, 300)`,
> which happened to be fast enough locally but lost events in CI. Polling was replaced with deterministic attachment in `select()`.

---

## E2E-10 Phone layout and extra keys

> AC-3.18, AC-3.20

`web/e2e/mobile.spec.ts`, Pixel 5 device descriptor (touch). Hook `WebSocket.send` to record INPUT frames.

1. **Structure**: `data-form=compact`; no `tabbar`; the extra-keys area is below the terminal, 80px tall; the left column is `open-sessions` and `toggle-text`; the 14 keys' testids in order are `key-Escape key-Slash key-Minus key-Home key-ArrowUp key-End key-PageUp key-Tab key-Ctrl key-Alt key-ArrowLeft key-ArrowDown key-ArrowRight key-PageDown`
2. **All visible, no horizontal scroll**: key area `scrollWidth ≤ clientWidth + 1`, and all 14 key rects are inside the viewport
3. **Static**: while `sleep 30` runs, while `less` holds the screen, and after quitting `less`, the key testid sequence matches step 1
4. **Bytes**: `key-Escape` → `1b`; `key-ArrowUp` → `1b5b41`; after `printf '\033[?1h'` turns on DECCKM, `key-ArrowUp` → `1b4f41`, `key-Home` → `1b4f48`; back to normal after `printf '\033[?1l'`. Every press increments `inputStats().data.n`
5. **Doesn't steal focus**: click the terminal so it has focus, press `key-Tab` → `document.activeElement` is unchanged
6. **Sticky CTRL**: tap `key-Ctrl` → `data-sticky=armed`; `keyboard.type('c')` → sends `03`, `data-sticky=off`; tap `key-Ctrl` then `key-ArrowLeft` → sends `1b5b313b3544` (`ESC[1;5D`)
7. **Lock**: long-press `key-Ctrl` (> 500ms) → `data-sticky=locked`; `c` then `u` → `03` `15` (not `d`: `^D` at an empty prompt makes bash exit); tap again → `off`
8. **Tapping the terminal** (AC-3.20): tap `.term` once → focus moves to xterm's helper textarea; tap again → focus leaves; a 30px vertical drag doesn't change focus; **vertical drags really scroll** (with enough scrollback, 20 consecutive drag frames change `viewportY` by more than one line — guards against touchmove landing on a node detached when the DOM renderer replaces row elements, which scrolls only the first frame); after `printf '\033[?1000h'` turns on mouse tracking, a tap → focus unchanged and a mouse report (starting with `1b5b4d`) appears in the INPUT frames; restore with `printf '\033[?1000l'`
9. **Safe area**: in Chromium `env(safe-area-inset-*)` is always 0, so override `--sa-top: 47px` and `--sa-bottom: 34px` directly on `.app` → the terminal's top edge is at 47px, the extra keys' bottom edge is 34px above `.app`'s bottom, `.app`'s height is unchanged, the terminal is exactly 81px shorter, and the page doesn't overflow; clear `--sa-bottom` → back to normal
10. **Landscape**: `viewport` and `screen` both 851×393 → still `compact`, extra keys 80px, all 14 keys visible

> **Note**: Playwright can't actually open an on-screen keyboard. Keyboard geometry is covered by E2E-21 (simulated by changing the container height and replaying `visualViewport` events); real devices are in the manual checklist.

---

## E2E-11 Session lifecycle

> AC-4.2, AC-4.5, US-7.3

1. Create sessions up to the limit (5, set in the fixture) → `new-session` is disabled and says "Session limit reached (5)"
2. In one session, `printf 'LAST-%s\n' LINE`, then `exit 1` → `[Exited (code 1) · Enter to close]` appears at the end of the terminal, **after** `LAST-LINE`; the notice is written by the frontend and not counted in seq: after it appears `__webterm.outSeq()` doesn't change any more, and equals the agent's `head_seq` (checked after a reload against `welcome.sessions[].head_seq`)
3. The exited session's content is still scrollable, selectable, and copyable
4. The drawer list shows `exit 1` (warning color); the tab is only grayed out (`data-exited`), with no exit code
5. **Reload the page** → the notice appears **only once** in the buffer
6. Press `Enter` in that session → the session closes (no confirmation) and an adjacent session becomes current
7. Close a `running` session (session menu → Close) → `close-confirm` opens (not a browser dialog: no `dialog` event fires at any point), its title contains the session name, and focus is on `close-ok`; click `close-cancel` → the sheet disappears and the session is still there; close again and press `Esc` → also not closed; close again and press `Enter` → the session closes (ADR-0038)

---

## E2E-12 Reading output

> AC-5.1, AC-5.3, AC-5.4

1. Run `emit.sh 3000` → scroll up to see early output (no special mode needed)
2. **Appearance: follows the system by default; theme and font size are changed in settings** (AC-5.3, [ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md)):
   - Default: with `page.emulateMedia({ colorScheme: 'light' })`, the backgrounds of `body` and the terminal area (`.stage`) are light (`--bg` / `--term-bg`), and so is xterm's theme background (the inline style on `.xterm-viewport`; CSS forces its computed value to transparent), which is `--term-bg`; switch to `dark` **without reloading** and all three turn dark; `<html>` has no `data-theme`; the terminal font size (`__webterm.fontSize()`) is 14; pressing `Ctrl+Shift+,` opens no sheet (zero `.drawer`s)
   - Change theme: with the system still `dark`, click `open-settings` → `settings` appears, and `theme-system` has `aria-checked="true"`; click `theme-light` → **without reloading**, `<html data-theme="light">` and all three backgrounds are light; reload → still light, and a paired page loads light from the start; open settings again and click `theme-system` → back to dark, `data-theme` removed
   - Change font size: note `__webterm.size()` and `resizes()`; click `font-inc` twice → `font-size` shows 16, `__webterm.fontSize()` is 16, fewer columns, and **a `resize` was sent** (`resizes()` grew, and the last `resize`'s `cols` equals the new column count); reload → still 16; click `font-dec` down to 10 → `font-dec` becomes `disabled`; `localStorage` has only `webterm.fontSize`, with no per-form keys
3. Select some text while new output arrives → **the selection isn't broken** (it still covers the same lines)
4. Copy → the clipboard contents are correct

---

## E2E-15 Device management

> AC-1.3, AC-1.11

1. `GET /api/devices` returns the current device with `current: true`
2. Pair a second time from a second browser context → two devices
3. Revoke device two from device one → **device two's WebSocket closes within 5 seconds**, and its UI says "This device has been revoked" and goes to the pairing page. Opening the page again on device two (a new tab) says it was revoked too
4. Revoke all at once (`POST /api/devices/revoke-all`) → this device is logged out too and goes to the pairing page

> The frontend has no device management UI (listing and revoking go through the API and `webterm devices`), so this calls the API directly.

---

## E2E-16 Unauthenticated access

> AC-1.7, AC-1.8

1. Clear cookies and open `/` → the static page loads, and the frontend shows the "Pairing required" instructions
2. `GET /api/devices` → 401
3. **`GET /ws` upgrade → 401** (testing only REST isn't enough)
4. WS upgrade with a forged `Origin: https://evil.com` (and a valid cookie) → 403
5. `POST /auth/pair` with a wrong pairing code, retrying at the backoff intervals for consecutive failures (1s, 2s, 4s, 8s; see [auth-pairing.md §Rate limiting](../60-security/auth-pairing.md#rate-limiting-ac-16)) → the first 5 get 401, the 6th, within the same minute, gets 429 + `Retry-After`; retrying without waiting out the backoff also gets 429

---

## E2E-27 Typing in the digit pairing code (ADR-0017)

> AC-1.15

`web/e2e/pairdigits.spec.ts`. The fixture grabs `dddd-dddd-dddd-dddd` from the agent's stdout.

1. Open `/pair` (no fragment) → a digit input and a "Pair" button appear; the button is disabled with fewer than 16 digits
2. Paste the digits **separated by spaces** → the input shows 16 digits grouped with `-`; click "Pair" → goes to `/`, and `conn-text` reads "Online"
3. The URL code from the same pairing (the one in the QR code) is now invalid: opening the pairing link in another context → "Invalid or expired pairing code"
4. Enter a 16-digit wrong code → 401 with "Invalid or expired pairing code"; the input is still there for a retry

---

## E2E-17 PWA

> AC-1.14

1. `manifest.json` is reachable with all fields
2. The service worker registers
3. Reload while offline → the connection banner says "Can't reach the agent · retrying" (not the browser's default error page, and not pretending to work); back online, it gets through without a reload
4. Assert the service worker **cached no `/api/*` or `/ws` responses**

---

## E2E-18 No mix-ups after an agent restart

> AC-2.13

1. Open two browser tabs, each holding sessions
2. Restart the agent process (all sessions disappear, [ADR-0003](../20-architecture/adr/0003-no-tmux.md))
3. Tab A reconnects first and creates a session → it gets `sid = 1`
4. Tab B reconnects afterwards, its `hello` carrying the old `instance_id` and `resume{sid:1, out_seq:<large>}`
5. Assert: B gets `status: "gone"`, the UI says the session ended, and **A's new session's output is not appended to B's old content on screen**

---

## E2E-21 On-screen keyboard geometry: the extra keys stay visible when the keyboard opens

> AC-3.8. `web/e2e/keyboard.spec.ts`, Pixel 5 viewport. Covers both browser models (see [`../40-frontend/layout.md`](../40-frontend/layout.md#height-ac-38)):

1. **Layout viewport shrinks too** (`resizes-content`): after clicking the terminal, shrink the viewport from 727 to 450 → `.app` is 450 tall with no `translateY`, the extra keys lie entirely within [0,450], `data-form` is still `compact`, and a `resize` is sent with fewer rows
2. **Only the visual viewport shrinks and scrolls up** (iOS Safari / Chrome `resizes-visual`): a fake `visualViewport` replays "visual 727→400, `offsetTop`→327", once with **Safari semantics (`innerHeight` follows to 400)** and once with Chrome semantics (stays 727) → `.app` must be `translateY(327px)`, its top = 327, and the extra keys within the visible area [327,727]; the same with the text page focused; everything resets when the keyboard closes
3. **Plain bounce isn't compensated**: `offsetTop` becomes −40 / 60 with the height unchanged → `.app` has no `translateY` (guards the fix for drag jitter)

---

## E2E-26 Hot upgrade keeps sessions (ADR-0016)

`web/e2e/reexec.spec.ts`. The fixture sends `SIGUSR2` to the agent process (`Agent.reexec()`): the real binary execs the same file in place, with the same PID and the same stdout pipe.

1. Start a command with continuous output (300 lines, 20ms apart, ending with `REEXEC-DONE`), and send `SIGUSR2` midway
2. The browser sees exactly one reconnect: `conn-text` briefly leaves "Online" and comes back; after the reconnect `welcome.resumed[0].status == "ok"` (`instance_id` didn't change)
3. When the command finishes, each of the 300 lines appears **exactly once, in order** (nothing lost or duplicated), and `REEXEC-DONE` is there
4. The shell is still alive: submitting another command produces output; `webterm reload --probe` returns 0 against the new process, and `generation` in `status` is 1
5. **Emulator state was handed off**: after the output finishes and the session is idle, hot-upgrade again; open a new browser tab before and after this upgrade (`out_seq == 0`, snapshot path) and serialize the terminal; the two match line by line
6. Preflight failure path: injections like `--handoff-check-fail` are left to the Go integration test (IT-handoff-1); E2E doesn't simulate them

---

## E2E-28 Sheets and the phone session drawer

> AC-4.10, AC-5.11, AC-4.8. `web/e2e/drawer.spec.ts`, Pixel 5. The touch drawer has a ~170ms `sheet-up` enter animation: wait for it to finish (`animationend`, or two identical rect readings) before measuring "at the bottom" or long-pressing a row in the drawer, or you get a mid-animation position.

1. **Shape**: the number in the session button `open-sessions` equals the session count (`1`); tap it → `session-drawer` sits at the bottom (bottom edge within 1px of the visible area's bottom), full width, with a grab handle `.drawer-grab` and a ✕ in the header; the pinned bottom row is `new-session` and `open-settings`, each with an SVG icon; after creating a session from the drawer the button shows `2`; swipe that row left in the drawer → `row-close` → `close-confirm` is a bottom sheet **stacked on the drawer** (two `.drawer`s); `Esc` closes only the confirmation and the drawer stays; close again and click `close-ok` → the row disappears, the drawer stays open, and the button goes back to `1` (AC-4.11)
2. **Focus moves into the sheet**: on every open, `document.activeElement.closest('.drawer')` is non-null
3. **Ways to close** (session drawer): close it once each by tapping the backdrop, `Esc`, ✕, picking a session, and `page.goBack()` (system back button); after `goBack` the page is still at `/`; after five open/close cycles `history.length` is at most 1 more than at the start
4. **Doesn't squeeze the terminal**: the `.term` rect is identical field by field before and after opening/closing the drawer, and `__webterm.size()` and `resizes()` don't change
5. **Focus restore** (AC-4.8): click the terminal so it has focus → open the drawer → pick another session → focus is on the new session's helper textarea; blur the terminal first → open the drawer → pick a session → focus is **not** in the terminal
6. **Row actions** (AC-4.12, ADR-0039): two sessions. Swipe the second row left by 120px with touch → on release it stays open (row content shifted 216px left), and `row-pin` `row-rename` `row-close` are visible; swipe only 60px → springs back; swipe right on an open row → closes; dragging the list vertically opens no row. Long-press a row → it opens the same way and `session-menu` **doesn't** appear; then swipe another row left → the first one closes; tap the open row's body → it closes and the current session doesn't change. `row-pin` → a pin appears before the name (an SVG inside `.pin-mark`) and the row closes. `row-rename` → `rename-sheet` stacks on the drawer (two `.drawer`s), `rename-input` has focus, its content is all selected, and its font size is 16px; type `RENAMED` and press `Enter` → the sheet disappears, the drawer stays, and the row shows `RENAMED`; open rename again, clear it, and click Save → automatic naming is restored; open rename again and press `Esc` → only the rename sheet closes
9. **Sheets follow the visible area** (ADR-0039 §3): with the rename sheet open, reduce the viewport height by 300px (simulating the visual viewport being squeezed by the keyboard: `.app`'s height follows) → `rename-sheet`'s bottom edge is within 1px of `.app`'s bottom edge, `rename-input` is entirely inside `.app`'s rect; `session-drawer`'s height is ≤ 80% of `.app`'s height
7. **Height and spacing** (AC-5.11, ADR-0037 §5): open the drawer with only 1 session → `session-drawer`'s height is ≥ 50% of the visible area (within 1px); the bottom row sits at the bottom of the sheet; ≥ 16px between `new-session`'s bottom edge and the sheet's bottom edge, 16px between its left edge and the sheet's left edge, 16px between `open-settings`'s right edge and the sheet's right edge, 12px between the two buttons, and both buttons are the same height (48px)
10. **Paths and names** (ADR-0042 §3): three sessions, `cd`'d to `/usr/local/share`, `e2e/fixtures` (absolute path, usually under home, shown as `~/…`), and `/` respectively; open the drawer → in each row's path text node, **the first character is drawn left of the last character** (measure actual character rects with a `Range`; comparing `textContent` alone can't detect reversal), and the last character lies entirely inside the `.sl-meta` rect; the name in the `fixtures` row is fully visible (`.sl-text` has `scrollWidth ≤ clientWidth`)
8. **Settings from the drawer**: click `open-settings` → `session-drawer` disappears and `settings` appears, at the bottom, full width, with a grab handle; its height is under 50% of the visible area (the session drawer's minimum height doesn't apply); ≥ 16px between `font-inc`'s bottom edge and the sheet's bottom edge; tap the backdrop to close

---

## E2E-30 Switch away → backlog exceeds ring_bytes → switch back (AC-2.6 / AC-2.15)

> Uses the `--ring-bytes 65536` instance. `web/e2e/subscribe-reset.spec.ts`.
>
> E2E-2c / E2E-4 go through reconnect (`welcome.resumed[].status`); this one goes through switching back (`subscribe`), a different code path.

**Background output must `sleep` a few seconds before starting** (`(sleep 3; for …; done; printf '\033[6n'; touch <done>) &`): those seconds are for switching to another session, so all the output lands while the session is unsubscribed. Completion is signaled through a **file** (the test process checks `existsSync` directly): the session has been switched away from, so you can't see on screen whether it finished.

### ① Backlog exceeds ring_bytes → snapshot

1. Create session A. In A, `printf 'MARK-%s\n' ONE` and wait for it to show
2. Start background output in A: 2500 lines × 70 B ≈ 175 KiB, ending with a CPR query (`\033[6n`)
3. Create B and switch to it; wait for the completion file
4. Switch back to A and assert:
   - The `subscribe` the client sends **carries `cols`/`rows` itself**, and **no `resize` precedes it** (hook `WebSocket.send`)
   - A SNAPSHOT frame arrives, not OUTPUT continuing from the old position
   - **`MARK-ONE` appears 0 times in the terminal**: the snapshot only carries the last 2000 lines, and it's long gone. If it's still there, the screen wasn't cleared and the snapshot was appended after the old screen
   - The client **didn't** send the CPR reply (`ESC[<row>;<col>R`) as INPUT
5. Do another round (switch away, produce another batch, switch back) and assert **the buffer's line count differs from the previous round by less than one screen**: each round rebuilds, it doesn't append

### ② Backlog within ring_bytes → incremental catch-up

Same flow, but produce only 200 lines (≈ 14 KiB, well under 64 KiB), again ending with a CPR. After switching back, assert:

- OUTPUT frames arrive (incremental), no SNAPSHOT; `MARK-ONE` is still there — incremental catch-up must not clear the screen
- The output produced while away was caught up (`few 0200` is visible)
- The client **didn't** send a CPR reply

### ③ Reconnect catch-up doesn't reply either (control)

`web/e2e/replay-echo.spec.ts`. ② tests incremental catch-up on the switch-back (`subscribe`) path; this is the control for the same rule on the **reconnect** (`welcome.resumed[].status == "ok"`) path:

1. Submit `sleep 2; printf '\033[6n'; sleep 30` and disconnect immediately, so the DSR query falls inside the offline window
2. Restore after 3 seconds, and assert the incremental path was taken (`status == "ok"`)
3. Wait for the catch-up to be written into xterm, and assert the client **didn't** send the CPR reply as INPUT

> ② is the real gatekeeper for AC-2.15: on the incremental path **nothing on the wire says "this part is history"**; it all depends on the client tracking `catchup_to`. Miss it, and every switch back to a session sends the foreground program a string of garbage keystrokes.

---

## E2E-31 Switching back to an alternate-screen session = current screen (AC-2.6 / AC-2.21)

> Uses the `--ring-bytes 65536` instance. `web/e2e/redraw.spec.ts`.
>
> A byte window can't reconstruct the current screen of an alternate-screen program ([ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md#context)); a snapshot can: the emulator holds exactly that screen.

Fixture `e2e/fixtures/altscreen.sh <seconds of fast output> <completion marker file>`: a fake full-screen TUI that behaves like measured claude:

- Enters the alternate screen with `ESC[?1049h` at startup, **only once in its whole lifetime**
- Draws one screen (including a `FRAME <n>` marker line), then only redraws content lines (diffs, absolute positioning, **no clear screen**), about 30 KB/s
- After the fast-output period it `touch`es the marker file and **goes idle, producing no bytes at all**
- On `SIGWINCH` it redraws the whole screen and increments the `FRAME` counter; on `SIGINT` / `SIGTERM` it returns to the main screen with `ESC[?1049l`

1. Create session A, run `altscreen.sh`, wait for `FRAME` to appear
2. Create B and switch to it; wait for the marker file (= A's backlog has passed 64 KiB and it's gone idle)
3. Switch back to A and assert:
   - A SNAPSHOT frame arrives, and **the SNAPSHOT is < 8 KiB** (the current screen is KB-sized, not all of `ring_bytes`)
   - `__webterm.altScreen()` is `true`: the snapshot put the client back on the alternate screen
   - `FRAME` appears **once** on screen, and scrollback holds no copy of the program's UI
   - The agent **didn't** change the window size on switch-back (`altscreen.sh`'s `FRAME` counter didn't increase from a SIGWINCH)
4. Make `altscreen.sh` exit (back to the main screen), then build up another backlog in A larger than `ring_bytes` and switch away / back once: still a snapshot, the main screen shows the shell's content, with no residue. Without the backlog the session is idle after exiting, switching back takes the incremental path, and the snapshot isn't tested

---

## E2E-33 Zombie connections: exposed immediately on returning to the foreground (AC-2.20, ADR-0020)

> `web/e2e/zombie.spec.ts`.

**Zombie connection = the line is dead but there's no `onclose`.** Phone screen off, switching apps, Wi-Fi to cellular, NAT / reverse proxy silently reclaiming the connection: none of these send a FIN over TCP, so the browser's `readyState` stays OPEN. The page believes it's online, all typing goes into a dead socket, and nothing on screen changes.

Fixture: `installWSControl`'s third state, `goZombie()`: **the established connection stops forwarding in both directions but isn't closed**; new connections get `close(1006)` immediately, as if the line were down. This is more precise than CDP offline: the CDP route doesn't apply to connections proxied by `routeWebSocket`, and "not closed" is exactly the point being tested.

1. Pair, open, wait for "Online"
2. `net.goZombie()`. Assert the status bar **still** says "Online" — that's what the problem looks like: the page has no idea the line is dead
3. Dispatch a `visibilitychange` (page back in the foreground)
4. Assert the status bar leaves "Online" **within 5 seconds** (to "Reconnecting" / "Connecting"). Before the fix this took 40 seconds (30s heartbeat + 10s pong timeout)
5. `net.goOnline()`, assert it's back to "Online"
6. Assert the command typed during the zombie period **eventually ran** (resent from `in_ack`, AC-2.4): the liveness probe must not lose input

---

## E2E-34 Typing must not vanish (AC-4.8 / AC-2.15 / AC-3.3, ADR-0020)

> `web/e2e/inputalive.spec.ts`. Three independent paths with the exact same symptom: you type and nothing happens.

### ① Type right after switching sessions (AC-4.8)

1. Create session A, click the terminal once, type `echo ONE`, confirm the echo
2. `Ctrl+Shift+Enter` creates session B (focus is on the terminal)
3. **Without clicking the terminal**, `keyboard.type('echo TWO')` + Enter → `TWO` must appear
4. `Ctrl+Shift+↑` back to A, again without clicking the terminal, type `echo THREE` → must appear

> `activate()`'s `prev.host.remove()` dropped focus to `body`; before the fix, every key from step 3 on landed on `body`.

### ② Typing during replay (AC-2.15)

1. Start background output in session A, producing **1 MiB** (the default ring is 256 KiB, so switching back takes the snapshot path)
2. Switch to B, wait for the completion file
3. Switch back to A and, **without waiting for anything**, immediately `keyboard.type('echo REPLAYKEY')` + Enter
4. Assert the echo of `REPLAYKEY` appears

> The replay gate must distinguish by origin, not gate on "is it replaying right now". This step pairs with E2E-30 ②: that one asserts automatic replies **don't** reach the PTY, this one asserts user keystrokes **do**.

### ③ `compositionend` never arrives (AC-3.3)

1. Dispatch `compositionstart` + `compositionupdate` on the terminal's hidden `textarea`, **without `compositionend`**
2. Assert that typing really doesn't reach the PTY at this point (not a byte is sent during composition; AC-3.3's original semantics must hold)
3. Dispatch `blur` → type again → must get through
4. Another round, this time recovering with a plain `keydown` whose `isComposing === false` → must get through

> Before the fix, `composing` had only one exit, `compositionend`; if it never came, the state stuck forever and that session's terminal input stayed dead until a reload.

### ④ The input path is observable (AC-3.17)

1. Click the terminal, type a character, and confirm the echo → in `__webterm.inputStats()`, `keydown` / `toTerm` / `data` / `sent` **all four rise**, `gated` is 0, and `verdict` says all four stages are OK
2. **Fingerprint of lost focus**: after `activeElement.blur()`, type another key → `keydown` **rises**, `toTerm` **doesn't**, the `focus` field shows focus is no longer on the terminal, and `verdict` points to "focus is not in the terminal"
3. The previous step also proves that **stages are judged by the most recent event, not by totals**: step 1 already made all four totals > 0, so an assertion on totals would always pass

> The "stuck composition" fingerprint isn't tested: it can't be reproduced with real events, because a `keydown` with `isComposing === false` triggers the fallback reset (the fix in ③) and clears the composition state at once. That branch of the verdict logic is covered by UT-inputstats-1.

> This doesn't test "does input get through" (that's ①②③); it tests **whether, when input is stuck, you can see at a glance which stage broke**. ADR-0020's principle needs observability; otherwise next time you start from guessing again.

---

## E2E-35 The current session is obvious at a glance (AC-4.9)

> `web/e2e/sessionactive.spec.ts`, 1440×900 (tab bar) and Pixel 5 (drawer). **The assertion is "you can see it", so measure computed styles, not class names.**

1. Create three sessions
2. **Exactly one current**: `tabbar` has exactly one `[aria-current="true"]`, and its `data-sid` = `__webterm.sid()`
3. **Current ≠ hover ≠ plain**: hover the mouse over a non-current tab and read `backgroundColor` in three places — the current tab, the hovered tab, and a tab that's neither — **all three differ pairwise**; the current tab has an accent underline
4. **Moves with switching**: `Ctrl+Shift+↓` → `aria-current` moves to the adjacent tab, and the old one no longer has it
5. **No scrolling when already visible**: with all tabs visible, switch back and forth twice; `tabbar`'s `scrollLeft` stays 0
6. **Scrolls into view**: `screen` 1440×900, `viewport` 600×900, create up to 5 sessions (tabs are at least 120px, so 5 don't fit), `Ctrl+Shift+↓` to the last one → that tab's rect lies **entirely inside** `tabbar`'s rect and `scrollLeft > 0`; switch back to the first → also fully visible
7. **Same rules in the drawer** (Pixel 5): open the drawer; exactly one row has `aria-current="true"`, with an accent left bar (`box-shadow` includes inset)

---

## E2E-36 You can still scroll back after a refresh (AC-5.14)

> `web/e2e/refresh-scrollback.spec.ts`. Default `--ring-bytes`.

1. Start a session, `emit.sh 3000 0`, wait for `EMIT-DONE`
2. `page.reload()`, wait for the reconnect: the subscription takes the snapshot path (`out_seq == 0`)
3. **Can scroll back**: the serialized result still contains `line 01500` (within the last 2000 lines), and not `line 00100` (beyond 2000 lines). The viewport must be wide enough (1440×900, ≥ 147 columns): if each line wrapped into two, 2000 rows would hold only about 1000 lines and `line 01500` would fall out
4. **Only one copy**: `line 01500` occurs **exactly once** in the whole buffer
5. **Continues correctly**: after the refresh, run `printf 'AFTER-%s\n' RELOAD`; it appears, and the content before it doesn't reflow
6. **No old sessions after an agent restart**: kill the agent and start it again (`instance_id` changes, every session is destroyed — [ADR-0003](../20-architecture/adr/0003-no-tmux.md)); after a refresh, create a session → **no `line 0…` at all** in the terminal
7. **An alternate-screen session shows its current screen after a refresh**: after refreshing a session running `fixtures/altscreen.sh`, `FRAME` appears only once and scrollback holds no copy of its UI

---

## E2E-37 Baseline measurements for scrolling and writing (record only, no assertions)

> `web/e2e/scrollperf.spec.ts`, phone viewport. [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §7: the output path is native first; this scenario measures how native performs, as the basis for any future "should we optimize" decision. **This machine has no GPU; only main-thread milliseconds count.**

Record and print (into the test report, no assertions):

1. During `emit.sh 4000 0`, the number of main-thread long tasks with `duration > 50` and the longest one
2. After the output finishes, a synthetic 20-frame single-finger vertical drag (12px per frame): the number of long tasks during the drag
3. Switching back to a session with a 1 MiB backlog (snapshot path): time from pressing the switch key until the snapshot is written, and the number of long tasks

To add back any optimization (per-frame batching, scrollback pause, write budget, WebGL, custom scrolling), first compare against these numbers, and write the ADR with the data.

---

## E2E-39 Form (AC-5.18)

> `web/e2e/form.spec.ts`. The form is decided by the screen's short side, so each context must set both `viewport` and `screen`.

1. Pixel 5 (`screen` 393×851) → `data-form=compact`: has `open-sessions`, no `tabbar`
2. `viewport` and `screen` both 851×393 (phone landscape) → still `compact`
3. iPad Mini device descriptor (`screen` 768×1024, touch) → `wide`: has `tabbar` (40px tall), no `open-sessions`; extra keys present, with only `toggle-text` in the left column
4. 1440×900 with a mouse → `wide`: `tabbar` is 36px tall, no extra keys
5. **The keyboard opening doesn't change the form**: in context 3, shrink the viewport height to 344 (simulating a landscape tablet's keyboard) → `data-form` is still `wide` and `tabbar` is still there
6. **Rotation doesn't change the form**: switch context 3's viewport to landscape → still `wide`

---

## E2E-40 Text page (AC-3.19, AC-3.10, AC-3.22)

> `web/e2e/textinput.spec.ts`, Pixel 5. Hook `WebSocket.send` to record INPUT frames; when asserting, concatenate the frames from that step (paste and Enter are two `onData` calls; whether they share a frame doesn't matter). The E2E bash has bracketed paste enabled.

1. **Switching doesn't move geometry**: click `toggle-text` → `textinput` is visible and focused; `__webterm.size()` and `resizes()` are unchanged; **the textarea's `border-*-width` is ≥ 1px on all four sides, and the whole box (border included) lies inside the `extrakeys` rect, with a gap on every side**; click `toggle-text` again → back to the keys page
2. **Swiping also switches**: drag 80px horizontally over the keys → text page; drag back the other way → keys page
3. **Attributes**: the actual attribute values of `autocorrect` / `autocapitalize` / `spellcheck` on `textinput` are `off` / `off` / `false`, and `enterkeyhint` is `send`
4. **Enter with text = send and press Enter**: fill in `echo TEXT-ONE` and press Enter → this step's INPUT frames concatenate to `ESC[200~echo TEXT-ONEESC[201~` + `0d`; the command runs and a `TEXT-ONE` line appears in the output; the textarea is cleared and still focused; `inputStats().data.n` and `sent.n` both rise
5. **Empty Enter**: press Enter again → the INPUT frame is `0d`
6. **Composition**: dispatch `compositionstart` → `compositionupdate` (`ni`) → press `Enter` (`isComposing: true`) → **no INPUT frame**; after `compositionend` (`你好`), press Enter → the INPUT frames concatenate to bracketed `你好` + `0d`
7. **Multi-line text is pasted as one block, then Enter**: paste `echo L1⏎echo L2` into the textarea and press Enter → the INPUT frames concatenate to something starting with `1b5b3230307e` and ending with `1b5b3230317e0d`, with the newline in between already turned into `0d`; both lines run, and `L1` and `L2` appear in the output
8. **Enter never inserts a newline**: after every step above, `textinput.value` contains no `\n`
9. **Follows the session** (AC-3.22 / AC-4.8, [ADR-0036](../20-architecture/adr/0036-text-page-per-session.md)): session A is on the text page with `echo DRAFT-A` in the box (no Enter); create session B from the session drawer → B is on the keys page (`extrakeys[data-page=keys]`, `textinput` not visible), with focus in B's terminal. In B, click `toggle-text` and fill in `echo DRAFT-B`. Switch back to A from the drawer → text page, `textinput.value` is `echo DRAFT-A`, focus is in the textarea; press Enter → `DRAFT-A` appears only in A's output. Switch to B from the drawer → text page, value `echo DRAFT-B`; click `toggle-text` back to the keys page, switch to A → A is still on the text page with an empty box (it was just sent); switch back to B → keys page, focus in the terminal; `DRAFT-B` is never sent at any point

---

## E2E-41 Wide tab bar (AC-4.10)

> `web/e2e/tabs.spec.ts`, 1440×900 with a mouse; step 7 uses the iPad Mini device descriptor, step 8 narrows the window midway. `open-settings` and the settings sheet: [ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md). Placement of `+`: [ADR-0035](../20-architecture/adr/0035-tabbar-new-button-pinned.md).

1. **Structure**: the top bar is above the terminal; `tabbar` (the tab strip) holds a single tab; `new-session` is in the top bar and **not** in `tabbar`, to the right of the strip, its left edge 12px from the strip's right edge (ADR-0035); `conn-dot` and `open-settings` are pinned at the right, `open-settings` rightmost with `conn-dot` right next to it on the left; the vertical centers of the SVG in `new-session`, the SVG in `open-settings`, and `conn-dot` differ pairwise by ≤ 0.5px, and the two SVGs are the same size; no `open-sessions`, no extra keys
2. **New and switch**: click `new-session` → one more tab, and it's current; click the first tab → `__webterm.sid()` switches back; throughout, the `.term` rect and `__webterm.size()` don't change
3. **Close**: hovering a non-current tab shows ✕; click it → if the session is running, `close-confirm` appears first (a centered dialog, not a browser dialog), and after clicking `close-ok` the tab disappears; middle-clicking a tab also confirms first; with focus in the terminal, `Ctrl+Shift+W` → the confirmation sheet; `Enter` → closed, and focus goes to the terminal of the new current session (AC-4.11)
4. **Rename**: the tab has `tab-<sid>-idx` containing `[n]` (its position in the order); double-click the tab → `rename-input` appears; type `RENAMED` and press Enter → the tab text is `RENAMED` and `tab-<sid>-idx` is still `[n]` (renamed tabs keep their index too, ADR-0041); double-click again, clear it, press Enter → automatic naming is restored (the CWD's basename)
5. **Session menu**: right-click a tab → `session-menu` has `session-rename` `session-pin` `session-close`; click `session-pin` → a pin appears before the tab name (an SVG inside `.pin-mark`); after switching away, OUTPUT frames for that session keep arriving with rising `seq`, and it gets no unread dot (`__webterm.outSeq()` only reports the current session, so check the frames)
6. **Waiting for you**: A rings the bell after a delay; switch to B → A's tab shows a dot in the accent color (the same color as the current tab's text, not `--err`, ADR-0042); switch back to A → it's gone
7. **Touch** (iPad Mini): ✕ only on the current tab; long-press a tab and release in place → `session-menu`; extra keys present, with only `toggle-text` in the left column; `new-session` is 16px from `tabbar`'s right edge
8. **Equal width and scrolling** (ADR-0031 / ADR-0035): with 3 sessions → the three tabs are equal width (within 1px), all 240px; `tabbar` is exactly as wide as the three tabs and doesn't scroll horizontally (`scrollWidth` = `clientWidth`); `new-session`'s left edge = the last tab's right edge + 12px; resize the window to 600×900 (`screen` unchanged, still `wide`) and create up to 5 → each tab is 120px (within 1px), `tabbar` overflows (`scrollWidth > clientWidth`), and the current (most recently created) tab is fully visible; **`new-session` lies entirely inside the top bar and is clickable (`elementFromPoint` hits it), its left edge = `tabbar`'s right edge + 12px**; scroll `tabbar` all the way left (`scrollLeft = 0`) → `new-session` doesn't move; (with `scrollLeft` at 0) mouse wheel down then up over the strip → `scrollLeft` first grows, then shrinks; resize the window back to 1440 → all 5 are 240px and nothing scrolls horizontally
9. **The gap isn't clickable** (ADR-0035 §2): two sessions, focus in the terminal; click the midpoint of the 12px between the last tab's right edge and `new-session`'s left edge → the session count doesn't change, the current session doesn't change, and focus stays in the terminal
10. **Settings is a centered dialog** (AC-5.11, ADR-0037 §4): with focus in the terminal, click `open-settings` → `settings` is centered horizontally and vertically (center within 1px of the visible area's center), 420px wide, with no grab handle; the `.term` rect and `__webterm.size()` don't change; press `Esc` → the sheet disappears and focus returns to the terminal's helper textarea (typing echoes)
11. **Terminal title as the name** (AC-4.4, ADR-0043): the harness shell reads the user's `.bashrc`, whose prompt may set a `user@host: dir` title — wait two seconds; the tab name is still `~` (titles set by the shell are ignored); run `bash -c 'printf "\033]0;E2E TITLE\007"; sleep 3'` → the tab name becomes `E2E TITLE`, with the index still there; when it exits back to the prompt → the tab name goes back to `~`

---

## E2E-42 A column change resends the snapshot (AC-2.22)

> `web/e2e/resync.spec.ts`. Hook `WebSocket` message and send.

1. Start a session, `emit.sh 300 0`, wait for it to finish
2. Resize the window from 1280 wide to 1000 wide (fewer columns) → the client sends `resize`, then receives a SNAPSHOT
3. Assert: after the snapshot, the terminal's column count equals the new `cols`; `line 00300` is still there, exactly once
4. Change only the height (`page.setViewportSize` with only height changed, simulating the on-screen keyboard) → a `resize` is sent, and **no** SNAPSHOT arrives
5. **Stable column count** (AC-3.11, [ADR-0033](../20-architecture/adr/0033-own-fit.md)): step the window width from 860 to 940 by 4px; at each width, wait for rows/cols to settle, then reduce only the height by 200 → each time `__webterm.size().cols` is the same as before the height change (with FitAddon it went 104 → 103 at 900px)

## E2E-43 Split UTF-8 loses no characters (AC-2.23)

> `web/e2e/utf8split.spec.ts`.

1. In the terminal, run `printf '\xe3\x80'; sleep 0.3; printf '\x82\xe2\x80'; sleep 0.3; printf '\xa6\xe2\x80'; sleep 0.3; printf '\x94END\n'` — `。`, `…`, and `—` are each split after their second byte, landing in different OUTPUT frames
2. Assert that terminal line reads `。…—END`
3. After a page refresh (snapshot path), the same line still reads `。…—END`

## E2E-44 Touch vertical drag becomes the wheel (AC-3.21)

> `web/e2e/touchwheel.spec.ts`, Pixel 5, real touch events via CDP (30ms per step, like a human hand). Hook `WebSocket.send` to record INPUT frames. Fixture `e2e/fixtures/scroller.py N`: alternate screen + mouse tracking (SGR), showing one screen of `L001`…`L300`, scrolling N lines per wheel event.

1. Run `scroller.py 5` (a program that scrolls 5 lines per step), wait for `L300` at the bottom
2. **One per row height**: drag the finger down 10 row heights → 10 ± 1 wheel events are sent, and the top line's number drops by about 50 (10 × 5, ±5); all are SGR wheel-up (`ESC[<64;col;rowM`) with row numbers within 1…`rows`; focus is unchanged (not a tap)
3. Drag the finger up 6 row heights → 6 ± 1 wheel events, all wheel-down (`ESC[<65;…M`), and the top line's number rises by about 30 (±5)
4. Quit, switch to `scroller.py 1`, and drag down 10 row heights → the top line's number drops by 10 ± 2 (with step 1, it follows the finger line by line)
5. **Horizontal drag of 120px** → no INPUT frames
6. Quit, run `printf '\033[?1049h\033[?1000h\033[?1006h'; sleep 60`, then `Ctrl+C` and `printf '\033[?1000l'` to turn off mouse tracking (still on the alternate screen) → drag down → no INPUT frames (no arrow keys sent, ADR-0024 §4)

## E2E-46 Sign out this device (AC-1.22)

> [ADR-0048](../20-architecture/adr/0048-sign-out.md)

1. Pair, open a second tab in the same context, store a theme preference
2. Settings → "Sign out this device" → the confirmation sheet; Cancel closes it and nothing changes
3. Sign out again and confirm → the pairing page says "Signed out"; `webterm.*` keys are gone from `localStorage`; the service worker is unregistered
4. The second tab is cut off within 5 seconds and goes to the pairing page
5. A request carrying the old cookie (captured before signing out) gets `401` on `/api/devices` and on the `/ws` upgrade
6. Reload → still the pairing page
7. Offline variant: with the WebSocket cut, the button only shows a toast; the device stays signed in

---

## Out of E2E scope (in the manual checklist)

- How a real CJK IME's candidate window behaves on a real device
- The real on-screen keyboard's open animation and layout
- Real network switches (Wi-Fi ↔ 4G ↔ tunnel)
- Real Let's Encrypt issuance
- Installing the PWA on a real device
- The Android system back button (E2E simulates it with `page.goBack()`)
- Haptic feedback

## E2E-45 Drag to reorder (AC-4.13)

> `web/e2e/order.spec.ts`. [ADR-0040](../20-architecture/adr/0040-session-order-drag.md).

1. **wide, mouse** (1440×900): create 3 sessions A B C → press C's tab with the mouse, drag it left past A's midline, and release → the tab order is C A B, the indexes (`tab-<sid>-idx`) read `[1] [2] [3]` in order, and the current session doesn't change (dragging doesn't switch); one `session.move{sid: C, before: A}` is sent, followed by `session.order{sids: [C, A, B]}`; press B, move 3px horizontally, release → just a click (switches to B), no `session.move`
2. **Esc mid-drag**: press A and drag right past B, press `Esc` without releasing → back in place; releasing sends no `session.move`
3. **The order lives on the agent**: reload the page → still C A B; open a second browser context (a second device) → its tab order is also C A B; drag again in the first (A to the end) → the second becomes C B A without reloading
4. **compact drag handle** (Pixel 5): on the same agent, open the drawer → each row has `session-<sid>-grip` at its right end; touch-press the last row's handle, drag it above the first row, and release → it becomes the first row, index `[1]`; press a row's body and drag vertically → the list scrolls and the order doesn't change
5. **Touch tablet** (iPad Mini): long-press a tab for 500ms, then without releasing move it past the adjacent tab and release → the order changed and `session-menu` doesn't appear; long-press and release in place → `session-menu` appears
6. **Keyboard switching follows the new order**: with order C B A and C current → `Ctrl+Shift+↓` goes to B

## E2E-47 One session, a browser and `webterm attach` (AC-1.23, AC-4.14)

> `web/e2e/attach.spec.ts`. [ADR-0050](../20-architecture/adr/0050-ssh-attach.md). `webterm attach` runs under `e2e/fixtures/ptyrun.py COLS ROWS -- cmd…`, which gives it a PTY of a set size and relays stdin and stdout, as `ssh -t` would. Focus can't be taken away from a page under Playwright, so the focus rules are covered by UT-claim-1.

1. Context A (1280×800) has the only session; run `stty size` → A's rows and cols
2. Context B (a second device, 900×600) opens the same session → its `subscribe` sets the size: A's view of the session size (`__webterm.sessionSize()`) becomes B's within 2 seconds, and A sends no `resize` in response
3. In A, type `stty size` and Enter → A sends `resize` **before** the INPUT frame; the output is A's rows and cols
4. Start `webterm attach 1` under a 100×30 PTY → its output shows the session's prompt and history; A's view of the session size becomes 100×30
5. Type `stty size` and Enter into attach → `30 100` appears in attach's output and in A
6. In A, type `echo from-browser` and Enter → A claims its size back; attach's output shows `from-browser`
7. Write a CPR reply (`ESC [5;1R`) to attach's stdin → the session keeps A's size; then a keystroke (`Ctrl+U`) in attach → the size becomes 100×30 again
8. Close attach's stdin (the wrapper hangs it up, like ssh closing) → attach exits 0; the session is still in A's list and still takes input
9. `webterm attach --list` (no PTY) prints `1  <name>  ~` and exits 0

## E2E-48 Sending files (AC-3.23, AC-8.7)

> `web/e2e/uploads.spec.ts`. [ADR-0051](../20-architecture/adr/0051-send-files-to-a-session.md). The harness starts the agent with `TMPDIR` set to a fresh directory, so uploads land in `<that>/webterm-<uid>/uploads/`. Hook `WebSocket.send` to record INPUT frames and concatenate them per step. The E2E bash has bracketed paste enabled, so a pasted path arrives as `ESC[200~<path>ESC[201~` and sits on the command line without running. `Ctrl+U` clears the line between steps.

1. **Text page** (Pixel 5): click `toggle-text` → `text-upload-file`'s icon lies inside `textinput`'s rect, its right and bottom edges within 4px of the box's; `textinput`'s right edge is 6px from `extrakeys`' right edge (no column beside it), it still has a border on all four sides and lies inside `extrakeys` with a gap on every side; `__webterm.size()` and `resizes()` are unchanged
2. **Pick one file**: fill `textinput` with `DRAFT`; tap `text-upload-file` → `textinput` keeps focus; choose one PNG named `shot 1.png` → within 5 seconds the INPUT frames for this step are exactly `ESC[200~` + path + `ESC[201~`, with no `0d`; the path is absolute, matches `<tmp>/webterm-<uid>/uploads/shot-1-[0-9a-f]{6}\.png`, and the file there has the PNG's bytes and mode `0600`; `textinput.value` is still `DRAFT`
3. **Two files keep their order**: set `upload-input` to `a.png` then `b.txt` (one pick) → two separate bracketed pastes, the first path ending in `.png` and starting with `a-`, the second ending in `.txt`
4. **Busy**: hold the upload request with `page.route` → while it is held, `text-upload-file` has `data-busy="true"`; release it → the path is pasted and `data-busy` goes back to `false`
5. **Too large**: set `upload-input` to a 21 MiB file → a toast mentioning `20 MB`; no INPUT frame; nothing new in the upload directory, no `.part` left
6. **Tab bar** (1440×900, mouse): `upload-file` is in the top bar between `new-session` and `conn-dot`, its SVG the same size as `open-settings`'s, vertical centers within 0.5px; clicking it opens a file chooser (`page.waitForEvent('filechooser')`); choosing a PNG → the path is pasted into the current session
7. **Paste a screenshot**: on the terminal's helper textarea, dispatch a `paste` event whose `clipboardData` holds one `image/png` file and no text → the path is pasted (bracketed); then dispatch a `paste` with only `text/plain` `echo PASTED` → the INPUT frames are the bracketed text `echo PASTED`, and no upload request was made
8. **Drop**: dispatch `dragenter` / `dragover` with a `DataTransfer` holding a file over `.term` → `.stage` has `data-drop="true"`; dispatch `drop` → the path is pasted, `data-drop` is gone, and the page URL hasn't changed
9. **The target is fixed at pick time**: two sessions A and B, A current; hold the upload, pick a file in A, switch to B, release → the bracketed path appears only in A's INPUT frames
