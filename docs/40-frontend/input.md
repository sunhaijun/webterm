# Input

> Status: Accepted. Decisions: [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) (Termux-style UI) and
> [ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md) (input is never silently dropped).
> Key-to-byte mapping and app shortcuts: [`keymap.md`](keymap.md).

## Overview

| | What it is | When to use it |
|---|---|---|
| **Direct input** | Tap the terminal; every key from the on-screen or physical keyboard goes through xterm to the PTY | Default. Typing commands, driving vim / less / claude |
| **Extra keys** | Two fixed rows of keys under the terminal, for keys the on-screen keyboard lacks | Phones and touch tablets |
| **Text page** | The second page of the extra-keys area: a native `textarea` where you write a passage, then send it | Long CJK text, writing prompts for claude |
| **Sending files** | The paperclip, a paste of files, or a drop: the file is uploaded and its path pasted into the session | Screenshots and photos for claude / codex |

There are no input modes. Direct input always works; the text page is just another page of the extra-keys area, and the two don't exclude each other: with the text page open, tapping the terminal still sends keys to the terminal.

---

## Extra keys (AC-3.18)

### When shown

Always on `compact`; on `wide` only with `pointer: coarse` ([layout.md](layout.md#form-ac-518)). Mouse-and-keyboard devices have no extra keys, and therefore no text page.

### Keys

The default layout is Termux's default layout, and it is **static**: it doesn't change with the foreground program, prompt state, or shell integration state.

```
left    key area (7 columns × 2 rows, equal width, no horizontal scroll)
┌────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┐
│ [3]│ ESC  │  /   │  -   │ HOME │  ↑   │ END  │ PGUP │
├────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│ ✎  │ TAB  │ CTRL │ ALT  │  ←   │  ↓   │  →   │ PGDN │
└────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┘
```

| Position | testid | Action |
|---|---|---|
| Session button `[3]` (`compact` only) | `open-sessions` | Rounded box showing the session count; opens the session drawer; shows a dot when another session is waiting for you ([session-ux.md](session-ux.md#waiting-for-you-ac-43)) |
| ✎ | `toggle-text` | Keys page ⇄ text page. The icon is a pencil coming out of a rounded box (SVG, [layout.md §Icons](layout.md#icons)) |
| ESC, /, - | `key-Escape` `key-Slash` `key-Minus` | Send the corresponding bytes |
| HOME ↑ END PGUP | `key-Home` `key-ArrowUp` `key-End` `key-PageUp` | Same |
| TAB | `key-Tab` | Same |
| CTRL ALT | `key-Ctrl` `key-Alt` | Sticky modifiers (below) |
| ← ↓ → PGDN | `key-ArrowLeft` `key-ArrowDown` `key-ArrowRight` `key-PageDown` | Send the corresponding bytes |

On `wide` the left column has only ✎, spanning both rows.

### Behavior

- **Geometry**: two 40px rows; 44px left column; seven equal-width key columns. At 393px wide each key is about 50px. **Never scrolls horizontally, at any width.**
- **Fire on release**: `pointerdown` only calls `preventDefault` (to keep focus); bytes go out on `pointerup`. A horizontal swipe across the keys to switch pages therefore doesn't press a key, and CTRL / ALT can tell a tap (arm) from a long press (lock).
- **Never steal focus**: every key calls `preventDefault` on `pointerdown`. Pressing an extra key doesn't show or hide the on-screen keyboard; focus stays in the terminal or the textarea.
- **Same encoding as a physical keyboard**: byte table in [keymap.md](keymap.md). Arrows and `HOME` / `END` follow application cursor key mode (DECCKM, `term.modes.applicationCursorKeysMode`): `ESC O A` / `ESC O H` when it's on, `ESC [ A` / `ESC [ H` when it's off.
- **Destination**: extra-key bytes take the same `onData` path as keystrokes (counted in `inputStats`, judged by the replay gate) and go to the current session's PTY. This holds with the text page open too: extra keys are always terminal keys and never edit the textarea.
- **Sticky CTRL / ALT**:
  1. Tap → armed (`data-sticky="armed"`), applies to the **next key only**.
  2. The next key can come from the extra keys or the on-screen keyboard. On the terminal's `onData` path, an armed modifier transforms a single character using the rules in [keymap.md](keymap.md) (CTRL: `a`–`z` → `0x01`–`0x1a`, etc.; ALT: prefix `ESC`), then disarms.
  3. **Long press** → locked (`data-sticky="locked"`) for several combos in a row (`Ctrl+C` then `Ctrl+D`); tap again to unlock.
  4. Armed and locked both use `--accent`, so you can see at a glance what the next key will turn into.

---

## Text page (AC-3.19)

### Switching

- Tap ✎ (the visible entry point), or swipe left/right over the keys (shortcut: horizontal travel > 40px and mostly horizontal).
- Both pages share one 80px slot, so switching **doesn't change the terminal's rows or columns** and sends no `resize`.
- Switching to the text page focuses the `textarea` (inside the click handler, or iOS won't show the keyboard). Switching back returns focus to the terminal if the `textarea` had it.
- Switching only changes which page the **current session** is on (below).

### Per session (AC-3.22)

Each session remembers two things ([ADR-0036](../20-architecture/adr/0036-text-page-per-session.md)): **which page** it's on (keys or text) and its **draft** (text in the textarea that hasn't been sent).

| When | What happens |
|---|---|
| Switching sessions (tab, drawer, `Ctrl+Shift+↑/↓`, auto-switch after closing the current session) | Save the textarea contents as the old session's draft; load the new session's page into the slot and its draft into the textarea |
| New session | Keys page, empty draft |
| Session closed / agent restarted | Its draft is discarded (all drafts, on restart) |
| Enter sends | Clears only the current session's draft |
| Page reload | Everything is lost (memory only) |

- **Focus**: if focus was in the terminal or the textarea before the switch (or the device has no touch), focus moves to the new session's input: the textarea if it's on the text page, the terminal if it's on the keys page ([session-ux.md](session-ux.md#focus-follows-the-session-ac-48)).
- **Switching mid-composition**: if the textarea is composing, blur it first (the IME commits the partial text into it), save the draft, then swap contents. Setting `value` directly makes the IME drop characters or commit them into the new session's draft.
- There's only one `textarea`; switching swaps its `value`.

### The textarea

```html
<textarea data-testid="textinput" rows="2" enterkeyhint="send"></textarea>
```

The paperclip (`text-upload-file`, [Sending files](#sending-files-ac-323)) floats over the box's bottom-right corner: no background and no column of its own, in `--muted`, so the box keeps its full width. Its touch target is 36px square, anchored to the corner of the slot; the icon sits 2px inside the box's border. Text that reaches that corner runs under the icon.

- Two rows tall, a **box bordered on all four sides**: 6px inset from the extra-keys slot, 1px border, rounded corners, accent-colored border on focus. The whole box fits inside the 80px slot, so the viewport or on-screen keyboard never cuts off its bottom border. Overflow scrolls inside the box.
- Font size ≥ 16px (so iOS doesn't zoom the page on focus).
- `autocorrect` / `autocapitalize` / `spellcheck` must be off (AC-3.10), or mobile keyboards turn `cd` into `Cd` and `ls` into `is`. **Set them with `setAttribute`, not just in JSX**: Chrome implements `autocorrect` as a boolean IDL property, so when the framework sees a property of that name it assigns the property; `"off"` is truthy, and the reflected attribute becomes `autocorrect="on"` — exactly backwards. E2E asserts the actual attribute value.

### Enter

| Case | Behavior |
|---|---|
| Composing (`event.isComposing`, or `keyCode === 229`) | Ignore; the IME uses it to pick a candidate |
| Textarea has text | Send the text **and press Enter**; clear the textarea |
| Textarea is empty | Send `\r` |

- Enter **never inserts a newline** into the textarea (`preventDefault` on `keydown`).
- One Enter submits a passage; no extra empty Enter needed ([ADR-0027](../20-architecture/adr/0027-text-page-enter-submits.md)).
- After sending, **stay on the text page with focus**, ready for the next passage. To go back to the terminal, tap ✎ or tap the terminal.
- Enter sends only to the **current session**; other sessions' drafts are untouched.

### How it sends

With text, two steps, both synchronous inside the Enter `keydown` dispatch:

1. `term.paste(text)`: newlines become `CR`; if the other side enabled bracketed paste (`?2004h`) the text is wrapped in `ESC[200~ … ESC[201~`, otherwise it's sent as is.
2. `term.input('\r', true)`: a separate Enter keystroke.

Both go through `onData`, so `inputStats` counts them and the replay gate judges them by origin as usual (the event being dispatched is the Enter `keydown`, which is in the user-input event list).

Sending from the text page **ignores sticky CTRL / ALT**: text and Enter go out unchanged, and an armed modifier isn't consumed. Sticky modifiers are for "the next key"; with ALT armed, Enter would become `ESC \r`, which claude treats as a newline, and the prompt would never submit.

**Don't append `\r` to the text in a single write.** When claude receives "long text + `\r`" in one write, it treats the whole thing as a paste, swallows the `\r`, and leaves the prompt sitting in its input box (measurements in ADR-0027). The bracketed-paste end marker separates text from Enter at the byte level; no timing gap is needed.

---

## Direct input

### Tapping the terminal (AC-3.20)

| Condition | A tap |
|---|---|
| The foreground program enabled mouse tracking (`term.modes.mouseTrackingMode !== 'none'`) | Goes to xterm: the browser synthesizes `mousedown` / `mouseup` from the touch, and xterm reports the click in the protocol the program asked for |
| Not enabled | **Toggles the on-screen keyboard**: if the terminal's helper textarea has focus, `blur()` (keyboard hides); otherwise `focus()` (keyboard shows) |

- `focus()` must run inside this touch's handler (`touchend` / `click`); iOS only shows the keyboard from a user gesture.
- A tap = moved < 10px and lasted < 300ms. A drag is scrolling ([layout.md](layout.md#rendering-adr-0026-7)), not a tap.
- On mouse devices, clicking the terminal is a normal xterm click (focus + selection); no toggling.

### Vertical drag (AC-3.21)

| Condition | Vertical drag |
|---|---|
| The foreground program enabled mouse tracking | **Becomes wheel events**: one per row height of finger travel ([ADR-0032](../20-architecture/adr/0032-drag-wheel-per-row.md)). Each is a synthetic `WheelEvent` dispatched to xterm (`deltaMode = DOM_DELTA_LINE`, `deltaY = ±1`, coordinates at the finger), which reports it in the protocol the program asked for. Finger down = wheel up (earlier content) |
| Not enabled, main screen | xterm's own touch scrolling through scrollback |
| Not enabled, alternate screen | Nothing; **no** arrow keys are sent ([ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md) §4) |

- The program decides how many lines one wheel step scrolls: tmux copy-mode scrolls 5, so one row of finger travel moves the content 5 lines. For line-by-line scrolling, change copy-mode's wheel binding to `-N 1` ([ADR-0029](../20-architecture/adr/0029-touch-drag-to-wheel.md) §3).
- At most 3 wheel events per `touchmove`; the excess is dropped, not carried over to the next frame (a fast flick must not flood the PTY, ADR-0029).
- Full-screen programs move at best one line per step, and the content trails the finger by one network round trip.
- A drag starts once travel reaches 10px (the tap threshold) and is mostly vertical. Travel accumulates from the start point, so the first 10px aren't lost. Horizontal drags do nothing.
- While converting, `touchmove` calls `preventDefault` so the browser doesn't also scroll natively.
- xterm 5.5 doesn't do this itself: when the program enables mouse tracking, its touch handler just returns, and browsers don't synthesize wheel events from drags ([ADR-0029](../20-architecture/adr/0029-touch-drag-to-wheel.md)).
- The synthetic `wheel` is `window.event` during its dispatch and is in the user-input event list, so it passes during replay (see [The replay gate](#the-replay-gate-ac-215-adr-0020) below).

### IME (AC-3.3)

xterm hosts the IME in an off-screen helper textarea (it can't be `display:none`, or there are no composition events). `RawIme` (`web/src/keys/raw.ts`) adds three things on top:

```
compositionstart  → composing = true; show the inline preview (ime-preview) at the cursor
compositionupdate → update the preview (send nothing)
compositionend    → composing = false; hide the preview; send event.data in one go
```

**The `keydown` handler must return immediately while `composing === true`.** This is what makes CJK input work.

**`composing` must have a fallback reset** ([ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md)). Its only normal exit is `compositionend`, which isn't guaranteed: switching IMEs, switching windows, or the OS swallowing the candidate window can all leave a composition half-done. If `composing` sticks at true, **that session's terminal input is dead for good**, and the user gets no clue why. Two fallbacks:

| Fallback | Why it's sound |
|---|---|
| `blur` | The element no longer has focus, so a composition can't be in progress |
| Capture-phase `keydown` with `isComposing === false` and `keyCode !== 229` | The browser itself says this key isn't part of a composition |

The `keydown` fallback **must be in the capture phase**: `RawIme` is constructed after `term.open()`, so a bubble-phase listener runs after xterm's own `keydown`, by which time the key has already been dropped as "composing".

The `blur` reset commits no text: the composition contents aren't available on `blur`. If the browser delivers a `compositionend` afterwards anyway, it commits as usual and nothing is lost.

The inline preview is absolutely positioned at xterm's cursor (`buffer.active.cursorX/cursorY` × cell size) and shows the uncommitted text, underlined.

### Directly inserted text (AC-3.14)

Composition is only half the story. The other half is **characters the on-screen keyboard inserts directly, without composing** — full-width punctuation on the iOS Chinese keyboard, for example. **xterm 5.5 misses these**:

| xterm path | Its condition | Why iOS full-width punctuation misses it |
|---|---|---|
| Read the character in `keydown` | `keyCode >= 48 && key.length === 1` | iOS reports **`keyCode` 0** for direct inserts |
| `input` event fallback | `!composed \|\| !_keyDownSeen` | A keydown already happened, so the whole `input` event is ignored |
| Textarea diff for `keyCode === 229` | Only when `keyCode` is exactly 229 | It isn't 229 |

Hence "comma doesn't work, period does": on the same keyboard one key reports `keyCode` 0 (neither path takes it) and the other reports 229 (the diff path takes it).

**Fix: `RawIme` handles non-composing `insertText` itself**: it sends on `beforeinput` and calls `preventDefault`. `preventDefault` keeps the character **out of the textarea**, so xterm's `input` path and 229 diff path never send it a second time. Three cases are left alone: composing (`isComposing`), any `inputType` other than `insertText`, and keys xterm already handled in `keydown` (it calls `preventDefault`, so there's no `beforeinput` at all).

**Dedup suppresses only the one copy another path already sent, and only once.** Duplicates happen in exactly two cases:

- After a `compositionend` commit, WebKit fires one more `insertText` with the same text.
- When xterm's `_keyPress` handles a printable character it doesn't call `preventDefault`, so the character still lands in the textarea and fires another `beforeinput`.

Only these two places **arm** the dedup (record the text just sent and when), and it **disarms right after suppressing one copy**. Text sent from `beforeinput` itself **doesn't arm it**: the same character right after is the user typing it again, not a duplicate. Dedup by "same text within a time window" would **silently eat** the second of two identical keystrokes — exactly what ADR-0020 forbids. The 120ms window is only how long an armed dedup stays valid.

### Paste

Paste from a physical keyboard (`Ctrl+Shift+V` / `Cmd+V`) goes through xterm's `onPaste`, wrapped in bracketed paste if the other side enabled it. On touch devices, paste will live in the long-press menu (m10, [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) §5).

A clipboard holding **files and no text** (a screenshot) isn't a text paste: it's sent as files ([Sending files](#sending-files-ac-323)). `Ctrl+V` without Shift still goes to the program as `0x16`, as before.

### The replay gate (AC-2.15, ADR-0020)

Two kinds of things arrive on `onData`, and they must be kept apart:

| Source | When it happens | Should it reach the PTY? |
|---|---|---|
| xterm's **automatic replies** to queries in past output (DSR / DA / `CSI ?u`) | Synchronously while `term.write()` parses | **Not** during replay: it isn't user input |
| User keystrokes, paste, extra keys, text page | Synchronously during the dispatch of a DOM input event | **Always** |
| The path of a file that just finished uploading ([Sending files](#sending-files-ac-323)) | Later, when the upload's request completes, inside `asUserInput()` | **Always** |

The test is **who produced it**, not **when**. Gating on "is this session replaying right now" also drops whatever the user is typing.

What counts as replay ([protocol §5.3](../30-protocol/websocket-protocol.md)): the write of a SNAPSHOT, and the incremental catch-up until `out_seq` reaches `catchup_to`. Snapshots contain no query sequences, so only the incremental catch-up can actually trigger automatic replies; the gate is active for snapshot writes anyway, so there's one rule with no special cases.

Implementation (`web/src/term/userinput.ts`): ask the browser **which event is being dispatched right now** — `window.event`. It points at the current event during dispatch and is restored as soon as dispatch ends:

```
onData(data):
  window.event?.type ∈ user-input events → pass (even during replay)
  else if inside asUserInput(fn)         → pass (even during replay)
  else if replayDepth > 0                → drop (automatic reply)
  else                                   → pass
```

`asUserInput(fn)` runs `fn` with a flag set, for user actions that complete outside an event dispatch. Today that is only the paste of an uploaded file's path, which happens when the upload finishes, seconds after the tap. Without it, an upload finishing during a reconnect's catch-up would lose its path silently ([ADR-0051](../20-architecture/adr/0051-send-files-to-a-session.md) §3).

User-input events: `keydown` `keypress` `beforeinput` `input` `paste` `compositionend` `compositionupdate` `pointerdown` `pointerup` `mousedown` `mouseup` `mousemove` `wheel`. `pointer*` covers the extra keys, which call `term.input()` synchronously during a pointer event dispatch; `mouse*` / `wheel` cover xterm's mouse reports when the program enabled mouse tracking, which also produce `onData` synchronously during that event's dispatch. Without them, extra keys pressed and terminal clicks made during replay would be dropped as automatic replies. When you add a user interaction that produces `onData` and should pass during replay, add its event type to this list; forgetting just means it's dropped during replay, which is no worse than before.

**No home-made time window**: xterm calls `preventDefault + stopPropagation` on keys it handles, so the bubble phase never sees them, and the window could only be closed by a timer — and timer tasks have no ordering guarantee relative to network tasks. This approach also covers two easy-to-miss cases: right after user input, xterm parses the next `write()` **synchronously** (that write was started by the WebSocket `message` event, whose `type` isn't in the list, so it's still blocked); and `setTimeout`-driven chunked parsing has no event being dispatched, so it's blocked too.

---

## Sending files (AC-3.23)

[ADR-0051](../20-architecture/adr/0051-send-files-to-a-session.md). A file goes to the agent with `POST /api/uploads` ([http-api.md](../30-protocol/http-api.md#uploads)), and its absolute path is pasted into the session, the way dragging a file onto a local terminal types its path. claude and codex turn a pasted image path into `[Image #N]`.

### Where files come from

| Entry | Where | What happens |
|---|---|---|
| Paperclip `text-upload-file` | Text page, over the text box's bottom-right corner (so on `compact`, and on `wide` with touch) | Opens the system file picker |
| Paperclip `upload-file` | `wide` tab bar, left of the connection dot | Same |
| Paste | Into the terminal or the text box, when the clipboard holds files and its `text/plain` is empty | The files are sent; the event is stopped (capture phase), so xterm and the text box get nothing |
| Drop | Anywhere on the page, when the drag carries files | The files are sent; the page never navigates to the dropped file. While files are dragged over the page, `.stage` has `data-drop="true"` (an accent outline) |

- Both buttons open the **same** hidden `<input type="file" multiple data-testid="upload-input">`, with no `accept` filter, from inside the click (iOS opens pickers only from a user gesture). Its value is cleared after each pick, so picking the same file twice works.
- Both buttons use `preventDefault` on `pointerdown`, like the other buttons in the extra keys and tab bar, so pressing one doesn't move focus. Picking files doesn't move focus either.
- A paste that holds any text is a text paste, files or not.

### Sending

1. The target is the session that was current when the files were chosen, pasted or dropped. It is recorded then, not when the upload finishes.
2. Files upload **one at a time, in order**. Each is pasted as soon as its upload succeeds, then the next starts.
3. The paste: `term.paste(path)` on the target session's terminal, inside `asUserInput()` and with the extra-key bypass set, so the replay gate passes it and sticky CTRL / ALT neither apply nor disarm. It goes through `onData` (bracketed if the program enabled it, counted in `inputStats`, resent after a reconnect, claims the size). **Only the path**, no space, no Enter, and one paste per file: codex treats two paths in one paste as text.
4. The text page's draft isn't touched; the path goes to the terminal, not the text box. Enter on the text page then submits the draft after the attachments.
5. While anything is uploading, both paperclips have `data-busy="true"` (accent, pulsing).

### Failures

Nothing is pasted, a toast says why, and the remaining files still go:

| Case | Toast |
|---|---|
| `413` | `<name> is too large (max 20 MB)` |
| Other HTTP error or network failure | `Upload failed: <name>` |
| The target session closed or exited before the upload finished | `Session ended; <name> not inserted` |

A `401` is a revoked device: the usual revocation handling takes over (AC-1.11).

---

## Troubleshooting: where input stops (AC-3.17)

The input path keeps per-stage counters, in production builds too:

```js
__webterm.inputStats()
// {
//   keydown:  {n: 12, agoMs: 900},    // capture-phase keydowns: a key really was pressed
//   toTerm:   {n: 12, agoMs: 900},    // of those, focus was on the terminal's helper textarea
//   data:     {n: 12, agoMs: 900},    // xterm onData on the user-input path (incl. extra keys and text page)
//   sent:     {n: 12, agoMs: 890},    // INPUT frames sent to the agent
//   gated:    0,                      // dropped by the replay gate (automatic replies; never user keys)
//   unackedBytes: 0,                  // sent but not yet acked by the agent; rising and never falling = not delivered
//   focus: 'xterm-helper-textarea',
//   verdict: 'All four stages OK: input reached the agent. …'
// }
```

**Read it stage by stage** and the break is obvious (`verdict` is computed from this table):

| Symptom | Break | Likely cause |
|---|---|---|
| `keydown` not rising | The key never reached the page | Focus is in another window / the OS ate it |
| `keydown` rising, `toTerm` not | Focus isn't on the terminal | Focus fell back to `body` after switching sessions / closing a sheet (AC-4.8); or focus is on the text page (that's fine; check `focus`) |
| `toTerm` rising, `data` not | Stuck in xterm | Composition state never reset (`composing` stuck at true); or an app shortcut caught the key |
| `data` rising, `sent` not | Never sent | Replay gate (check `gated`), or disconnected with a full offline queue |
| `sent` rising, `unackedBytes` never falls | Agent isn't acking | Zombie connection (AC-2.20), or the agent can't write to the PTY |
| **All four pass, the program still doesn't respond** | **Outside webterm** | The foreground program isn't reading stdin, or it's in another mode — most often **tmux copy-mode** ([ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md) §4); exit with `q` / `Esc` |

Two rules:

- **Compare the most recent occurrence, not totals.** Totals accumulate since page load, so successful input from before the stall keeps them high; `agoMs` (how long ago) tells you where the latest keystroke stopped.
- **The `keydown` counter must be in the capture phase.** xterm calls `preventDefault + stopPropagation` on keys it handles, so the bubble phase never sees them.
