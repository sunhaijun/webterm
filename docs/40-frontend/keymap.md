# Shortcuts and key mapping

> Status: Accepted. UI decisions: [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md).

## Constraints

In direct input **every key must be able to reach the PTY**, so app shortcuts can only use combinations terminal programs don't.

| Modifiers | Usable by the app? | Why |
|---|---|---|
| `Ctrl+<letter>` | ❌ | Terminal control codes (`Ctrl+C`, `Ctrl+D`, `Ctrl+R`, `Ctrl+K`…) |
| `Alt+<letter/digit>` | ❌ | Meta in TUIs (emacs, vim, tmux prefix) |
| `Ctrl+Alt+<letter>` | ❌ | Same as AltGr on Windows and European layouts, so it eats typed characters (Termux uses it; we don't) |
| `Ctrl+<digit>` | ❌ | Browser tab switching |
| `Cmd+<letter>` (macOS) | ⚠️ Partly | Mostly taken by the browser |
| **`Ctrl+Shift+<letter>`** | ✅ | Not a valid terminal control code; programs never receive it |

**App shortcuts use `Ctrl+Shift+*` only, no exceptions.** `Ctrl/Cmd+F` and `Ctrl/Cmd+K` aren't intercepted; they go to the browser or the terminal (readline's `Ctrl+K` deletes to end of line).

Keeping shortcuts **few** is deliberate: there are few actions, and all of them are on screen.

## App shortcuts

Intercepted with xterm's `attachCustomKeyEventHandler` (returning `false` keeps the key out of the PTY). They also work while the text page has focus.

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+Enter` | New session |
| `Ctrl+Shift+W` | Close the current session (rules in [session-ux.md](session-ux.md)) |
| `Ctrl+Shift+↑` / `↓` | Previous / next session (wraps around) |
| `Ctrl+Shift+B` | `compact`: open / close the session drawer. `wide`: nothing |

**Taken by browsers, unusable**: `Ctrl+Shift+T/N` (new tab / window), `Ctrl+Shift+P` (Firefox private window), `Ctrl+Shift+H` (Firefox library).

**`Ctrl+Shift+W` is a known compromise**: browsers use it to close the window. A standalone PWA can intercept it; a regular tab can't. The PWA is the recommended setup; Close in the session menu and the ✕ on a tab are the fallbacks.

## Keys to bytes

In direct input almost everything is left to xterm.js's `onData`, which already implements the standard mapping correctly. Extra keys ([input.md](input.md#extra-keys-ac-318)) send **exactly** the same bytes as a physical keyboard, from the same table (`web/src/keys/keymap.ts`):

| Key | Bytes |
|---|---|
| `Ctrl+A`…`Ctrl+Z` | `0x01`…`0x1a` |
| `Ctrl+C` | `0x03` |
| `Ctrl+D` | `0x04` |
| `Ctrl+[` / `Esc` | `0x1b` |
| `Ctrl+\` | `0x1c` |
| `Ctrl+]` | `0x1d` |
| `Backspace` | `0x7f` (DEL, not `0x08`) |
| `Tab` | `0x09` |
| `Enter` | `0x0d` (CR) |
| `↑ ↓ → ←` | `ESC [ A/B/C/D`; **in application cursor key mode (DECCKM)** `ESC O A/B/C/D` |
| `Home` / `End` | `ESC [ H` / `ESC [ F`; in DECCKM `ESC O H` / `ESC O F` |
| `PgUp` / `PgDn` | `ESC [ 5 ~` / `ESC [ 6 ~` |
| `Delete` | `ESC [ 3 ~` |
| `Insert` | `ESC [ 2 ~` |
| `F1`–`F4` | `ESC O P/Q/R/S` |
| `F5`–`F12` | `ESC [ 15/17/18/19/20/21/23/24 ~` |
| `Alt+<char>` | `ESC` + char |
| `Shift+Tab` | `ESC [ Z` |

DECCKM is read from `term.modes.applicationCursorKeysMode` **on every keypress**, never cached: programs reset it when they exit.

### Sticky modifiers on the extra keys

When CTRL / ALT is armed on the extra keys ([input.md](input.md#behavior)), the next key combines as follows:

| Next key | CTRL | ALT |
|---|---|---|
| Letters `a`–`z` (either case) | `0x01`–`0x1a` | `ESC` + char |
| `[` `\` `]` `^` `_` | `0x1b` `0x1c` `0x1d` `0x1e` `0x1f` | `ESC` + char |
| `@` / space | `0x00` | `ESC` + char |
| `?` | `0x7f` | `ESC` + char |
| Other printable characters | Unchanged | `ESC` + char |
| Arrows / `HOME` / `END` / `PGUP` / `PGDN` | xterm's modifier encoding, e.g. `ESC [ 1 ; 5 A` | e.g. `ESC [ 1 ; 3 A` |
| `ESC` / `TAB` | Unchanged | `ESC` + byte |

With both armed, apply CTRL first, then prefix `ESC`.

## Paste

`onPaste` is left to xterm: wrapped in `ESC[200~ … ESC[201~` if the other side enabled bracketed paste (`?2004h`); newlines become `CR`.

## Customization

**App shortcuts aren't customizable.** There are fewer than ten, all non-conflicting `Ctrl+Shift+*`; a settings UI would cost far more than it's worth.

A customizable extra-key layout is planned for m9 ([ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) §2).
