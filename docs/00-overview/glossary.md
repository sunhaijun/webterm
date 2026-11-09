# Glossary

> Status: Accepted

Use these terms in docs and code. Don't invent synonyms.

## Components

| Term | Meaning |
|---|---|
| **agent** | The webterm binary running on the target server. It serves static assets, authentication, the WebSocket terminal stream and session management. "Server" in these docs means the agent. |
| **client** | The browser SPA, served by the agent via `go:embed`. |
| **machine** | One agent as the page sees it: its origin (scheme, host, port). The page's **own machine** served it; other machines on the same site (subdomains of one domain) can be added to its list and switched to ([ADR-0062](../20-architecture/adr/0062-several-machines.md)). |
| **site** | Scheme + registrable domain (eTLD+1, from the Public Suffix List), the unit of `SameSite`: `https://a.example.com:8443` and `https://b.example.com` are the same site, different origins. An IP address is a site of its own. |
| **bound origin** | `devices.origin`: the page origin a device was paired from when that wasn't the agent's own. Requests with that device's cookie and an `Origin` header must come from the agent's own origin or this one. |
| **terminal emulator (agent-side)** | One emulator per session (`internal/vterm`, wrapping tuios.dev/vt). It consumes all PTY output and can export a snapshot at any time. xterm.js in the browser only displays ([ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)). |

## Sessions and data flow

| Term | Meaning |
|---|---|
| **session** | On the agent: a PTY + the shell process running on it + its output ring buffer + its terminal emulator. **Note**: sessions do not survive an agent restart. |
| **sid** | Session id, `uint16`, unique within an agent process; reallocated from scratch after a restart. |
| **ring buffer** | The last N bytes of raw output each session keeps in memory (default 256 KiB), used only for incremental resume. Memory only, never on disk. |
| **out_seq** | Output sequence number: how far into the session's cumulative PTY output, in bytes, the client has received. Not a message count. The agent does not rewrite the output stream. |
| **in_seq** | Input sequence number: **cumulative bytes the client has sent the agent** for this session. |
| **in_ack** | Cumulative input bytes the agent has actually written to the PTY. Tracked per `(client_id, sid)` and survives reconnects. The client trims its resend queue up to it. |
| **base_seq** | The `out_seq` at which the ring buffer's retained content starts. If the client's `out_seq < base_seq`, the gap can't be filled incrementally and the agent sends a snapshot instead. |
| **incremental** (resume) | The client's `out_seq` is still inside the ring buffer window, so the agent resends the bytes after it verbatim. Byte-for-byte continuous (AC-2.1). |
| **snapshot** | The agent-side emulator's full state at some `seq`: current screen + up to 2000 lines of history + modes / pen / cursor and so on, serialized as bytes any xterm can consume and sent in `SNAPSHOT` frames. Used on first open, page reload, falling out of the window, and column changes. Not counted in `out_seq`. |
| **subscribe** | The client subscribes to live output only for the **visible** session. Unsubscribed sessions keep running on the agent and keep feeding the emulator; switching back resumes incrementally or with a snapshot. |
| **client_id** | Identity of one page load, held in memory only: stable across reconnects, new on every reload. The key for input accounting. |
| **instance_id** | Random id of the current agent process run. Detects "the agent restarted", since `sid`s are reallocated after a restart. |

## UI

| Term | Meaning |
|---|---|
| **form** | The two UI forms, by device: `compact` (phone, screen short side < 600px) and `wide` (desktop, tablet). The form only decides how sessions are switched, and it never flips on a given device ([ADR-0025](../20-architecture/adr/0025-termux-style-ui.md)). |
| **session button** | On `compact`, the button in the top-left cell of the extra keys: a rounded box showing the session count, with a dot when another session is waiting for you ([ADR-0052](../20-architecture/adr/0052-waiting-for-you-replaces-unread.md)). Tapping it opens the session drawer. |
| **session drawer** | On `compact`, the bottom drawer opened by the session button: the session list + "New session". |
| **tab bar** | On `wide`, the row of session tabs fixed at the top of the terminal. Tabs share the width equally (120–240px) and scroll horizontally when they don't fit; `+` follows them, and the connection status dot sits at the far right. |

## Input

| Term | Meaning |
|---|---|
| **direct input** | Tap the terminal and type; keys and IME output go straight to the PTY one by one. Nothing is sent during composition; the result is committed at once on `compositionend` (AC-3.3). |
| **extra keys** | The two fixed rows of keys below the terminal on touch devices, in Termux's default layout: `ESC / - HOME ↑ END PGUP` / `TAB CTRL ALT ← ↓ → PGDN`. They don't change with the foreground program. `CTRL` / `ALT` are sticky. |
| **text page** | The second page of the extra-keys area: a native `textarea` with fully native IME. Enter sends the content followed by Enter, or `\r` alone when empty. Switch to it with ✎ or by swiping the key area left/right. Each session remembers its own page and draft, and they swap when you switch sessions (ADR-0036). |

## Authentication

| Term | Meaning |
|---|---|
| **pairing code** | A one-time, high-entropy string valid for 5 minutes. Generated when the agent starts or by `webterm pair`, and shown as a URL fragment plus a QR code in the terminal. |
| **device** | The record created by one successful pairing. Holds a long-lived session cookie. Can be revoked individually in the UI. |
