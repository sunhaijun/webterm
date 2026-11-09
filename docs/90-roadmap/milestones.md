# Milestones

> Status: Accepted

## Conventions

- **Branches**: `feat/<docs number>-<topic>`, named after the docs section the milestone implements. One worktree branch per milestone, PR to `main`, remove the worktree after merging. No development directly on `main`.
- **Order of work** in every PR: update the docs → write tests from the docs → implement → all tests green.
- **Exit criteria** (every milestone since m8, plus whatever the milestone adds): `go test ./...`, `npm test`, and `npm run e2e` green; ★ byte-level continuity on the incremental path (E2E-2) and screen-level consistency on the snapshot path both pass; `TestHandoffByteLevelContinuity` passes. Anything that needs a real device goes in the [manual checklist](../70-testing/manual-checklist.md).

## v0.1 goal

**Good enough to replace a daily SSH workflow**, not a tech demo. The bar: from a phone on a commute you can edit a file, read logs, and restart a service, and a flaky network never costs you your place.

## Completed

| Milestone | Branch | What shipped | Key docs |
|---|---|---|---|
| m0 | `feat/00-docs-baseline` | Docs baseline: requirements, acceptance criteria, ADRs, protocol contract, `CLAUDE.md` | [acceptance-criteria.md](../10-requirements/acceptance-criteria.md) |
| m1 | `feat/30-protocol-core` | Protocol and session core, no network or frontend: `internal/ringbuf`, `internal/protocol` + test vectors, `internal/session` on a real PTY, `internal/store`. Resume proven without a browser (`IT-resume-*`, `TestByteLevelContinuity`) | [websocket-protocol.md](../30-protocol/websocket-protocol.md), [ring-buffer.md](../50-backend/ring-buffer.md), [session-manager.md](../50-backend/session-manager.md), [storage-schema.md](../50-backend/storage-schema.md) |
| m2 | `feat/50-agent-serve` | A runnable service: HTTP routes and auth (including `/ws`), pairing codes + QR + device REST, WebSocket connection layer, autocert TLS + `--dev`, `doctor` / `pair` / `devices` / `version`, systemd unit, rate limiting / CSP / HSTS / log redaction | [auth-pairing.md](../60-security/auth-pairing.md), [http-api.md](../30-protocol/http-api.md), [ADR-0004](../20-architecture/adr/0004-acme-only-tls.md), [install.md](../80-ops/install.md), [systemd.md](../80-ops/systemd.md), [threat-model.md](../60-security/threat-model.md) |
| m3 | `feat/40-web-shell` | Frontend skeleton and seamless reconnect: Vite + TS + Preact, `go:embed`, `web/src/conn` (seq accounting, resend queue, backoff, heartbeat), connection status, Playwright fixtures. ★ E2E-2a byte-level continuity passes | [websocket-protocol.md](../30-protocol/websocket-protocol.md), [e2e-scenarios.md](../70-testing/e2e-scenarios.md#fixtures) |
| m4 | `feat/40-input-modes` | Key mapping, IME composition with inline preview, on-screen keyboard handling via `visualViewport`. Its Composer, mode state machine, and function-key bar were later replaced ([ADR-0025](../20-architecture/adr/0025-termux-style-ui.md)) | [input.md](../40-frontend/input.md), [keymap.md](../40-frontend/keymap.md), [layout.md](../40-frontend/layout.md) |
| m5 | `feat/30-shell-integration` | CWD reporting and session auto naming. Shell integration and command history were later removed; CWD now comes from `/proc` ([ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)) | [session-manager.md](../50-backend/session-manager.md#auto-naming-ac-44) |
| m6 | `feat/40-sessions-ux` | Multiple sessions, unread, subscriptions and pinning, theme, PWA + service worker. The three-layout design was later reduced to two forms (ADR-0025) | [session-ux.md](../40-frontend/session-ux.md), [layout.md](../40-frontend/layout.md) |
| m7 | `feat/40-commands` | Command history and quick commands, all later removed ([ADR-0022](../20-architecture/adr/0022-drop-command-palette.md), ADR-0025, ADR-0026). **v0.1.0 released** once the manual checklist passed on real devices | [manual-checklist.md](../70-testing/manual-checklist.md) |
| m8 | `feat/40-termux-shell` | Termux-style UI and agent-held terminal state, in one PR: two forms, static extra keys, text page, session drawer / tab bar, connection banner; `internal/vterm` snapshots, protocol v2 (`SNAPSHOT`), 256 KiB ring buffer, native browser output path; old UI, shell integration, and command history removed | [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md), [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md), [layout.md](../40-frontend/layout.md#form-ac-518), [input.md](../40-frontend/input.md#extra-keys-ac-318), [session-ux.md](../40-frontend/session-ux.md#switching-sessions-ac-410) |
| m11 | `feat/80-ops-install-simplify` | A new server takes "open the firewall + one command + scan": IP certificates (`--domain` accepts a public IPv4), `--acme-staging` removed, `doctor --acme`, `webterm install` with the embedded install.sh | [ADR-0044](../20-architecture/adr/0044-ip-address-certificates.md), [ADR-0045](../20-architecture/adr/0045-install-from-the-binary.md), [install.md](../80-ops/install.md) |
| m12 | `feat/00-open-source` | Ready for open source: English docs, comments and UI strings, Apache-2.0, guided install that waits for DNS and the cloud firewall, releases ship `install.sh` | [ADR-0046](../20-architecture/adr/0046-guided-install.md), [install.md](../80-ops/install.md) |
| m13 | `feat/60-sign-out` | Sign out a device from the device itself: `POST /auth/logout` revokes it and clears the cookie; "Sign out this device" in Settings clears the page's storage, service worker and caches | [ADR-0048](../20-architecture/adr/0048-sign-out.md), [auth-pairing.md](../60-security/auth-pairing.md) |
| m14 | `feat/50-ssh-attach` | `webterm attach` over SSH through `run/attach.sock`, speaking the same protocol; the session size follows the client in use (`session.updated{cols, rows}`, claims only on use) | [ADR-0050](../20-architecture/adr/0050-ssh-attach.md), [install.md](../80-ops/install.md#from-a-terminal-over-ssh) |
| m15 | `feat/40-uploads` | Send screenshots, photos and other files to a session from any device: `POST /api/uploads` to a private temp directory (deleted after 24 hours), the paperclip, paste and drop; the path is pasted into the session it was sent from | [ADR-0051](../20-architecture/adr/0051-send-files-to-a-session.md), [http-api.md](../30-protocol/http-api.md#uploads), [input.md](../40-frontend/input.md#sending-files-ac-323) |
| m16 | `feat/40-attention` | "Waiting for you" replaces the unread dot: the agent sets a per-session `attention` flag when the program signals it's your turn (title spinner → idle, a bell or desktop notification, a command of ≥ 10 s returning to the shell) and clears it on `session.seen` from the client in front of the user; tmux-specific guidance removed | [ADR-0052](../20-architecture/adr/0052-waiting-for-you-replaces-unread.md), [session-ux.md](../40-frontend/session-ux.md#waiting-for-you-ac-43), [websocket-protocol.md](../30-protocol/websocket-protocol.md#sessionseen) |
| m17 | `feat/40-links-clipboard` | Links and the clipboard on touch: one URL detector for Ctrl/Cmd+click and a tap popover (Open · Copy), checked before mouse tracking; OSC 52 write-only from the current session's live output, so claude's `/copy` reaches a phone | [ADR-0053](../20-architecture/adr/0053-links-and-clipboard.md), [input.md](../40-frontend/input.md#links-ac-519) |
| m18 | `feat/40-input-menus` | A last key column: frequent input from the program's own history (`GET /api/frequent`) and combo keys for the program in front (`program`: shell / claude / codex / other); m10 replanned around a copy view | [ADR-0054](../20-architecture/adr/0054-frequent-input-and-combo-keys.md), [input.md](../40-frontend/input.md#the-last-column-ac-324) |
| m19 | `feat/80-ops-setup` | `webterm setup [--check] [--yes]` checks and adds the settings claude, codex and the shell need (claude's `preferredNotifChannel`, codex's `[tui]` notifications, history as you go) with minimal line inserts and backups; a first install offers it | [ADR-0055](../20-architecture/adr/0055-webterm-setup.md), [install.md](../80-ops/install.md#set-up-claude-and-codex) |
| m20 | `feat/40-collapse-keys` | The extra keys collapse with a swipe right into a corner button (tap it or swipe left along the bottom to restore; one resize each way); every control acts only when released in place; pages switch with vertical swipes | [ADR-0056](../20-architecture/adr/0056-collapsible-extra-keys.md), [input.md](../40-frontend/input.md#collapsing-the-extra-keys-ac-326) |
| m21 | `feat/40-command-strip` | ⌘ becomes a strip of claude's / codex's own commands in your order, with an editor (drag, hide, rename, add, reset, refresh); claude's list from its `init` message, cached by executable and re-probed after upgrades; arrangement in `~/.config/webterm/commands.json`, shared by devices; ⟲ became recent history (removed again in m22) | [ADR-0057](../20-architecture/adr/0057-command-strip-and-history.md), [http-api.md](../30-protocol/http-api.md#commands) |
| m22 | `feat/40-enter-key` | The last key column becomes ⌘ over ↵ (Enter, for prompts and pickers with the keyboard down); the command strip has two rows, filled column by column; the history list, `GET /api/history` and setup's shell item removed | [ADR-0058](../20-architecture/adr/0058-enter-key-and-two-row-strip.md), [input.md](../40-frontend/input.md#the-last-column-ac-324) |
| m23 | `feat/40-files` | A file browser in stacked sheets like the session drawer, in the current session's folder: previews (images, video, audio, text, Markdown rendered with a text size), Share or Download, Send to session, upload without overwriting, new folder / rename / delete, new session here; maximize on wide screens. `/api/fs/*` with the agent user's rights; served files never run on webterm's origin | [ADR-0059](../20-architecture/adr/0059-files.md), [ADR-0060](../20-architecture/adr/0060-files-maximize-and-markdown.md), [ADR-0061](../20-architecture/adr/0061-markdown-text-size.md), [http-api.md](../30-protocol/http-api.md#files) |
| m24 | `feat/40-machines` | Several machines in one page: servers on subdomains of one domain share the installed page, which talks to one at a time, directly, with that server's own cookie; devices bound to the page origin they paired from, CORS and CSP within the site; the machine button and Machines sheet (add with an address and 16 digits, switch, remove, sign out everywhere). The installer asks for the HTTPS port (Enter = 8443); CLI flags may follow a command's arguments | [ADR-0062](../20-architecture/adr/0062-several-machines.md), [ADR-0063](../20-architecture/adr/0063-installer-asks-for-the-port.md), [session-ux.md](../40-frontend/session-ux.md#machines-ac-107) |

Released together as **v0.5.0** (2026-11-08): m14–m18.

Released together as **v0.6.0** (2026-11-08): m19–m22.

Released as **v0.7.0** (2026-11-08): m23.

Released as **v0.8.0** (2026-11-08): m24.

## In progress

### m25 · `feat/80-ops-uninstall`

Installer fixes and `webterm uninstall`. A new `--domain` keeps the rest of the previous install (ports, channel, prefix), and config and `install-state` are written only once the install worked ([ADR-0064](../20-architecture/adr/0064-new-address-keeps-the-install.md)). `webterm uninstall` removes the service, the binary, config, data and sent files after one question, leaves firewall rules, lingering and claude/codex settings with the command for each, and works inside a webterm session ([ADR-0065](../20-architecture/adr/0065-uninstall.md)). AC-1.19, AC-1.26; real-device checks in the manual checklist ("Deployment").

## Planned

### Web Push and the app badge

Builds on m16: a push notification and a badge count when a session starts waiting for you while no page is open.

m9 and m10 build on m8 and are independent of each other.

### m9 · `feat/40-termux-keys`

Extra-key enhancements (ADR-0025 §2): swipe-up secondary keys (default `-` → `|`, `/` → `~`), auto-repeat on long press (`↑ ↓ ← → PGUP PGDN`, every 60ms after 400ms), customizable layout. Docs: [input.md](../40-frontend/input.md).

### m10 · `feat/40-termux-gestures`

Gestures (ADR-0025 §5, §6): pinch to change font size (CSS preview while pinching; on release set `fontSize`, `fit()`, and send a `resize`; same value as the font size setting, [ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md)); selecting text on touch (below); keep screen on; vibrate on bell (Android). Docs: [layout.md](../40-frontend/layout.md). Real-device gestures go in the manual checklist.

Since m17, links open or copy with a tap and programs can copy with OSC 52 (claude's `/copy`), so selection is for the rest: a path, an error line, a block of output. **Replanned 2026-11-07 from a spike** (Pixel 5, headless Chromium): letting the browser select xterm's DOM rows natively gives real spaces (no NBSP) and correct CJK, but every row boundary becomes a newline, soft wraps included, so a wrapped command or URL copies broken; and only the rows on screen exist in the DOM, so nothing above the viewport can be selected. Drawing our own handles over the grid would fix neither cheaply. The plan is a **copy view** instead: a visible entry (a tile in the combo-key menu, [ADR-0054](../20-architecture/adr/0054-frequent-input-and-combo-keys.md)) opens the session's text, scrollback included and soft wraps joined (from xterm's buffer, the same logical lines as `term/links.ts`), in a native read-only text view scrolled to where the terminal was; the system's own selection handles, magnifier and Copy / Share menu do the rest; closing returns to the terminal unchanged. It is a tool you open and close, not a second reading surface ([ADR-0013](../20-architecture/adr/0013-terminal-only.md)), and needs its own ADR. "Select link" from the old plan is done (m17).

### v0.2 (no dates)

By value (scrollback is already solved by [ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md) §1 and ADR-0026):

1. **File browser + download**: done in m23 ([ADR-0059](../20-architecture/adr/0059-files.md), v0.7.0). Next on top of it: a folder as a zip, tapping a path in the terminal to open it, editing text files
2. **Passkey / WebAuthn**: closes the gap where adding a new device requires access to the server's terminal
3. **Split panes on desktop**

### v0.3+ candidates

- Lossless upgrades are done ([ADR-0016](../20-architecture/adr/0016-hot-reexec.md): in-place re-exec hands sessions over, `webterm reload`). Remaining candidate: split into a front process and a session host, so a front-end crash doesn't lose sessions
- **SSH jump host**: outbound SSH from the agent to machines without an agent (the layering in [ADR-0001](../20-architecture/adr/0001-agent-first-no-ssh.md))
- **Multiple users**: needs a data model migration
- **Local echo prediction** (mosh-style)

## What automation can't cover

Everything that can be verified mechanically is: Go unit and integration tests, frontend unit tests, and the E2E suite (including ★ byte-level continuity). The rest needs real devices; see the [manual checklist](../70-testing/manual-checklist.md):

| Item | Why it can't be automated |
|---|---|
| Real IME candidate window placement, choosing candidates during composition | Playwright can only dispatch composition events, not real IME behavior |
| Real on-screen keyboard opening and layout | Headless browsers have no on-screen keyboard; only `visualViewport` changes can be simulated |
| Real network switches (Wi-Fi ↔ 4G ↔ tunnel) | Route interception and CDP emulation aren't real links |
| Real Let's Encrypt issuance | CI can only use a fake CA; hitting the real one runs into rate limits |
| Installing the PWA on a real device, haptic feedback | Needs real hardware |

**A release isn't done until these have been run.** Run the checklist again before every release.
