# ADR-0053 Links and the clipboard on touch devices

Status: Accepted (2026-11-07). Adds AC-5.19 (links) and AC-5.20 (programs writing the clipboard). The protocol is unchanged; this is all in the page.

## Context

The main use is running claude and codex from a phone. Two things come up all the time: opening a URL the program printed (a pull request, a login link, a docs page) and copying its answer somewhere else. As of m16:

| | Desktop | Phone / tablet |
|---|---|---|
| A URL in plain text | Not clickable: no link detection | Not clickable |
| An OSC 8 hyperlink | Click → the browser's `confirm()` → a new window (xterm.js's default, http/https only) | Not clickable: a tap without mouse tracking is swallowed to toggle the keyboard; with mouse tracking (claude's full-screen renderer) it goes to the program as a click |
| Selecting text | The mouse selects; under mouse tracking a plain drag goes to the program and Shift+drag selects | Impossible: xterm.js has no touch selection |
| A program writing the clipboard (OSC 52) | Ignored: xterm.js has no handler | Ignored |

claude 2.1 has `/copy` ("Copy Claude's last response to clipboard (or /copy N for the Nth-latest)"), and its binary writes OSC 52 (`ESC ] 52 ; c ; <base64>`). With OSC 52 the page can put claude's answer on the phone's clipboard without any selection UI.

## Decision

### 1. One link detector

- **OSC 8 hyperlinks**: xterm.js's own, http and https only (`linkHandler.allowNonHttpProtocols` stays false).
- **URLs in text**: `term/links.ts` finds `http://` and `https://` runs in a **logical line**: rows joined while the next row is a soft wrap (`isWrapped`), so a URL wrapped across rows is one link. Trailing `.,;:!?'"` and a closing `) ] } >` without its opening partner are trimmed off the end. Nothing but http and https.
- The same function answers "which link is under this cell", so the desktop link provider and the touch tap share it.

### 2. Desktop: Ctrl/Cmd + click

- Hovering a link underlines it (xterm's link decoration). A plain click leaves links alone, so selecting and the program's mouse keep working. **Ctrl+click** (Cmd+click on macOS) opens the link in a new tab with `noopener`. OSC 8 links behave the same, replacing xterm's `confirm()`.
- Why a modifier: the terminal is a mouse surface for selection and for programs that track the mouse; opening a tab on a plain click would fire in the middle of selecting. VS Code's terminal and iTerm2 work the same way.

### 3. Touch: tap a link → Open · Copy

- A tap (the existing tap rule: under 10px of travel and 300ms, [input.md](../../40-frontend/input.md#tapping-the-terminal-ac-320)) on a URL in text shows a small popover next to it: the URL on one line, shortened in the middle when it doesn't fit, and two buttons, **Open** and **Copy**. Open opens a new tab from inside the click handler (iOS allows that); Copy writes the URL to the clipboard, also inside the gesture. A tap elsewhere, `Esc`, or switching sessions closes it.
- **The link check comes before the mouse-tracking check**: under claude's full-screen renderer a tap on a link opens the popover instead of being sent to claude as a click. Taps anywhere else are unchanged (keyboard toggle, or a click for the program).
- Two buttons rather than "a tap opens it": a tap meant to bring up the keyboard would throw you out of the app, and copying a URL to use somewhere else is as common as opening it.
- OSC 8 links whose text isn't the URL itself aren't found on touch: xterm.js 5.5 doesn't expose their ranges. They're rare in CLI output.

### 4. Programs write the clipboard: OSC 52, write only

- The page handles `OSC 52 ; Pc ; Pd`: `Pd` is base64, decoded as UTF-8 and written to the clipboard (`Pc`, the selection name, doesn't matter: a browser has one clipboard). **`Pd = ?` (a read) is ignored and never answered**: a program must not read the user's clipboard.
- **Only live output of the current session.** OSC 52 inside replayed bytes (catch-up, snapshot) is ignored, so reconnecting or switching back never overwrites the clipboard with something old; so is OSC 52 from a pinned session in the background.
- At most 1 MiB of decoded text; anything larger is ignored.
- `navigator.clipboard.writeText` needs a user gesture in iOS Safari and Firefox. The page tries it: on success a short "Copied" toast; on rejection a bar at the bottom with the start of the text and a **Copy** button, which writes inside the tap. A new copy replaces the bar; it goes away after copying, with its ✕, or after 30 s. `Esc` doesn't close it: the bar stays up while you keep working, and `Esc` belongs to the program (claude interrupts on it). The popover, which is in the way, does take `Esc`, before the terminal sees it.
- So in claude, `/copy` puts the answer on the phone's clipboard (one extra tap on iOS).

### 5. Not in this milestone

- Selecting arbitrary text on touch: m10, to be reworked as native selection over xterm's DOM rows.
- A copy shortcut on Linux / Windows desktops (`Ctrl+C` is `^C`, and `Ctrl+Shift+C` opens Chrome's inspector).

### Rejected alternatives

- **`@xterm/addon-web-links`.** It only works through xterm's hover-driven linkifier, so touch hit-testing would need a second detector anyway. One detector serves both.
- **A tap opens the link.** See §3.
- **Answering OSC 52 reads.** That hands the clipboard to any program, or anything that can print to the terminal.
- **OSC 52 in the agent** (the emulator's `ClipboardSet`). The clipboard is the browser's; the agent could only relay it, and background sessions would write it too.
- **Long-press for the link menu.** A hidden gesture where a visible one (the tap) already exists.

## Consequences

- AC-5.19, AC-5.20; [input.md](../../40-frontend/input.md#links-ac-519) gains "Links" and "Clipboard from programs"; the threat model gains OSC 52 (write only, current session, live output; clipboard poisoning by a program is possible and visible as the toast or bar).
- Tests: UT-links-1 (detection, wrapping, trimming, http/https only), UT-osc52-1 (decoding, reads ignored, size cap), E2E-49 (links on desktop and touch), E2E-50 (OSC 52: current session, replay ignored, the fallback bar).
- Manual checklist: tapping a link on an iPhone and an Android phone (Open lands in the browser, Copy pastes elsewhere); claude `/copy` on both (iOS shows the bar, Android copies directly).
