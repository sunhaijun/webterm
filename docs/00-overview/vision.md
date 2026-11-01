# Vision

> Status: Accepted

## In one sentence

**A single Go binary that turns a remote server's shell into a web app that works well on phone, tablet and desktop, and never loses your place when the network drops.**

## The problem

webterm comes from one workflow: local terminal → SSH → remote server → an editor or AI agent running for hours. That workflow has three problems, every day.

### 1. Connections drop

Switching networks, the subway, closing the laptop lid, a Wi-Fi hiccup — SSH drops. Either your place is gone, or you re-attach and wait for a redraw. Several times a day.

### 2. Input is painful, especially CJK

IME in a terminal is miserable: the candidate window is misplaced, the cursor jumps, wide characters misalign, multi-line text can't be edited, shortcuts fire by accident. Writing a longer passage in Chinese (a commit message, a prompt for an AI agent) is close to impossible.

### 3. Reading is painful

Scrolling back means tmux copy-mode. On a phone the visible area is too small to use, and rotating the screen makes a mess.

## Goal: not "a terminal in a web page"

`ttyd`, `wetty` and Shell In A Box put xterm.js in a page and pipe the PTY over a WebSocket. They answer "can I open a terminal in a browser?". **webterm answers "is the terminal pleasant to use?".**

webterm treats the terminal as a **data source**, not a UI to reproduce, and designs the interaction around it:

| | Typical web terminal | webterm |
|---|---|---|
| Disconnects | Reconnect = new session / full redraw | Short drops **replay only the missing bytes** and the screen keeps growing; long drops and page reloads keep the screen too — the agent holds the terminal state and can produce a full snapshot at any time |
| Input | Keys go straight to the PTY; IME is left to xterm.js | Keys go straight to the PTY, but **IME composition has fallbacks and input is never silently dropped**; for long CJK text, switch to the **text page**, type in a native text box, send once |
| Sessions | One connection, one terminal | The agent manages many sessions; they keep running in the background and show unread indicators |
| Mobile | Pinch-zoom and cope | **Termux-style UI**: full-screen terminal + two fixed rows of extra keys, on-screen keyboard aware, PWA; session drawer at the bottom on phones, tab bar on top on desktop and tablet |

## Design principles

### 1. One binary is the whole service

No reverse proxy, no database server, no tunnel process, no SSH, no tmux.

```
scp webterm user@server:
./webterm serve --domain term.example.com
# the terminal prints a QR code → scan it with your phone → done
```

This is about more than easy deployment. It means **the whole system can run end-to-end in CI**, including cutting the network to test reconnects. Any external component in the path would make that test incomplete.

### 2. Disconnects are normal, not exceptional

The design does not assume a stable connection:

- Server-side sessions **do not depend** on a client connection.
- Output carries sequence numbers; a reconnect resumes from a sequence number instead of redrawing.
- Input is acked; unacked keystrokes are resent after reconnecting.
- While the client is away, sessions keep running and buffers keep filling.

**The only thing the user should notice about a disconnect is the status indicator blinking.**

### 3. Few, fixed controls

The terminal is the interface. UI elements exist only for what the on-screen keyboard and touch can't do — `ESC`, `CTRL`, arrow keys, switching sessions, entering a whole paragraph of CJK text — and they **stay in fixed positions regardless of context**. After a few presses you know where they are and stop looking before you tap.

This is why Termux works, and it is what webterm concluded after eight iterations of context-dependent UI ([ADR-0025](../20-architecture/adr/0025-termux-style-ui.md)).

## What success looks like

A year from now, webterm has succeeded if:

1. **A phone is a real development terminal.** On a commute you can actually change code, read logs and restart services — not just get by in an emergency.
2. **You stop noticing the connection.** Open the browser and it's there, like a local app.
3. **CJK input is smoother than in a local terminal.** Long prompts and commit messages no longer need an editor and a paste.

## Related

- What we deliberately don't do: [`non-goals.md`](non-goals.md)
- Terms: [`glossary.md`](glossary.md)
- Requirements: [`../10-requirements/user-stories.md`](../10-requirements/user-stories.md)
