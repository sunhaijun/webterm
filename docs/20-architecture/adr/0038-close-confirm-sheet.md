# ADR-0038 Close confirmation uses our own overlay, not the browser's `confirm()`

Status: Accepted (2026-10-31). Revises [session-ux.md, Closing a session](../../40-frontend/session-ux.md#closing-a-session). The two overlay forms follow [ADR-0037](0037-settings-theme-and-font-size.md) §4.

## Context

Closing a running session asks for confirmation. It used `window.confirm()`, and the user asked for something more polished, for example a bottom sheet like the session list on narrow screens.

The browser dialog has other problems:

- Its look is up to the browser, unlike the rest of the UI, and it ignores the theme setting.
- On phones it appears mid-screen, with both buttons far from the thumb.
- It blocks synchronously: while it's open, all page JS stops, including WebSocket message handling.
- Its title shows the site address ("xxx says"), which reads like a system warning.

## Decision

### 1. A confirmation overlay built on the `Drawer` primitive

Same forms as settings, by `compact` / `wide`:

| | `compact` (phone) | `wide` (PC / tablet) |
|---|---|---|
| Form | Bottom-anchored full-width sheet, like the session drawer | Centered dialog, width `min(420px, 100vw − 32px)` |

```
┌─────────────── ═══ ───────────────┐
│ Close "webterm"?                ✕ │
├───────────────────────────────────┤
│ Programs running in it will be    │
│ terminated.                       │
├───────────────────────────────────┤
│  ┌─────────────┐ ┌─────────────┐  │
│  │   Cancel    │ │    Close    │  │  Close in the warning color
│  └─────────────┘ └─────────────┘  │
│                                   │  bottom: max(16px, safe area)
└───────────────────────────────────┘
```

- `data-testid="close-confirm"`; buttons `close-cancel` and `close-ok`.
- The bottom row's spacing and button style match the session drawer's bottom row (ADR-0037 §5); the two buttons are equal width. "Close" uses `--err` for its text.
- The body is a single sentence saying programs in the session will be terminated, with no further explanation.
- **Focus starts on "Close"**: `Enter` confirms and `Esc` cancels, as with `confirm()`. Keyboard users press `Ctrl+Shift+W` then `Enter` without leaving the keyboard.
- Cancel the same ways any overlay closes: tap the backdrop, `Esc`, ✕, (sheet) swipe down, or "Cancel".

### 2. It can stack on top of the session drawer

On a phone, closing a session from the drawer stacks the confirmation on top of the drawer, which stays open: after confirming or cancelling, the user is still in the list.

- With two overlays open, **`Esc` closes only the top one**. On `Esc`, each `Drawer` first checks whether it's the last `.drawer` in the DOM and ignores the key if not.
- A backdrop tap can only reach the top overlay's backdrop.

### 3. Focus

Record where focus was before opening. After confirming or cancelling, return it if it was in the terminal (or the text page), or if the device is non-touch. When opened from the session drawer, don't return it (focus stays in the drawer).

On confirm, **return focus first, then send `session.close`**. When the agent replies `session.closed`, the client switches to a neighboring session, and whether that session gets focus depends on "was focus in the terminal" (AC-4.8). Sending first would leave focus on the body at that moment, and the user would be judged as not typing.

### 4. The session disappears before confirmation

While the overlay is open, the session may already be gone: closed from another tab, or the agent restarted. As soon as the session leaves the list, the overlay closes. sids are reused, so leaving it open could close a later session with the same number.

### 5. A closing session receives nothing, and its "unknown session" error isn't shown

The user also reported an "unknown session" toast appearing after closing a session from its tab.

The agent handles `session.close` in this order: **remove the session from the table, wait for the process to exit** (`SIGHUP`, then `SIGKILL` after at most 2 seconds), and only then broadcast `session.closed`. Meanwhile the client still thinks the session exists, and anything it sends gets `error{code: "unknown_session"}`, which the client showed as a toast. The most common source is **focus reports**: programs like tmux (`focus-events on`) and claude enable `DECSET 1004`, so the terminal sends `ESC [O` / `ESC [I` whenever it loses or gains focus. When the old `confirm()` dialog closed, focus returned to the terminal right inside that window. Tearing down the xterm instance blurs it and sends one more.

On the client:

- From sending `session.close` until `session.closed` arrives, the session is "closing": its input (typing, focus reports, mouse reports) and `resize` are not sent. When tearing down an xterm instance, mark it closing first.
- An `unknown_session` error for a session that is closing, or no longer exists locally, isn't shown: the session is going away and the message carries no information. For a session that exists locally and isn't closing, it's still shown (that's a real desync).
- When `Enter` triggers a button in the overlay, suppress the key's default action. Browsers fire `click` on `keydown`, focus then returns to the terminal, and the following `keypress` would land there as an extra Enter.

The agent's order doesn't change: `session.closed` carries the exit code, so it can only be sent after the process exits.

### Rejected alternatives

- **No confirmation, offer undo instead** (an "Undo" for a few seconds after closing). Closing sends `SIGHUP` then `SIGKILL`; the program is already dead and can't be brought back.
- **Close the session drawer first, then confirm.** After confirming, the user has to reopen the list.
- **Use a centered dialog on phones too.** The buttons are far from the thumb, and it doesn't match the session drawer.

## Consequences

- Adds AC-4.11 (including §5's closing state). E2E-11 ⑦, E2E-28 ① and E2E-41 ③ no longer listen for the browser's `dialog` event; they click `close-ok` / `close-cancel` and check the overlay's form.
- `Drawer` checks whether it's the top overlay before handling `Esc`.
- The controller gets a `closing` state; `window.confirm` is no longer used.
