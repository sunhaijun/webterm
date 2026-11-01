# ADR-0027 Text page: Enter sends and submits

Status: Accepted (2026-10-31). **Revises [ADR-0025](0025-termux-style-ui.md) §3** on what Enter does and how content is sent; rewrites AC-3.19 / US-3.1. How the text page is opened, its height, the field's attributes, IME handling, and staying on the text page after sending are unchanged.

## Context

ADR-0025 copied Termux's Enter semantics: with content, send only the content, no carriage return; an empty Enter sends `\r`. The idea was to drop a paragraph of Chinese into claude's input box, finish editing it there, and submit with an empty Enter.

After m8 shipped, the feedback was that sending to the terminal didn't press Enter. The text page is mostly used to write prompts for claude / codex, and a finished prompt is meant to be submitted. An extra empty Enter after every chunk is one more step, and an easy one to forget.

## Decision

### 1. What Enter does

| Situation | Behavior |
|---|---|
| IME composition in progress (`isComposing` or `keyCode === 229`) | Ignore; the IME uses it to pick a candidate (unchanged) |
| Field has content | **`term.paste(content)`, immediately followed by `term.input('\r', true)`**; clear the field |
| Field is empty | Send `\r` (unchanged) |

Enter never inserts a newline into the field, and after sending you stay on the text page with focus where it was (both unchanged).

### 2. Content always goes through `term.paste()`, then `\r` is typed separately

`term.paste()` does two things: it converts newlines to `CR`, and if the remote side enabled bracketed paste (`?2004h`) it wraps the content in `ESC[200~ … ESC[201~`; otherwise it sends it as is. The `\r` that follows is a separate `onData`. Both happen inside the Enter `keydown` dispatch and leave through the same exit, so `inputStats` counts them and the replay gate judges them as usual ([ADR-0020](0020-input-never-silently-dropped.md)).

**Why `\r` can't be appended to the content in one write**: measured on 2026-10-31 with a pty against claude 2.1.316, sending a 330-character Chinese prompt several ways:

| How it was sent | Submitted? |
|---|---|
| `content\r` in one write (how the old Composer sent a single line) | **No**: the whole block is treated as a paste, the `\r` is swallowed, and the text stays in the input box |
| `content`, then `\r` after 15 / 50 / 150 ms | Yes |
| `ESC[200~contentESC[201~\r` in one write | Yes |
| Bracketed paste, then `\r` after 50 ms | Yes |

Short content (`PROBE hello`) submits even in one write, so the problem only shows up with long prompts, which is exactly what the text page is for.

The bracketed-paste end marker separates "content" from "Enter" at the byte level, so the program doesn't have to guess from timing and we need no timer. claude, codex, bash 5.1+ readline and zsh all enable bracketed paste. A program that doesn't receives the raw content plus `\r`: in cooked mode the kernel line discipline processes it byte by byte, and readline also reads byte by byte, so `content\r` still means "type a line and press Enter".

### Rejected alternatives

- **Type the content, wait, then send `\r`.** It works, but correctness rests on timing. A resend after reconnect merges the two frames into one write (back to the failing row above); network jitter shrinks the gap; and we never measured codex's paste-burst window (it won't start offline). Bracketed paste needs none of these assumptions.
- **Keep "send without Enter" and add a "send and Enter" button.** The text page is a single textarea; another button would squeeze it, and users would have to remember which button does what. To edit before submitting, tap the terminal and type there.
- **Long-press Enter = no carriage return.** That was the old hidden gesture, which [ADR-0025](0025-termux-style-ui.md) removed: primary entry points must be visible, gestures are only shortcuts.

## Consequences

- The flow "send into claude's input box, keep editing there, then submit with an empty Enter" is gone. Finish editing on the text page, then send.
- With bracketed paste enabled, even single-line content arrives as a **paste**, not a series of key presses. A few interfaces that react to single keys (`y/n` prompts, numbered menus) may not treat a paste as a key press. Type those directly in the terminal or use the extra keys.
- Exited session: the content is discarded as before, and the following `\r` closes the session, consistent with the "press Enter to close" line (AC-4.5).
- AC-3.19, US-3.1, the text page section of input.md, E2E-40 ④⑤⑦ and UT-textinput-1 are rewritten.
