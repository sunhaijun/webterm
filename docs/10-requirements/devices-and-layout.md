# Devices and layout

> Status: Accepted

Supported devices and the target experience on each. UI decisions are in [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md); implementation in [`../40-frontend/layout.md`](../40-frontend/layout.md).

---

## Device priority

webterm's value is on mobile — on a desktop you already have a local terminal. Priority:

1. **Phone (portrait)** — highest. Commuting, quick fixes. Hardest to get right and the most valuable.
2. **Tablet** — next. Reasonable screen area, possibly an external keyboard.
3. **Desktop** — must be fully usable, but isn't where webterm differentiates.
4. **Phone (landscape)** — must work (wide output, logs), but input isn't optimized.

## Two forms

Modeled on Termux: one full-screen terminal with two fixed rows of extra keys below it, no title bar, no status bar. Devices fall into two **forms**, which **differ only in how you switch sessions**:

| Form | Devices | Rule | Session switching |
|---|---|---|---|
| `compact` | Phone (portrait and landscape) | Screen short side < 600px | Session button in the left column of the extra keys → bottom drawer |
| `wide` | Desktop, tablet | Screen short side ≥ 600px | Tab bar on top (like Termius) |

- The rule uses the **screen**'s short side, not the viewport, so a device never changes form: the on-screen keyboard, rotation and split screen never swap the UI.
- No UA sniffing. Touch is detected separately with `@media (pointer: coarse)`; it decides whether `wide` shows the extra keys. Sheets follow the form, not the pointer: a bottom sheet on `compact`, a centered dialog on `wide` ([ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md) §4).

## Per-device targets

### Phone, portrait (`compact`)

- **The terminal takes the full height except for the extra keys (80px).** No title bar, no status bar; the connection state is hidden normally, and a banner covers the top of the terminal when disconnected.
- The on-screen keyboard is handled with `visualViewport`: the terminal area shrinks instead of being covered, and the extra keys always sit right above the keyboard.
- Two rows, 14 extra keys, in fixed positions, all visible at `393px` width without horizontal scrolling.
- Long CJK text: switch the extra-keys area to the text page — a native text box with the IME candidate window in the right place.
- Switching sessions: the session button (a box showing the session count) opens the bottom drawer; two taps. A session that's waiting for you (its program finished or asks for something) puts a dot on the button.
- Default font size 14px (about 45 columns): **readability over fitting wide output**. Adjustable in settings (10–24px).
- Respect `env(safe-area-inset-*)` (notch, Home indicator); in an Android PWA the system Back button closes the drawer first instead of exiting the app.

### Phone, landscape (`compact`)

- The same UI as portrait, with more columns and fewer rows.
- With the keyboard open only a few rows remain. Accepted (landscape input isn't optimized).

### Tablet (`wide`)

- Tab bar on top (40px): one tap to switch sessions, which ones are waiting for you visible at a glance.
- On touch, the same extra keys as on phones (wider keys); with a mouse (`pointer: fine`) the extra keys disappear, as on desktop.
- With an external keyboard, the app's shortcuts work ([`../40-frontend/keymap.md`](../40-frontend/keymap.md)).

### Desktop (`wide`)

- Tab bar on top (36px): switch, middle-click to close, double-click to rename, right-click for the session menu.
- No extra keys, no text page; the physical keyboard's IME types straight into the terminal.
- 100+ columns by default.

---

## Browser support

| Browser | Minimum version | Notes |
|---|---|---|
| Chrome / Edge | Last 2 major versions | Primary development target |
| Safari (iOS) | iOS 16+ | Primary mobile target; watch for `visualViewport` and 100vh differences |
| Safari (macOS) | 16+ | |
| Firefox | Last 2 major versions | |

Not supported: IE, old Android WebView (< Chrome 100).

Modern APIs we rely on (no polyfills): `visualViewport`, `ResizeObserver`, CSS `env()`, Clipboard API, Service Worker, History API.

---

## PWA

- `display: standalone`, no address bar.
- Icon and theme color follow the system light/dark setting.
- The Service Worker **caches only the static shell** (HTML/JS/CSS/fonts), never any terminal data.
- Offline shows a clear "can't reach the agent" state instead of pretending to work.

## Fonts

- Prefer the system's built-in monospace fonts; don't bundle webfonts (size and first paint).
- Must include a CJK monospace fallback so wide characters align.
- Enable xterm's `unicode11` addon for correct CJK and emoji widths.
