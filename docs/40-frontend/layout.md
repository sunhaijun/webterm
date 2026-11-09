# Layout

> Status: Accepted. Decisions: [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) (Termux-style UI) and [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) (output path).
>
> Supported devices and per-device goals: [`../10-requirements/devices-and-layout.md`](../10-requirements/devices-and-layout.md). This document defines the implementation.

## Form (AC-5.18)

The UI has exactly two **forms**, set on `.app[data-form]`:

| Form | Devices | Rule |
|---|---|---|
| `compact` | Phones (portrait or landscape) | `min(screen.width, screen.height) < 600` |
| `wide` | PCs, tablets | Everything else |

- **The rule uses the screen's short side, not the viewport.** Screen size doesn't change with the on-screen keyboard, rotation, address bar, or split view, so a device's form **never changes**. With a viewport rule, in browsers that shrink the layout viewport for the keyboard (`resizes-content`), a landscape tablet would flip to `compact` whenever the keyboard opened: the tab bar would vanish and reappear, the terminal would reflow, and the PTY would get a SIGWINCH each time.
- Phone short sides top out around 440px; tablets start around 600px (iPad mini is 744px). 600 sits in the gap.
- The form is **computed once at page load** and never again. Moving a window to another monitor is rare enough that a refresh is fine; in exchange, no viewport change (keyboard, rotation, split view, or Playwright changing `screen` along with the viewport) can flip the form.
- The two forms differ **only in how you switch sessions** ([session-ux.md](session-ux.md)). Terminal, extra keys, text page, and gestures are identical.

Orthogonal to form is **touch capability**, from `matchMedia('(pointer: coarse)')`. It decides whether `wide` shows the extra keys, and sets touch target sizes (40px tab bar, 16px gap before `+`, etc.). Sheets follow the form, **not** the pointer type (see [Sheets](#sheets)).

## Geometry

```
compact (phone)                             wide (PC / tablet)
┌──────────────────────────────────┐        ┌[1] webterm ✕│[2] api •│[3] logs│ + ▢ ⌇ ● ⚙┐ tab bar 36px (touch: 40px)
│                                  │        │                                          │
│             terminal             │        │                 terminal                 │
│                                  │        │                                          │
├────┬─────────────────────────────┤        ├────┬─────────────────────────────────────┤
│ [3]│ ESC  /   -  HOME  ↑  END PGUP│        │    │ ESC   /    -   HOME   ↑   END  PGUP  │ extra keys 2 × 40px
│ ✎  │ TAB CTRL ALT  ←   ↓   →  PGDN│        │ ✎  │ TAB  CTRL ALT   ←    ↓    →   PGDN  │ (wide: touch only)
└────┴─────────────────────────────┘        └────┴─────────────────────────────────────┘
```

`[3]` is the session button: a rounded box with the session count in it ([session-ux.md](session-ux.md#compact-phone-session-button-and-bottom-drawer)). `▢` stands for the folder that opens the file browser ([ADR-0059](../20-architecture/adr/0059-files.md)) and `⌇` for the paperclip that sends files ([ADR-0051](../20-architecture/adr/0051-send-files-to-a-session.md)).

The text page uses the same slot. The text box takes the whole width right of the left column; the paperclip floats over its bottom-right corner ([input.md](input.md#the-textarea)):

```
text page (both forms)
├────┬───────────────────────────────────┤
│ [3]│ ┌───────────────────────────────┐ │
│    │ │ text box (2 rows)             │ │
│ ✎  │ │                             ⌇ │ │  text-upload-file, over the box
│    │ └───────────────────────────────┘ │
└────┴───────────────────────────────────┘
```

`.app` is a single-column grid:

| Row | compact | wide |
|---|---|---|
| Tab bar | None | 36px; 40px with `pointer: coarse` |
| Terminal | All remaining space | All remaining space |
| Extra keys | 80px, or 0 when collapsed | 80px, only with `pointer: coarse`; 0 when collapsed |

- **No title bar, no status bar.** Connection status, notices, and sheets all **float over the terminal** and take no grid row (see [Floating over the terminal](#floating-over-the-terminal)).
- The extra-keys area is a fixed 80px slot. The keys page and the text page both live in it, so switching doesn't change its height or reflow the terminal ([input.md](input.md)). The fixed left column is 44px: on `compact` the session button (top) and ✎ (bottom); on `wide` only ✎ (spanning both rows).
- **Only four things change terminal geometry at runtime**: visual viewport changes (on-screen keyboard, rotation, window resize), font size changes ([Terminal size](#terminal-size-ac-53)), `pointer: coarse` changes (plugging a mouse into a tablet or unplugging it, which shows or hides the extra keys), and collapsing or restoring the extra keys ([input.md](input.md#collapsing-the-extra-keys-ac-326), [ADR-0056](../20-architecture/adr/0056-collapsible-extra-keys.md)). Collapsed, the bar leaves the grid and a restore button floats in the bottom-right corner. Switching sessions, opening or closing sheets, changing the theme, and reconnecting don't.

### Floating over the terminal

All absolutely positioned or `position: fixed`, outside the grid; showing or hiding them never changes terminal geometry or sends `resize`:

| Element | Position | When |
|---|---|---|
| Connection banner (`conn-text`, `conn-note`) | Top of the terminal, one line tall | When not online, and for 3 seconds with a connection note ([session-ux.md](session-ux.md), [ADR-0049](../20-architecture/adr/0049-connection-status-in-one-place.md)) |
| Toast | Top center of the terminal | Messages unrelated to the connection (session limit, input too large, agent notices) |
| Composition preview (`ime-preview`) | At the terminal cursor | During IME composition in direct input |
| Drop outline (`.stage[data-drop="true"]`) | A 2px accent outline inside the terminal area | While files are dragged over the page ([input.md](input.md#sending-files-ac-323)); while the file browser is open its top sheet gets the outline instead, and the files go into its folder ([ADR-0059](../20-architecture/adr/0059-files.md) §5) |
| Session drawer (phone), settings, session menu, file browser | See [Sheets](#sheets) | When open |

### Safe area

`index.html` uses `viewport-fit=cover` + `black-translucent`, so a full-screen PWA extends under the notch and the home indicator. All four `env(safe-area-inset-*)` are **absorbed by `.app`'s padding** (`box-sizing: border-box`: the height JS sets is the whole visual viewport, and the content area shrinks accordingly).

- They're exposed as custom properties `--sa-top/right/bottom/left` for two reasons: E2E can override them in Chromium, which has no real notch, to verify geometry; and when the on-screen keyboard opens, JS sets `--sa-bottom` to 0 — the keyboard already covers the home indicator, so keeping 34px would be wasted space.
- Things inside `.app` **must not add `env()` again**, or the inset doubles. Only `position: fixed` elements (sheets, toasts) add their own.

## Height (AC-3.8)

**The single source of truth is `visualViewport.height`**, not `100vh` (on iOS Safari `100vh` ignores the keyboard).

```
app height      = visualViewport.height
terminal height = app height − safe area top/bottom (bottom counts as 0 while the keyboard is up)
                  − tab bar (wide) − extra keys (when shown)
```

Order: `visualViewport` changes → recompute the container → layout settles → `ResizeObserver` notifies the terminal → recompute rows and columns (`fit()`, see [Terminal size](#terminal-size-ac-53)) → send `resize` (100ms debounce).

**Don't call `fit()` directly from `visualViewport` events**: layout hasn't settled yet and the row/column count comes out wrong. Let a `ResizeObserver` on the terminal container trigger it.

The extra keys are the last grid row and the container tracks the visual viewport, so when the on-screen keyboard opens the extra keys **sit right on top of it**, and the terminal shrinks instead of being covered.

### translateY compensation while the keyboard is up

iOS Safari (and Chrome ≥108 with `resizes-visual`) shrink only the **visual viewport** for the keyboard, not the layout viewport, and **scroll the visible area up** (`visualViewport.offsetTop` > 0) to reveal the focused input. `.app` must follow with `translateY(offsetTop)`, or the whole app stays at the top of the layout and gets pushed out of view. The gate looks at only two numbers, and the reference must be the layout viewport:

```
keyboard up := visualViewport.height < documentElement.clientHeight − 80
```

- **The reference is `documentElement.clientHeight`, not `window.innerHeight`**: Safari's `innerHeight` reports the visual viewport height (it shrinks with pinch zoom and with the keyboard). Using it, the gate never opens on iPhone → no compensation → the input control vanishes as soon as you tap it. `clientHeight` is the layout viewport height in every browser.
- **While the gate is closed, don't follow `offsetTop`**: the address bar sliding in and out (both heights change together) and edge bounce (`offsetTop` changes, height doesn't) must not move `.app`, or a drag sets off a jitter feedback loop.
- In browsers that shrink the layout viewport too (`resizes-content`), both heights change together and `offsetTop` is 0, so the gate stays closed and `.app` just follows `visualViewport.height`.
- Page and container both use `overscroll-behavior: none` and don't scroll, so iOS doesn't scroll the page on its own when an input gets focus.
- Focusable controls on touch devices (the text page `textarea`, xterm's hidden textarea) use a **font size ≥ 16px**: iOS zooms in and pans the page sideways when focusing an input under 16px, and `translateY` can't undo a horizontal pan.

## Terminal size (AC-5.3)

`term/terminal.ts` computes rows and columns itself ([ADR-0033](../20-architecture/adr/0033-own-fit.md), no `FitAddon`): available size (parent width/height minus the `.xterm` padding, and minus the scrollbar for width) ÷ cell size, rounded down, minimum 2 columns × 1 row. **Cell size is `dimensions.device.cell / dpr`**, not `css.cell`: the latter is "rounded row width ÷ current column count", so it changes with the current column count, and dividing by it makes some widths flip between N and N−1 on every fit (even a height-only change alters the column count, and the agent resends a snapshot).

- Default font size is **14px** in both forms. That gives about 45 columns on a portrait phone, a deliberate trade: readability over wide output. Settings allow 10–24px, stored in `localStorage['webterm.fontSize']` — **one value, not per form** (a device's form never changes, [ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md) §1).
- Container size changes (`ResizeObserver`) → `fit()` → debounced `resize`.
- **After a font size change**: switch all xterm instances → `fit()` the mounted one → **send an extra `resize`**. The cell size changed but the container didn't, so `ResizeObserver` doesn't fire, and container-size dedup would swallow the measurement too; missing it leaves the client and the PTY with different cols/rows. Unmounted instances `fit()` as usual when switched to.
- **When the column count changes, the agent resends a snapshot** ([ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §4): the two sides would reflow differently, and the agent's result wins. The browser resets and redraws, and the scrollback position returns to the bottom. Row-only changes (on-screen keyboard) don't trigger this.

## Sheets

The session drawer (phone), settings, close confirmation ([ADR-0038](../20-architecture/adr/0038-close-confirm-sheet.md)), sign-out confirmation ([ADR-0048](../20-architecture/adr/0048-sign-out.md)), rename (phone, [ADR-0039](../20-architecture/adr/0039-drawer-row-swipe-actions.md)), the command editor ([ADR-0057](../20-architecture/adr/0057-command-strip-and-history.md)), and the file browser's sheets: the list, a file, the name sheet and delete confirmation ([ADR-0059](../20-architecture/adr/0059-files.md)). They share the `Drawer` primitive (`web/src/ui/drawer.tsx`, [ADR-0018](../20-architecture/adr/0018-one-drawer-primitive.md)), and **their shape follows the form** (`compact` / `wide`), not `pointer` ([ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md) §4):

| | `compact` (phone) | `wide` (PC / tablet) |
|---|---|---|
| Position | Bottom, full width | Centered dialog, width `min(420px, 100vw − 32px)` |
| Corner radius | 16px at the top | 14px |
| Enter animation | `sheet-up`, ~170ms (none with `prefers-reduced-motion`) | None |
| Grab handle | Yes (36×4) | No |
| Swipe down to close | Yes (once the body is scrolled to the top; release after > 90px) | — |
| Used by | Session drawer, settings, close and sign-out confirmation, rename, the file browser | Settings, close and sign-out confirmation, the file browser |

```
┌─────────────── ═══ ───────────────┐  grab handle (bottom sheet only)
│ Sessions                        ✕ │  header: title · close
├───────────────────────────────────┤
│ …                                 │  body: the only scrolling area (.drawer-body)
│                                   │  session drawer: all extra height goes here
├───────────────────────────────────┤
│  ┌──────────────────────┐ ┌────┐  │  bottom row (optional): top 12 · sides 16
│  │    + New session     │ │ ⚙  │  │  buttons 48px tall, radius 12, 12 apart
│  └──────────────────────┘ └────┘  │
│                                   │  bottom max(16px, safe area)
└───────────────────────────────────┘
```

- **Track the visible area** ([ADR-0039](../20-architecture/adr/0039-drawer-row-swipe-actions.md) §3): `.app` has `contain: layout`, which makes it the containing block for `position: fixed` descendants. `.app` already tracks `visualViewport` (height, plus `translateY` while the keyboard is up), so the backdrop covers exactly the visible area and the sheet's bottom edge is the keyboard's top edge. Without this, Android shrinks only the visual viewport for the keyboard, and a sheet pinned to the bottom of the layout viewport ends up entirely behind the keyboard.
- **Height**: a percentage of the backdrop (the visible area), not `vh`: at most 80%, growing with content. **The session drawer is at least 50%** (the iOS "medium" sheet detent), so a short list doesn't leave a sliver; extra height goes to the list, and the bottom row stays at the bottom of the sheet. Settings has only a few rows and no minimum height. **The file list and a file are always 80%** on `compact` (`min(80%, 720px)` tall and `min(720px, 100vw − 32px)` wide on `wide`), so a file covers the list exactly and the list doesn't jump between folders ([ADR-0059](../20-architecture/adr/0059-files.md) §1). On `wide` they can be maximized to the whole visible area, with a button left of ✕ or a double-click on the header, remembered per device ([ADR-0060](../20-architecture/adr/0060-files-maximize-and-markdown.md) §1). In a text or Markdown file the size line (size, time and the file's buttons) sticks to the top of the sheet while the file scrolls ([ADR-0061](../20-architecture/adr/0061-markdown-text-size.md) §2).
- **Breathing room at the bottom**: the bottom row is padded 12px top, 16px on the sides, and `max(16px, var(--sa-bottom))` at the bottom; sheets without a bottom row leave the same `max(16px, var(--sa-bottom))` under the body. `--sa-bottom` is `.app`'s safe-area variable, set to 0 while the keyboard is up (the keyboard covers the home indicator, so no extra gap is needed). Buttons don't stretch edge to edge; they're blocks with a `--surface` background, a thin `--line` border, and a 12px radius.
- **Closing**: tap the backdrop, `Esc`, ✕, or (bottom sheets) swipe down. The session drawer also closes when you pick a session and on the system back button ([session-ux.md](session-ux.md)). Settings doesn't handle the back button (ADR-0037 §4). The file browser's sheets all do, and Back closes only the top one: each pushes an entry, and the ones closed any other way are removed together with one `history.go(-n)` ([ADR-0059](../20-architecture/adr/0059-files.md) §1).
- **Focus moves into the sheet when it opens** (modal), so keyboard and screen reader users aren't left on the layer behind it, and `Esc` has a definite target.
- **Sheets stack**: close confirmation and rename can stack on top of the session drawer. `Esc` closes only the top one (the last `.drawer` in the DOM), and only the top backdrop receives taps.
- **Sheets don't change terminal geometry**: `position: fixed`, no `resize`.
- **`position: fixed` sheets handle the bottom safe area themselves** (`.app`'s padding doesn't reach them); see the bottom padding above.

## Settings (AC-5.3)

Just two items ([ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md)), plus one action at the bottom: sign out ([ADR-0048](../20-architecture/adr/0048-sign-out.md)). Changes apply immediately; no Save button, no explanatory text.

```
┌─────────────── ═══ ───────────────┐
│ Settings                        ✕ │
├───────────────────────────────────┤
│ Theme   ┌────────┬───────┬──────┐ │  segmented control; selected one in accent color
│         │ System │ Light │ Dark │ │
│         └────────┴───────┴──────┘ │
│ Font size        ( − )  14  ( + ) │  10–24; the button at the limit is grayed out
├───────────────────────────────────┤
│ Sign out this device              │  danger color; asks for confirmation first
│                                   │  bottom max(16px, safe area)
└───────────────────────────────────┘
```

| Element | testid | Notes |
|---|---|---|
| Sheet | `settings` | Bottom sheet on `compact`, centered dialog on `wide` |
| Theme | `theme-system` / `theme-light` / `theme-dark` | `role="radio"`; the selected one has `aria-checked="true"` |
| Font size | `font-dec` / `font-size` / `font-inc` | `font-size` shows the current value; at 10 / 24 the corresponding button is `disabled` |
| Sign out | `sign-out` | Closes settings and opens the confirmation sheet `sign-out-confirm` (`sign-out-cancel` / `sign-out-ok`, focus on Sign out, `Esc` cancels). Offline: a toast instead, nothing sent |

- Entry point: on `wide` the ⚙ at the far right of the tab bar; on `compact` the ⚙ at the bottom of the session drawer. Both have testid `open-settings`. No shortcut (`Ctrl+Shift+,` goes to the terminal).
- Font size has no number input: on phones that would pop up a numeric keyboard.
- After closing settings: if focus was in the terminal (or the text page) before opening, or the device has no touch, focus goes back; otherwise it stays put, so touch devices don't pop up the on-screen keyboard.

The `wide` session menu (Rename · Pin · Close, from right-click or long-press on a tab) isn't a sheet; it's a small menu anchored next to where it was triggered. Click outside or press `Esc` to close it.

## Theme

CSS custom properties + `prefers-color-scheme`, three states: system (default) / light / dark, chosen in settings and stored in `localStorage['webterm.theme']` ([ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md)).

```css
:root { /* light is the base; every color is defined here */ }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* overrides */ } }
:root[data-theme="dark"] { /* the same overrides, so a manual choice works in both directions */ }
:root[data-theme="light"] { color-scheme: light }   /* scrollbars and native controls follow */
:root[data-theme="dark"]  { color-scheme: dark }
```

- Light / dark: `<html data-theme="light|dark">`; system: remove the attribute.
- **Applied before the first render** (in `main.tsx`, before `render`), including on the pairing and gate pages, so there's no flash of the other theme.
- xterm's theme (foreground / background / 16 colors) is read from the same CSS variables. On a theme change, and when the system switches between light and dark (`change` on `matchMedia('(prefers-color-scheme: dark)')`), it's read again and every instance's `terminal.options.theme` is updated, without a reload.

The accent color is `--accent` (`var(--link)` on `:root`, so it follows the theme). **It means "this is the selected one"**: the current tab, the current session in the drawer (AC-4.9). Hover uses a neutral gray (`--fg` mixed at low opacity): selected and hover must differ in **hue**, because lightness alone can't tell them apart. Armed and locked CTRL / ALT also use `--accent`.

## Fonts

**UI chrome uses a proportional font; the terminal and input use monospace.** `body` defaults to `--font-ui`; the text page, extra keys, and the CWD in the drawer explicitly switch back to `--font-mono`. xterm uses monospace itself (`term/terminal.ts`).

```css
--font-ui:
  -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
  Arial, "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif;
--font-mono:
  ui-monospace, "SF Mono", "Cascadia Mono", "Menlo", "Consolas",
  "Liberation Mono", "Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace;
```

No bundled webfonts (size + flash on first paint). The stack must include a CJK monospace fallback to keep CJK aligned. xterm's `unicode11` addon is enabled so CJK and emoji widths are computed correctly.

The terminal uses this `--font-mono` stack (`term/terminal.ts` keeps an identical copy of the string for xterm) and it isn't configurable; the default size is 14px, see [Terminal size](#terminal-size-ac-53).

## Icons

All hand-drawn icons in the UI use one style ([ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md) §3): **inline SVG, stroke only, no fill, `stroke="currentColor"`, 1.75px stroke, round caps and joins**, colored by the button (normally `--muted`, `--fg` on hover). Used for: `+` and ⚙ (a six-tooth gear with a center hole) in the tab bar and at the bottom of the session drawer; `−` / `+` for font size in settings; the drag handle on drawer rows (three horizontal lines); ✕ on tabs and sheet headers; the pin icon on pinned sessions and the check mark in the session menu ([ADR-0042](../20-architecture/adr/0042-red-means-error-and-line-icons.md) §2); the text page button ✎ (`toggle-text`) in the extra keys' left column; the paperclip that sends files, in the tab bar (`upload-file`) and on the text page (`text-upload-file`) ([ADR-0051](../20-architecture/adr/0051-send-files-to-a-session.md)); the file browser's folder (`open-files`, in the tab bar and the session drawer), file, upload, new folder, terminal (`>_`) and up (`‹`) icons ([ADR-0059](../20-architecture/adr/0059-files.md)).

Two sizes: in the top bar, drawer, and settings, a **14×14 box with a 1.75px stroke**, scaled per position (12px for the tab ✕ and the pin, 16px for the sheet header ✕); in the extra keys' left column and on the text page, **22×22 with a 2px stroke**, the same size and weight as the session button's box next to it (22px, 2px border). The paperclip comes in both: 14×14 in the tab bar next to `+` and ⚙, 22×22 in the text box's corner on the text page, drawn separately for each so the stroke is 1.75px and 2px rather than one drawing scaled. ✎ is a rounded box with its top-right corner missing and a pencil coming diagonally out of the gap toward the top right ([ADR-0041](../20-architecture/adr/0041-tab-index-and-edit-icon.md) §2). The paperclip is one stroke: a long loop, a shorter loop nested inside it, leaning 45° like the pencil. Don't use Unicode symbols as icons: glyphs like `⚙` look different on each platform, some render as color emoji, and their vertical position shifts with font metrics.

## Rendering (ADR-0026 §7)

**Native first; optimize only after measuring** ([ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §7). The browser does three things:

```
per session: one TextDecoder('utf-8') (stream mode)
OUTPUT frame   → term.write(decoder.decode(payload, {stream: true}))
SNAPSHOT frame → decoder = new TextDecoder(); term.write('\x1bc' + decode(snapshot))   // RIS resets in-stream
```

- **Reset with RIS (`ESC c`) in the write stream, not `term.reset()`**: `reset()` is synchronous and doesn't clear the write buffer. When the column count changes the agent resends a snapshot right away, and old output that hasn't been parsed yet would be drawn after the reset but before the snapshot. RIS enters the write buffer together with the snapshot, so the order is automatically right (xterm's own comment on `reset()` recommends RIS for this case).
- **Decode to a string before writing.** When writing a `Uint8Array` directly, xterm.js (5.5 and 6.0) drops characters for some splits: a three-byte character whose second byte is `0x80` (`。` `…` `—` `“` `”` `、`, etc.) is lost entirely when the split falls right after its second byte. PTY read boundaries are arbitrary, so CJK output would occasionally lose punctuation.
- **Use xterm's default DOM renderer**; no WebGL.
- **Touch scrolling is xterm's own**; no custom per-frame landing or inertia. Exception: when the foreground program enables mouse tracking xterm ignores touch, so webterm turns vertical drags into wheel events for the program ([input.md](input.md#vertical-drag-ac-321), ADR-0029).
- **No scrollback pause, no per-frame batching, no write budget.** xterm's write buffer parses in ~12ms slices, yields the main thread between them, and renders at most once per frame.
- `scrollback: 5000` (AC-5.1). How far back you can scroll after a refresh, a long disconnect, or a long time away from a session is set by the agent's snapshot (2000 lines, AC-5.14).
- New output doesn't break a selection (AC-5.4): xterm tracks selections in buffer coordinates, so scrolling output doesn't affect them.

All of these omissions are deliberate. To add any of them back, first measure the difference in main-thread long tasks with the E2E-37 baseline scenario (the dev machine has no GPU, so only main-thread milliseconds count), and put the data in an ADR.

## PWA

- `display: standalone`; `theme_color` follows the theme.
- The service worker **caches only the static shell** (HTML/JS/CSS), `stale-while-revalidate`; it **never caches terminal data or API responses**.
- Offline, show a clear "Can't reach the agent" page instead of pretending to work.
- When a new version is available, prompt "Update available · Reload"; never reload automatically (that would interrupt a running session).

## Accessibility

- Tap targets are at least 44×44px under `pointer: coarse`. **The extra keys are a deliberate exception**: rows are 40px (Termux uses 37.5dp), made up for by a width ≥ 48px.
- Connection status changes are announced with `aria-live="polite"`; while online, `conn-text` is only visually hidden, so screen readers still read it.
- The current session (tab, drawer row) has `aria-current="true"`.
- Honor `prefers-reduced-motion`: no sheet transitions, no scroll inertia.
